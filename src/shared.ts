/**
 * Shared wire types between the host half (Node) and the browser client half
 * of the dsh-winscope plugin, plus the WinScope cross-tool message type ids
 * (mirroring winscope/src/cross_tool/messages.ts).
 */

/** Sidebar panel identity. Each panel hosts its own WinScope iframe. */
export type WinscopePanel = 'A' | 'B';

export const WINSCOPE_PANELS: readonly WinscopePanel[] = ['A', 'B'];

/** WinScope cross-tool message type ids (must match WinScope's enum). */
export const MsgType = {
  UNKNOWN: 0,
  PING: 1,
  PONG: 2,
  BUGREPORT: 3,
  TIMESTAMP: 4,
  FILES: 5,
  GET_TRACE_INFO: 6,
  TRACE_INFO: 7,
  GET_POSITION: 8,
  POSITION: 9,
  GET_HIERARCHY: 10,
  HIERARCHY: 11,
  GET_PROPERTIES: 12,
  PROPERTIES: 13,
  SEEK: 14,
  ERROR: 15,
  GET_HIERARCHY_RANGE: 16,
  HIERARCHY_RANGE: 17,
  GET_PROPERTY_TIMELINE: 18,
  PROPERTY_TIMELINE: 19,
  GET_NODE_TIMELINE: 20,
  NODE_TIMELINE: 21,
} as const;

/** A cross-tool postMessage payload as sent to / received from WinScope. */
export interface CrossToolMessage {
  type: number;
  [key: string]: unknown;
}

/** Host -> client bridge request: one cross-tool message for one panel. */
export interface BridgeRequest {
  id: string;
  panel: WinscopePanel;
  message: CrossToolMessage;
}

/** Client -> host bridge response for one request. */
export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: CrossToolMessage;
  error?: string;
}

/** Client -> host heartbeat: which panels currently have live iframes. */
export interface BridgeHeartbeat {
  panels: WinscopePanel[];
}

/** GET /winscope-bridge/poll response. */
export interface BridgePollResult {
  requests: BridgeRequest[];
}

export function isWinscopePanel(value: string): value is WinscopePanel {
  return value === 'A' || value === 'B';
}
