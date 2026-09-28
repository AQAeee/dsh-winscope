/**
 * The five `winscope_*` AI tools. Each tool forwards a WinScope cross-tool
 * message to a sidebar panel through the browser bridge and returns the
 * WinScope response as JSON.
 */

import type {Context} from '@deepseek-ai/cordis';
import {defineTool, type JsonValue, type ToolDefinition} from '@deepseek-ai/dsh-tools';
import type {ContentBlock} from '@deepseek-ai/dsh-llm';
import type {Bridge} from './bridge';
import {BridgeResponse, CrossToolMessage, MsgType, WinscopePanel} from './shared';
import type {Config} from './index';

const PANEL_PARAMETER = {
  type: 'string' as const,
  enum: ['A', 'B'] as const,
  required: true as const,
  description:
    'Which sidebar WinScope panel to talk to: "A" (primary device) or "B" (comparison device).',
};

const TRACE_TYPE_PARAMETER = {
  type: 'string' as const,
  required: true as const,
  description:
    'Trace type identifier as reported by winscope_list_traces, e.g. "SURFACE_FLINGER", "WINDOW_MANAGER", "VIEW_CAPTURE", "TRANSACTIONS".',
};

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{type: 'text', text: JSON.stringify(value, null, 2)}];
}

/** Forward one cross-tool message to a panel and return the response. */
async function callPanel(
  bridge: Bridge,
  config: Config,
  panel: WinscopePanel,
  message: CrossToolMessage,
): Promise<JsonValue> {
  if (!bridge.isPanelOnline(panel)) {
    throw new Error(
      `WinScope panel ${panel} is not online. Open the "WinScope ${panel}" tab in ` +
        `the right sidebar (via its "+" menu) and wait for the page to load.`,
    );
  }
  const response: BridgeResponse = await bridge.request(
    panel,
    message,
    config.toolTimeoutMs,
  );
  if (!response.ok) {
    throw new Error(response.error ?? 'unknown bridge error');
  }
  return response.result as unknown as JsonValue;
}

/** Build all winscope tool definitions. */
function makeTools(bridge: Bridge, config: Config): ToolDefinition[] {
  const jsonOutput = {
    schema: {type: 'json' as const},
    render: renderJson,
  };

  return [
    defineTool({
      name: 'winscope_list_traces',
      description:
        'List the traces currently loaded in a WinScope sidebar panel: trace types (e.g. ' +
        'SURFACE_FLINGER, WINDOW_MANAGER), source file names, entry counts, first/last entry ' +
        'timestamps in ns, and whether each is a dump. Call this first to discover what the ' +
        'user uploaded and the valid time range of each trace.',
      parameters: {
        panel: PANEL_PARAMETER,
      },
      output: jsonOutput,
      execute: async (args: {panel: WinscopePanel}) => {
        return callPanel(bridge, config, args.panel, {
          type: MsgType.GET_TRACE_INFO,
          requestId: 'list_traces',
        });
      },
    }),
    defineTool({
      name: 'winscope_get_position',
      description:
        'Read the currently selected timeline position of a WinScope panel: the timestamp in ns ' +
        '(string) plus a human-readable time. Use it to know which moment the user is inspecting.',
      parameters: {
        panel: PANEL_PARAMETER,
      },
      output: jsonOutput,
      execute: async (args: {panel: WinscopePanel}) => {
        return callPanel(bridge, config, args.panel, {
          type: MsgType.GET_POSITION,
          requestId: 'get_position',
        });
      },
    }),
    defineTool({
      name: 'winscope_get_hierarchy',
      description:
        'Read the window/layer hierarchy tree (or the property tree for non-hierarchy traces ' +
        'like TRANSACTIONS or PROTO_LOG) of one WinScope panel at a given time. Without ' +
        'timestamp_ns it returns the currently selected position. The hierarchy response is a ' +
        'skeleton (id/name/childCount); fetch details of a node with winscope_get_properties.',
      parameters: {
        panel: PANEL_PARAMETER,
        trace_type: TRACE_TYPE_PARAMETER,
        timestamp_ns: {
          type: 'string',
          description:
            'Optional timestamp in nanoseconds (WinScope internal time domain, as returned by ' +
            'the other winscope tools). Defaults to the currently selected position.',
        },
      },
      output: jsonOutput,
      execute: async (args: {panel: WinscopePanel; trace_type: string; timestamp_ns?: string}) => {
        const message: CrossToolMessage = {
          type: MsgType.GET_HIERARCHY,
          requestId: 'get_hierarchy',
          traceType: args.trace_type,
        };
        if (args.timestamp_ns !== undefined) {
          message.timestampNs = args.timestamp_ns;
        }
        return callPanel(bridge, config, args.panel, message);
      },
    }),
    defineTool({
      name: 'winscope_get_hierarchy_range',
      description:
        'Read a series of hierarchy/property snapshots of one WinScope panel over a time range. ' +
        'Returns one skeleton (id/name/childCount) per sampled timestamp in ascending order. ' +
        'Bound the range with start_ns/end_ns (inclusive); omit them to span the whole trace. ' +
        'limit caps the number of returned snapshots (evenly sampled when the range has more entries).',
      parameters: {
        panel: PANEL_PARAMETER,
        trace_type: TRACE_TYPE_PARAMETER,
        start_ns: {
          type: 'string',
          description:
            'Optional range start timestamp in nanoseconds (inclusive). Defaults to the first entry.',
        },
        end_ns: {
          type: 'string',
          description:
            'Optional range end timestamp in nanoseconds (inclusive). Defaults to the last entry.',
        },
        limit: {
          type: 'number',
          description: 'Optional max snapshots to return (default 200, max 1000).',
        },
      },
      output: jsonOutput,
      execute: async (args: {
        panel: WinscopePanel;
        trace_type: string;
        start_ns?: string;
        end_ns?: string;
        limit?: number;
      }) => {
        const message: CrossToolMessage = {
          type: MsgType.GET_HIERARCHY_RANGE,
          requestId: 'get_hierarchy_range',
          traceType: args.trace_type,
        };
        if (args.start_ns !== undefined) {
          message.startNs = args.start_ns;
        }
        if (args.end_ns !== undefined) {
          message.endNs = args.end_ns;
        }
        if (args.limit !== undefined) {
          message.limit = args.limit;
        }
        return callPanel(bridge, config, args.panel, message);
      },
    }),
    defineTool({
      name: 'winscope_get_property_timeline',
      description:
        'Track the value of one node property over a time range in a WinScope panel. ' +
        'Returns a series of { timestampNs, present, value } points in ascending order. ' +
        'node_id comes from winscope_get_hierarchy; node_name is an optional fallback used when ' +
        'the node id is not stable across snapshots. Missing points are marked present: false.',
      parameters: {
        panel: PANEL_PARAMETER,
        trace_type: TRACE_TYPE_PARAMETER,
        node_id: {
          type: 'string',
          required: true,
          description: 'Node id from the winscope_get_hierarchy skeleton tree.',
        },
        property: {
          type: 'string',
          required: true,
          description: 'Property name to track, e.g. "visibleRegion", "color", "flags".',
        },
        node_name: {
          type: 'string',
          description:
            'Strongly recommended for SURFACE_FLINGER: fallback node name used when the id is not found in a snapshot.',
        },
        start_ns: {
          type: 'string',
          description: 'Optional range start timestamp in nanoseconds (inclusive).',
        },
        end_ns: {
          type: 'string',
          description: 'Optional range end timestamp in nanoseconds (inclusive).',
        },
        limit: {
          type: 'number',
          description: 'Optional max points to return (default 100, max 500).',
        },
      },
      output: jsonOutput,
      execute: async (args: {
        panel: WinscopePanel;
        trace_type: string;
        node_id: string;
        property: string;
        node_name?: string;
        start_ns?: string;
        end_ns?: string;
        limit?: number;
      }) => {
        const message: CrossToolMessage = {
          type: MsgType.GET_PROPERTY_TIMELINE,
          requestId: 'get_property_timeline',
          traceType: args.trace_type,
          nodeId: args.node_id,
          property: args.property,
        };
        if (args.node_name !== undefined) {
          message.nodeName = args.node_name;
        }
        if (args.start_ns !== undefined) {
          message.startNs = args.start_ns;
        }
        if (args.end_ns !== undefined) {
          message.endNs = args.end_ns;
        }
        if (args.limit !== undefined) {
          message.limit = args.limit;
        }
        return callPanel(bridge, config, args.panel, message);
      },
    }),
    defineTool({
      name: 'winscope_get_node_timeline',
      description: 'Returns a timeline of properties for a node over a time range. For SURFACE_FLINGER traces the node id may be unstable across timestamps; always provide node_name as a fallback and prefer a narrow start_ns/end_ns window around the time the node is visible.',
      parameters: {
        panel: PANEL_PARAMETER,
        trace_type: TRACE_TYPE_PARAMETER,
        node_id: {
          type: 'string',
          required: true,
          description: 'Node id from the winscope_get_hierarchy skeleton tree.',
        },
        properties: {
          type: 'array',
          required: true,
          description:
            'Property names to collect at each timestamp, e.g. ["bounds", "visibleRegion", "flags"].',
        },
        node_name: {
          type: 'string',
          description:
            'Optional fallback: match the node by name when its id is not found in a snapshot.',
        },
        start_ns: {
          type: 'string',
          description: 'Optional range start timestamp in nanoseconds (inclusive).',
        },
        end_ns: {
          type: 'string',
          description: 'Optional range end timestamp in nanoseconds (inclusive).',
        },
        limit: {
          type: 'number',
          description: 'Optional max points to return (default 100, max 500).',
        },
      },
      output: jsonOutput,
      execute: async (args: {
        panel: WinscopePanel;
        trace_type: string;
        node_id: string;
        properties: string[];
        node_name?: string;
        start_ns?: string;
        end_ns?: string;
        limit?: number;
      }) => {
        const message: CrossToolMessage = {
          type: MsgType.GET_NODE_TIMELINE,
          requestId: 'get_node_timeline',
          traceType: args.trace_type,
          nodeId: args.node_id,
          properties: args.properties,
        };
        if (args.node_name !== undefined) {
          message.nodeName = args.node_name;
        }
        if (args.start_ns !== undefined) {
          message.startNs = args.start_ns;
        }
        if (args.end_ns !== undefined) {
          message.endNs = args.end_ns;
        }
        if (args.limit !== undefined) {
          message.limit = args.limit;
        }
        return callPanel(bridge, config, args.panel, message);
      },
    }),
    defineTool({
      name: 'winscope_get_properties',
      description:
        'Read the full property tree of one hierarchy node (window, layer, or view — id comes ' +
        'from winscope_get_hierarchy) at a given time in a WinScope panel. Without timestamp_ns ' +
        'it uses the currently selected position.',
      parameters: {
        panel: PANEL_PARAMETER,
        trace_type: TRACE_TYPE_PARAMETER,
        node_id: {
          type: 'string',
          required: true,
          description: 'Node id from the winscope_get_hierarchy skeleton tree.',
        },
        timestamp_ns: {
          type: 'string',
          description:
            'Optional timestamp in nanoseconds; defaults to the currently selected position.',
        },
      },
      output: jsonOutput,
      execute: async (args: {
        panel: WinscopePanel;
        trace_type: string;
        node_id: string;
        timestamp_ns?: string;
      }) => {
        const message: CrossToolMessage = {
          type: MsgType.GET_PROPERTIES,
          requestId: 'get_properties',
          traceType: args.trace_type,
          nodeId: args.node_id,
        };
        if (args.timestamp_ns !== undefined) {
          message.timestampNs = args.timestamp_ns;
        }
        return callPanel(bridge, config, args.panel, message);
      },
    }),
    defineTool({
      name: 'winscope_seek',
      description:
        'Move the timeline of a WinScope panel to the given timestamp (ns, WinScope internal ' +
        'time domain). The panel UI follows; use winscope_get_hierarchy afterwards to read the ' +
        'state at that moment.',
      parameters: {
        panel: PANEL_PARAMETER,
        timestamp_ns: {
          type: 'string',
          required: true,
          description: 'Target timestamp in nanoseconds.',
        },
      },
      output: jsonOutput,
      execute: async (args: {panel: WinscopePanel; timestamp_ns: string}) => {
        return callPanel(bridge, config, args.panel, {
          type: MsgType.SEEK,
          timestampNs: args.timestamp_ns,
        });
      },
    }),
  ];
}

/** Register all winscope tools against the tool registry; returns the disposer. */
export function registerWinscopeTools(
  ctx: Context,
  bridge: Bridge,
  config: Config,
): () => void {
  const disposers = makeTools(bridge, config).map((tool) => ctx.tools.register(tool));
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
