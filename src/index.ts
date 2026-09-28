/**
 * Host half of the dsh-winscope plugin: serves the WinScope static build
 * under `/winscope/*`, exposes the browser bridge under
 * `/winscope-bridge/*`, and registers the `winscope_*` AI tools.
 */

import {randomBytes} from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {stat} from 'node:fs/promises';
import {dirname, extname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import Schema from '@deepseek-ai/schemastery';
import {Bridge, readJsonBody, sendJson} from './bridge';
import {WINSCOPE_TOKEN_LOCATION} from './proxy/config';
import {WinscopeProxy} from './proxy/server';
import {registerWinscopeTools} from './tools';

export const name = 'winscope';

export const inject = ['webServer', 'tools'];

export interface Config {
  winscopeDist: string;
  toolTimeoutMs: number;
}

export const Config = Schema.object({
  winscopeDist: Schema.string()
    .default('')
    .description(
      'Optional absolute path to an external WinScope build directory. Leave empty to serve the WinScope build bundled with this plugin.',
    ),
  toolTimeoutMs: Schema.number()
    .default(30_000)
    .description('Timeout in ms for AI tool calls waiting on the browser panels'),
}) as unknown as Schema<Config>;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.py': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Read the saved proxy security token or create and persist a new one. */
function getOrCreateToken(): string {
  try {
    if (existsSync(WINSCOPE_TOKEN_LOCATION)) {
      const saved = readFileSync(WINSCOPE_TOKEN_LOCATION, 'utf8').trim();
      if (saved) return saved;
    }
  } catch {
    // fall through to create a fresh token
  }
  const token = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(WINSCOPE_TOKEN_LOCATION), {recursive: true});
    writeFileSync(WINSCOPE_TOKEN_LOCATION, token, {mode: 0o600});
  } catch (err) {
    console.error(`Unable to save persistent token to ${WINSCOPE_TOKEN_LOCATION}`, err);
  }
  return token;
}

/**
 * Resolve the WinScope static build directory. Uses the build bundled with
 * this plugin (winscope-dist/) unless an explicit external path is configured.
 */
function resolveWinscopeDist(configured: string): string {
  if (configured && configured.trim() !== '') {
    return resolve(configured);
  }
  // lib/index.js sits at <pkg>/lib/, the bundled build at <pkg>/winscope-dist.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'winscope-dist');
}

export function apply(ctx: Context, config: Config): void {
  const bridge = new Bridge();
  const proxy = new WinscopeProxy(getOrCreateToken());
  const distRoot = resolveWinscopeDist(config.winscopeDist);
  ctx.logger('dsh-winscope').info('serving WinScope from %s', distRoot);

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/winscope-bridge',
      handler: async (req, res) => {
        try {
          await handleBridgeRoute(bridge, req, res);
        } catch (e) {
          sendJson(res, 400, {error: (e as Error).message});
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/winscope-proxy',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = url.pathname.replace(/^\/winscope-proxy\/?/, '');
        await proxy.handle(req, res, `/${route}`);
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/winscope',
      handler: async (req, res) => {
        await serveStatic(distRoot, req, res);
      },
    }),
  );

  ctx.effect(() => registerWinscopeTools(ctx, bridge, config));
}

async function handleBridgeRoute(
  bridge: Bridge,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.replace(/^\/winscope-bridge\/?/, '');

  if (req.method === 'GET' && (route === 'poll' || route === '')) {
    const waitMs = Math.min(Number(url.searchParams.get('waitMs') ?? 15_000), 25_000);
    const requests = await bridge.drain(waitMs);
    const body: import('./shared').BridgePollResult = {requests};
    sendJson(res, 200, body);
    return;
  }

  if (req.method === 'POST' && route === 'respond') {
    const body = (await readJsonBody(req)) as import('./shared').BridgeResponse;
    if (!body || typeof body.id !== 'string') {
      sendJson(res, 400, {error: 'missing id'});
      return;
    }
    const known = bridge.respond(body);
    sendJson(res, 200, {ok: known});
    return;
  }

  if (req.method === 'POST' && route === 'heartbeat') {
    const body = (await readJsonBody(req)) as import('./shared').BridgeHeartbeat;
    if (!body || !Array.isArray(body.panels)) {
      sendJson(res, 400, {error: 'missing panels'});
      return;
    }
    bridge.noteHeartbeat({panels: body.panels.filter((p) => p === 'A' || p === 'B')});
    sendJson(res, 200, {ok: true});
    return;
  }

  sendJson(res, 404, {error: `unknown bridge route: ${route}`});
}

async function serveStatic(
  distRoot: string,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  let relative = decodeURIComponent(url.pathname).replace(/^\/winscope\/?/, '');
  if (relative === '' || relative.endsWith('/')) {
    relative += 'index.html';
  }

  const filePath = resolve(join(distRoot, relative));
  if (filePath !== distRoot && !filePath.startsWith(distRoot + sep)) {
    res.writeHead(403).end();
    return;
  }

  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) throw new Error('not a file');
    const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': stats.size,
      // HTML must always revalidate so WinScope rebuilds are picked up;
      // hashed assets could be cached but keep it simple and uniform.
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => {
      res.destroy();
    });
  } catch {
    res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    res.end(`Not found: ${relative}`);
  }
}
