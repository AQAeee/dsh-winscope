/**
 * Host-side bridge between AI tools (Node) and the browser panels.
 *
 * A tool call enqueues a {@link BridgeRequest}; the browser client long-polls
 * `/winscope-bridge/poll`, forwards the message to the panel's WinScope
 * iframe over postMessage, and posts the WinScope response back to
 * `/winscope-bridge/respond`, which resolves the tool's promise.
 */

import {randomUUID} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {
  BridgeHeartbeat,
  BridgePollResult,
  BridgeRequest,
  BridgeResponse,
  CrossToolMessage,
  WinscopePanel,
} from './shared';

interface PendingRequest {
  request: BridgeRequest;
  resolve: (response: BridgeResponse) => void;
  timer: NodeJS.Timeout;
}

/** A panel is considered online when a heartbeat arrived within this window. */
const PANEL_ONLINE_MS = 30_000;

export class Bridge {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queue: PendingRequest[] = [];
  private readonly lastHeartbeat = new Map<WinscopePanel, number>();
  private waiters: Array<() => void> = [];

  /**
   * Enqueue one cross-tool message for a panel and await the browser's
   * response. Rejects (via resolve of an error response) on timeout.
   */
  request(
    panel: WinscopePanel,
    message: CrossToolMessage,
    timeoutMs: number,
  ): Promise<BridgeResponse> {
    const id = randomUUID();
    const request: BridgeRequest = {id, panel, message};
    return new Promise<BridgeResponse>((resolve) => {
      const settle = (response: BridgeResponse) => {
        this.pending.delete(id);
        const index = this.queue.indexOf(pending);
        if (index >= 0) this.queue.splice(index, 1);
        clearTimeout(pending.timer);
        resolve(response);
      };
      const pending: PendingRequest = {
        request,
        resolve: settle,
        timer: setTimeout(() => {
          settle({
            id,
            ok: false,
            error: `Timed out after ${timeoutMs}ms waiting for panel ${panel}. ` +
              `Make sure the WinScope ${panel} sidebar tab is open and a page reload has finished.`,
          });
        }, timeoutMs),
      };
      this.pending.set(id, pending);
      this.queue.push(pending);
      this.wakeWaiters();
    });
  }

  isPanelOnline(panel: WinscopePanel): boolean {
    const at = this.lastHeartbeat.get(panel);
    return at !== undefined && Date.now() - at < PANEL_ONLINE_MS;
  }

  noteHeartbeat(heartbeat: BridgeHeartbeat): void {
    for (const panel of heartbeat.panels) {
      this.lastHeartbeat.set(panel, Date.now());
    }
  }

  /** Drain queued requests (for the poll handler), waiting up to `waitMs`. */
  async drain(waitMs: number): Promise<BridgeRequest[]> {
    if (this.queue.length === 0 && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          remove();
          resolve();
        }, waitMs);
        const wake = () => {
          clearTimeout(timer);
          remove();
          resolve();
        };
        const remove = () => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
        };
        this.waiters.push(wake);
      });
    }
    return this.queue.splice(0, this.queue.length).map((p) => p.request);
  }

  /** Resolve one pending request from a client response body. */
  respond(response: BridgeResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    pending.resolve(response);
    return true;
  }

  private wakeWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

/** Read one JSON request body (bounded). */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = 10 * 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Send a JSON response. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}
