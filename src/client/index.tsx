/**
 * Client half of the dsh-winscope plugin: registers two WinScope tabs
 * ("WinScope A" / "WinScope B") with better-sidebar, embeds the WinScope
 * build served by the host half at /winscope, and runs the browser end of
 * the tool bridge (long-poll /winscope-bridge/poll, forward over
 * postMessage, respond /winscope-bridge/respond).
 *
 * Soft dependency on dsh-better-sidebar (omdsh-dev): its client half
 * publishes ctx.betterSidebar, a documented third-party extension surface
 * (registerTab / registerFileViewer). We restate the minimal contract here
 * instead of value-importing the package (build purity: no cross-plugin
 * value imports), so this bundle builds and loads whether or not
 * better-sidebar is installed; the tab registration no-ops when the service
 * is absent.
 */

import React, {useEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import type {Context} from '@deepseek-ai/cordis';
import {
  BridgePollResult,
  BridgeRequest,
  CrossToolMessage,
  MsgType,
  WinscopePanel,
} from '../shared';

/* ------------------------------------------------------------------ */
/* Minimal local typing for the betterSidebar service (optional peer). */
/* ------------------------------------------------------------------ */

interface TabComponentProps {
  visible: boolean;
}

interface BetterSidebarTabDescriptor {
  id: string;
  title: string | (() => string);
  icon?: unknown;
  order?: number;
  single?: boolean;
  component: (props: TabComponentProps) => ReactNode;
}

interface BetterSidebarService {
  registerTab(descriptor: BetterSidebarTabDescriptor): () => void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only when dsh-better-sidebar's client half is loaded. */
    readonly betterSidebar?: BetterSidebarService;
  }
}

/* ------------------------------------------------------------------ */
/* Panel registry: live iframes per panel.                            */
/* ------------------------------------------------------------------ */

interface PanelEntry {
  iframe: HTMLIFrameElement;
  ready: boolean;
  onReady: () => void;
  pingTimer: number | undefined;
}

const panels = new Map<WinscopePanel, PanelEntry>();

/** Resolvers for cross-tool responses keyed by requestId (= bridge id). */
const pendingResponses = new Map<string, (message: CrossToolMessage) => void>();

function postToPanel(panel: WinscopePanel, message: CrossToolMessage): void {
  const entry = panels.get(panel);
  if (!entry?.iframe.contentWindow) return;
  // Same-origin iframe (served by the same DSH webserver under /winscope).
  entry.iframe.contentWindow.postMessage(message, window.location.origin);
}

function ensureGlobalMessageListener(): void {
  if (ensureGlobalMessageListener.installed) return;
  ensureGlobalMessageListener.installed = true;
  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as CrossToolMessage | undefined;
    if (!message || typeof message.type !== 'number') return;

    for (const [panel, entry] of panels) {
      if (event.source !== entry.iframe.contentWindow) continue;

      if (message.type === MsgType.PONG) {
        if (!entry.ready) {
          entry.ready = true;
          if (entry.pingTimer !== undefined) {
            clearInterval(entry.pingTimer);
            entry.pingTimer = undefined;
          }
          entry.onReady();
        }
        return;
      }

      const requestId =
        typeof message.requestId === 'string' ? message.requestId : undefined;
      if (requestId !== undefined) {
        const resolve = pendingResponses.get(requestId);
        if (resolve) {
          pendingResponses.delete(requestId);
          resolve(message);
        }
      }
      return;
    }
  });
}
ensureGlobalMessageListener.installed = false;

function registerPanel(
  panel: WinscopePanel,
  iframe: HTMLIFrameElement,
  onReady: () => void,
): void {
  ensureGlobalMessageListener();
  const previous = panels.get(panel);
  if (previous?.pingTimer !== undefined) {
    clearInterval(previous.pingTimer);
  }
  const entry: PanelEntry = {iframe, ready: false, onReady, pingTimer: undefined};
  panels.set(panel, entry);

  // Ping until WinScope's cross-tool protocol answers with PONG. Angular
  // boot takes a while; onLoad alone is not proof the listener exists.
  iframe.addEventListener('load', () => {
    if (entry.pingTimer !== undefined) return;
    entry.pingTimer = window.setInterval(() => {
      if (entry.ready) return;
      postToPanel(panel, {type: MsgType.PING});
    }, 500);
  });
}

function unregisterPanel(panel: WinscopePanel, iframe: HTMLIFrameElement): void {
  const entry = panels.get(panel);
  if (!entry || entry.iframe !== iframe) return;
  if (entry.pingTimer !== undefined) clearInterval(entry.pingTimer);
  panels.delete(panel);
}

/* ------------------------------------------------------------------ */
/* Bridge poller.                                                     */
/* ------------------------------------------------------------------ */

let pollerRunning = false;

async function respondToHost(
  id: string,
  ok: boolean,
  result?: CrossToolMessage,
  error?: string,
): Promise<void> {
  try {
    await fetch('/winscope-bridge/respond', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({id, ok, result, error}),
    });
  } catch {
    // The host may be restarting; the request will time out on its side.
  }
}

async function handleBridgeRequest(request: BridgeRequest): Promise<void> {
  const entry = panels.get(request.panel);
  if (!entry) {
    await respondToHost(
      request.id,
      false,
      undefined,
      `Panel ${request.panel} is not mounted in this browser.`,
    );
    return;
  }
  if (!entry.ready) {
    await respondToHost(
      request.id,
      false,
      undefined,
      `WinScope ${request.panel} is still loading; retry in a moment.`,
    );
    return;
  }

  const message = {...request.message, requestId: request.id};
  const response = await new Promise<CrossToolMessage | undefined>((resolve) => {
    pendingResponses.set(request.id, resolve);
    // Safety net: never leave a resolver dangling.
    window.setTimeout(() => {
      if (pendingResponses.delete(request.id)) {
        resolve(undefined);
      }
    }, 25_000);
    postToPanel(request.panel, message);
  });

  if (response === undefined) {
    await respondToHost(
      request.id,
      false,
      undefined,
      `WinScope ${request.panel} did not answer (timed out waiting for postMessage).`,
    );
    return;
  }
  if (response.type === MsgType.ERROR) {
    await respondToHost(
      request.id,
      false,
      undefined,
      typeof response.message === 'string' ? response.message : 'WinScope error',
    );
    return;
  }
  await respondToHost(request.id, true, response);
}

async function sendHeartbeat(): Promise<void> {
  const online: WinscopePanel[] = [];
  for (const [panel, entry] of panels) {
    if (entry.ready) online.push(panel);
  }
  try {
    await fetch('/winscope-bridge/heartbeat', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({panels: online}),
    });
  } catch {
    // ignore — the next poll iteration retries
  }
}

function ensurePoller(): void {
  if (pollerRunning) return;
  pollerRunning = true;
  void (async () => {
    while (panels.size > 0) {
      try {
        await sendHeartbeat();
        const res = await fetch('/winscope-bridge/poll?waitMs=15000');
        if (!res.ok) throw new Error(`poll failed: ${res.status}`);
        const data = (await res.json()) as BridgePollResult;
        for (const request of data.requests ?? []) {
          void handleBridgeRequest(request);
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    pollerRunning = false;
  })();
}

/* ------------------------------------------------------------------ */
/* React components.                                                  */
/* ------------------------------------------------------------------ */

const panelStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: '#fff',
};

const badgeStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  color: '#555',
  borderBottom: '1px solid #e0e0e0',
  flexShrink: 0,
};

function WinscopeTabView(props: {panel: WinscopePanel; visible: boolean}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  // Fetch the proxy security token once (unauthenticated /winscope-proxy/config).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/winscope-proxy/config');
        if (res.ok) {
          const data = (await res.json()) as {token?: string};
          if (!cancelled && typeof data.token === 'string') setToken(data.token);
        }
      } catch {
        // host may be restarting; the tab still renders, proxy just stays offline
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Register the panel's iframe once it has a real (token-bearing) URL.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || token === null) return;
    registerPanel(props.panel, iframe, () => setReady(true));
    ensurePoller();
    return () => {
      setReady(false);
      unregisterPanel(props.panel, iframe);
    };
  }, [props.panel, token]);

  const src =
    token === null
      ? 'about:blank'
      : `/winscope/index.html?proxyUrl=/winscope-proxy&token=${encodeURIComponent(token)}`;

  return (
    <div style={panelStyle}>
      <div style={badgeStyle}>
        WinScope {props.panel} — {ready ? '已连接 (connected)' : '加载中 (loading)…'}
        {!ready && ' 等待 WinScope 启动，可在面板中上传/抓取 trace。'}
      </div>
      <iframe
        ref={iframeRef}
        src={src}
        title={`WinScope ${props.panel}`}
        style={{width: '100%', flex: 1, border: 'none'}}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Plugin entry.                                                      */
/* ------------------------------------------------------------------ */

/**
 * No static service inject: this bundle needs nothing beyond the platform
 * seed modules (react, cordis). betterSidebar stays out of the static
 * inject — on hosts without better-sidebar a missing service would leave
 * this plugin pending and take the whole web boot down. The tabs mount via
 * the service-landing event instead (the cordis dynamic pattern).
 */
export function apply(ctx: Context): void {
  // Soft integration with dsh-better-sidebar: register the two WinScope
  // tabs through a child fiber with its own injection. It activates
  // whenever the service lands and never blocks this plugin.
  void (
    ctx as unknown as {
      plugin: (plugin: {
        inject: string[];
        apply: (pluginCtx: Context) => void;
      }) => unknown;
    }
  ).plugin({
    inject: ['betterSidebar'],
    apply(sidebarCtx) {
      const sidebar = sidebarCtx.betterSidebar;
      if (!sidebar) return;

      const register = (panel: WinscopePanel, order: number): void => {
        ctx.effect(
          () =>
            sidebar.registerTab({
              id: `winscope:${panel.toLowerCase()}`,
              title: `WinScope ${panel}`,
              order,
              single: true,
              component: (props: TabComponentProps) => (
                <WinscopeTabView panel={panel} visible={props.visible} />
              ),
            }),
          `winscope: better-sidebar tab ${panel}`,
        );
      };

      register('A', 51);
      register('B', 52);
    },
  });
}
