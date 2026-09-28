/**
 * HTTP half of the Node winscope proxy — a faithful re-implementation of
 * winscope_proxy.py's RequestRouter + endpoints, served same-origin under
 * `/winscope-proxy` by the DSH webserver (so the WinScope iframe needs no
 * cross-origin proxy and no locally-running Python).
 *
 * Endpoints (all but /config require the `Winscope-Token` header):
 *   GET  /config              -> { token, version }
 *   GET  /devices/            -> device list JSON
 *   GET  /checkwayland/       -> 'true' | 'false'
 *   GET  /status/{device}/    -> 'True' | 'False' (keep-alive)
 *   GET  /fetch/{device}/     -> { <file>.gz: [base64...] }
 *   POST /start/{device}/     -> start trace, returns warnings JSON
 *   POST /end/{device}/       -> stop trace, returns errors JSON
 *   POST /dump/{device}/      -> dump state, returns warnings JSON
 */

import type {IncomingMessage, ServerResponse} from 'node:http';
import {gzipSync} from 'node:zlib';
import {readJsonBody} from '../bridge';
import {
  AdbError,
  adbExecOut,
  callAdb,
  collectStdout,
  runShellScript,
} from './adb';
import {
  PERFETTO_DUMP_CONFIG_FILE,
  PERFETTO_TRACE_CONFIG_FILE,
  PERFETTO_TRACING_SESSIONS_QUERY_END,
  PERFETTO_TRACING_SESSIONS_QUERY_START,
  PERFETTO_UNIQUE_SESSION_NAME,
  SIGNAL_HANDLER_LOG,
  VERSION,
  WINSCOPE_BACKUP_DIR,
  WINSCOPE_TOKEN_HEADER,
  WINSCOPE_VERSION_HEADER,
} from './config';
import {TraceSession, TraceSessionManager} from './sessions';
import {
  DUMP_TARGETS,
  TRACE_TARGETS,
  formatTraceTemplate,
  type DumpTarget,
  type TraceTarget,
} from './targets';
import {FileMatcher, type TraceConfig, type TraceFileLike} from './traceConfigs';

class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

interface TraceRequest {
  name: string;
  config: Array<{key: string; value?: string | string[]}>;
}

type PreparedTarget = [TraceTarget | DumpTarget, TraceConfig | undefined];

const DEVICE_ID_RE = /^[A-Za-z0-9._:\-]+$/;

function respond(
  res: ServerResponse,
  code: number,
  body: string | Buffer,
  mime: string,
): void {
  res.writeHead(code, {
    'content-type': mime,
    'cache-control': 'no-cache, no-store, must-revalidate',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': `${WINSCOPE_TOKEN_HEADER}, Content-Type, Content-Length`,
    'access-control-expose-headers': WINSCOPE_VERSION_HEADER,
    [WINSCOPE_VERSION_HEADER]: VERSION,
  });
  res.end(body);
}

const TRACE_COMMAND = (args: {
  status: string;
  signalLog: string;
  stopCommands: string;
  startCommands: string;
}): string => `set -e

echo "Starting trace..."
echo "TRACE_START" > ${args.status}

# Do not print anything to stdout/stderr in the handler
function stop_trace() {
  echo "start" >${args.signalLog}

  # redirect stdout/stderr to log file
  exec 1>>${args.signalLog}
  exec 2>>${args.signalLog}

  set -x
  trap - EXIT HUP INT
  ${args.stopCommands}
  echo "TRACE_OK" > ${args.status}
}

trap stop_trace EXIT HUP INT
echo "Signal handler registered."

${args.startCommands}

# ADB shell does not handle hung up well and does not call HUP handler when a
# child is active in foreground, as a workaround we sleep for short intervals
# in a loop so the handler is called after a sleep interval.
while true; do sleep 0.1; done
`;

export class WinscopeProxy {
  private readonly sessions = new TraceSessionManager();

  constructor(readonly token: string) {}

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (req.method === 'OPTIONS') {
      respond(res, 200, '', 'text/plain');
      return;
    }

    const parts = pathname.split('/').filter(Boolean);
    const endpoint = parts[0] ?? '';

    // The config endpoint is intentionally unauthenticated: the browser client
    // needs the token before it can build the iframe URL.
    if (req.method === 'GET' && endpoint === 'config') {
      respond(
        res,
        200,
        JSON.stringify({token: this.token, version: VERSION}),
        'application/json',
      );
      return;
    }

    if (req.headers[WINSCOPE_TOKEN_HEADER.toLowerCase()] !== this.token) {
      respond(
        res,
        403,
        'Bad Winscope authorization token!\nThis is Winscope ADB proxy.\n',
        'text/plain',
      );
      return;
    }

    try {
      switch (endpoint) {
        case 'devices':
          await this.listDevices(res);
          break;
        case 'checkwayland':
          await this.checkWayland(res);
          break;
        case 'status':
          await this.status(res, this.deviceId(parts));
          break;
        case 'fetch':
          await this.fetch(res, this.deviceId(parts));
          break;
        case 'start':
          await this.start(res, req, this.deviceId(parts));
          break;
        case 'end':
          await this.end(res, this.deviceId(parts));
          break;
        case 'dump':
          await this.dump(res, req, this.deviceId(parts));
          break;
        default:
          throw new BadRequest(`Unknown endpoint /${endpoint}/`);
      }
    } catch (err) {
      if (err instanceof BadRequest) {
        respond(
          res,
          400,
          `Bad request!\nThis is Winscope ADB proxy.\n\n${err.message}`,
          'text/plain',
        );
      } else if (err instanceof AdbError) {
        respond(res, 500, err.message, 'text/plain');
      } else {
        respond(res, 500, String(err), 'text/plain');
      }
    }
  }

  private deviceId(parts: string[]): string {
    const id = parts[1];
    if (!id || !DEVICE_ID_RE.test(id)) {
      throw new BadRequest('Device id not specified');
    }
    return id;
  }

  /* ---------------------------------------------------------------- */
  /* devices / checkwayland                                            */
  /* ---------------------------------------------------------------- */

  private async listDevices(res: ServerResponse): Promise<void> {
    const lines = (await callAdb('devices -l')).split('\n').filter(Boolean);
    const devices: Record<
      string,
      {
        authorized: boolean;
        model: string;
        displays: string[];
        screenrecord_version: string;
      }
    > = {};

    for (const line of lines.slice(1)) {
      const m = line.match(/^([A-Za-z0-9._:\-]+)\s+(\w+)(.*model:(\w+))?/);
      if (!m) continue;
      const deviceId = m[1];
      const authorized = m[2] !== 'unauthorized';

      let screenRecordVersion = '0';
      if (authorized) {
        try {
          screenRecordVersion = await callAdb(
            'shell screenrecord --version',
            deviceId,
          );
        } catch {
          try {
            const helpText = await callAdb('shell screenrecord --help', deviceId);
            const versionStartIndex = helpText.indexOf('v') + 1;
            screenRecordVersion = helpText.slice(
              versionStartIndex,
              versionStartIndex + 3,
            );
          } catch {
            screenRecordVersion = '0';
          }
        }
      }

      let displays: string[] = [];
      if (authorized) {
        try {
          displays = (
            await callAdb(
              'shell su root dumpsys SurfaceFlinger --display-id',
              deviceId,
            )
          )
            .split('\n')
            .filter(Boolean);
        } catch {
          displays = [];
        }
      }

      devices[deviceId] = {
        authorized,
        model: m[4] ? m[4].replaceAll('_', ' ') : '',
        displays,
        screenrecord_version: screenRecordVersion,
      };
    }

    respond(res, 200, JSON.stringify(devices), 'application/json');
  }

  private async checkWayland(res: ServerResponse): Promise<void> {
    const lines = (await callAdb('devices -l')).split('\n').filter(Boolean);
    const found: Record<string, {authorized: boolean; model: string}> = {};

    for (const line of lines.slice(1)) {
      const m = line.match(/^([A-Za-z0-9._:\-]+)\s+(\w+)(.*model:(\w+))?/);
      if (!m) continue;
      found[m[1]] = {
        authorized: m[2] !== 'unauthorized',
        model: m[4] ? m[4].replaceAll('_', ' ') : '',
      };
    }

    let result = 'false';
    if (Object.keys(found).length === 1) {
      const device = Object.values(found)[0];
      if (device.authorized && device.model) {
        const rawRes = await callAdb('shell service check Wayland');
        result = rawRes.includes('not found') ? 'false' : 'true';
      }
    }
    respond(res, 200, result, 'text/plain');
  }

  /* ---------------------------------------------------------------- */
  /* status                                                            */
  /* ---------------------------------------------------------------- */

  private async status(res: ServerResponse, deviceId: string): Promise<void> {
    const list = this.sessions.get(deviceId);
    if (!list || list.length === 0) {
      throw new BadRequest(`No trace in progress for ${deviceId}`);
    }
    this.sessions.resetTimers(deviceId);
    respond(res, 200, list[0].isAlive() ? 'True' : 'False', 'text/plain');
  }

  /* ---------------------------------------------------------------- */
  /* fetch                                                             */
  /* ---------------------------------------------------------------- */

  private async fetch(res: ServerResponse, deviceId: string): Promise<void> {
    const matcher = new FileMatcher(`${WINSCOPE_BACKUP_DIR}*`, '', '');
    const filePaths = await matcher.getFilepaths(deviceId);
    const fileBuffers: Record<string, string[]> = {};

    for (const filePath of filePaths) {
      const fileName = filePath.split('/').pop() + '.gz';
      try {
        const child = adbExecOut(deviceId, ['su', 'root', 'cat', filePath]);
        const {stdout} = await collectStdout(child);
        const encoded = gzipSync(stdout).toString('base64');
        (fileBuffers[fileName] ??= []).push(encoded);
      } catch (err) {
        console.warn(`Unable to fetch file ${filePath} - ${String(err)}`);
        break;
      }
    }

    respond(res, 200, JSON.stringify(fileBuffers), 'application/json');
  }

  /* ---------------------------------------------------------------- */
  /* shared prepare logic                                              */
  /* ---------------------------------------------------------------- */

  private async checkRoot(deviceId: string): Promise<boolean> {
    return parseInt(await callAdb('shell su root id -u', deviceId), 10) === 0;
  }

  private async tooManyPerfettoSessions(queryResult: string): Promise<boolean> {
    const start = queryResult.indexOf(PERFETTO_TRACING_SESSIONS_QUERY_START);
    if (start === -1) return false;

    let concurrent = queryResult.slice(
      start + PERFETTO_TRACING_SESSIONS_QUERY_START.length,
    );
    let end = concurrent.indexOf(PERFETTO_TRACING_SESSIONS_QUERY_END);
    if (end > 0) end -= 1;
    concurrent = concurrent.slice(0, end);

    let count = concurrent.length > 0 ? concurrent.split('\n').length : 0;
    if (concurrent.includes(PERFETTO_UNIQUE_SESSION_NAME)) {
      await callAdb('shell perfetto --attach=WINSCOPE-PROXY-TRACING-SESSION --stop');
      count -= 1;
    }
    return count >= 5;
  }

  private movePerfettoToEnd(targets: PreparedTarget[]): PreparedTarget[] {
    const isPerfetto = (t: TraceTarget | DumpTarget) =>
      t === TRACE_TARGETS['perfetto_trace'] || t === DUMP_TARGETS['perfetto_dump'];
    return [
      ...targets.filter(([t]) => !isPerfetto(t)),
      ...targets.filter(([t]) => isPerfetto(t)),
    ];
  }

  private async clearLastTracingSession(deviceId: string): Promise<void> {
    await callAdb(`shell su root rm -rf ${WINSCOPE_BACKUP_DIR}`, deviceId);
    await callAdb(`shell su root mkdir ${WINSCOPE_BACKUP_DIR}`, deviceId);
  }

  private async applyConfig(
    traceConfig: TraceConfig,
    requestedConfigs: Array<{key: string; value?: string | string[]}>,
    deviceId: string,
  ): Promise<void> {
    for (const requested of requestedConfigs) {
      const configKey = requested.key;
      if (!traceConfig.is_valid(configKey)) {
        throw new BadRequest(`Unsupported config ${configKey}\n`);
      }
      traceConfig.add(configKey, requested.value ?? null);
    }

    if (this.sessions.has(deviceId)) {
      throw new BadRequest(`Trace in progress for ${deviceId}`);
    }
    if (!(await this.checkRoot(deviceId))) {
      throw new AdbError(
        `Unable to acquire root privileges on the device - check the output of 'adb -s ${deviceId} shell su root id'`,
      );
    }
    await traceConfig.execute_command(deviceId);
  }

  private async prepareTargets(
    req: IncomingMessage,
    deviceId: string,
    perfettoConfigFile: string,
    targetsMap: Record<string, TraceTarget | DumpTarget>,
    perfettoName: string,
  ): Promise<{targets: PreparedTarget[]; warnings: string[]}> {
    const warnings: string[] = [];

    await callAdb(`shell su root rm -f ${perfettoConfigFile}`, deviceId);

    const traceRequests = (await readJsonBody(req)) as TraceRequest[];
    if (!Array.isArray(traceRequests)) {
      throw new BadRequest('Request body must be a JSON array');
    }

    const perfettoQueryResult = await callAdb('shell perfetto --query', deviceId);
    const tooManySessions = await this.tooManyPerfettoSessions(perfettoQueryResult);
    if (tooManySessions) {
      warnings.push(
        'Limit of 5 Perfetto sessions reached on device. Will attempt to collect legacy traces.',
      );
    }

    const prepared: PreparedTarget[] = [];
    for (const t of traceRequests) {
      try {
        const traceName = t.name;
        const target = targetsMap[traceName];
        const isPerfetto =
          !tooManySessions && target.isPerfettoAvailable(perfettoQueryResult);

        let config: TraceConfig | undefined;
        if (target.getTraceConfig !== undefined) {
          config = target.getTraceConfig(isPerfetto);
          if (config) {
            await this.applyConfig(config, t.config ?? [], deviceId);
          }
        }

        const isValidPerfettoTarget =
          traceName === perfettoName && !tooManySessions;
        const isValidTraceTarget = traceName !== perfettoName && !isPerfetto;
        if (isValidPerfettoTarget || isValidTraceTarget) {
          prepared.push([target, config]);
        } else if (
          isPerfetto &&
          (traceName === 'window_trace' ||
            traceName === 'transactions' ||
            traceName === 'layers_trace')
        ) {
          // Some devices expose the perfetto data source but don't produce
          // WinScope-parseable data in the perfetto trace. Run the legacy
          // session in parallel so WinScope can fall back to the plain file.
          const legacyConfig = target.getTraceConfig?.(false);
          if (legacyConfig) {
            await this.applyConfig(legacyConfig, t.config ?? [], deviceId);
            prepared.push([target, legacyConfig]);
          }
        }
      } catch (err) {
        console.warn(`Unsupported trace target: ${String(err)}`);
      }
    }

    const ordered = this.movePerfettoToEnd(prepared);

    if (!(await this.checkRoot(deviceId))) {
      throw new AdbError(
        `Unable to acquire root privileges on the device - check the output of 'adb -s ${deviceId} shell su root id'`,
      );
    }
    await this.clearLastTracingSession(deviceId);

    return {targets: ordered, warnings};
  }

  private async moveCollectedFiles(
    files: TraceFileLike[],
    deviceId: string,
    traceIdentifier: string,
  ): Promise<void> {
    for (const f of files) {
      const filePaths = await f.getFilepaths(deviceId);
      const fileType = formatTraceTemplate(f.getFiletype(), traceIdentifier, '');
      for (const filePath of filePaths) {
        const formattedPath = formatTraceTemplate(filePath, traceIdentifier, '');
        try {
          await callAdb(
            `shell su root [ ! -f ${formattedPath} ] || su root mv ${formattedPath} ${WINSCOPE_BACKUP_DIR}${fileType}`,
            deviceId,
          );
        } catch (err) {
          console.warn(`Unable to move file ${formattedPath} - ${String(err)}`);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* start / end / dump                                                */
  /* ---------------------------------------------------------------- */

  private async start(
    res: ServerResponse,
    req: IncomingMessage,
    deviceId: string,
  ): Promise<void> {
    const {targets, warnings} = await this.prepareTargets(
      req,
      deviceId,
      PERFETTO_TRACE_CONFIG_FILE,
      TRACE_TARGETS,
      'perfetto_trace',
    );

    for (const [target, config] of targets) {
      const traceTarget = target as TraceTarget;
      const traceIdentifiers = config ? config.get_trace_identifiers() : [''];

      for (const traceIdentifier of traceIdentifiers) {
        const startCmd = traceIdentifier
          ? formatTraceTemplate(
              traceTarget.traceStart,
              traceIdentifier,
              config ? config.get_optional_start_args(traceIdentifier) : '',
            )
          : traceTarget.traceStart;

        const command = Buffer.from(
          TRACE_COMMAND({
            status: traceTarget.statusFilename,
            signalLog: SIGNAL_HANDLER_LOG,
            stopCommands: traceTarget.traceStop,
            startCommands: startCmd,
          }),
        );

        const session = new TraceSession(
          deviceId,
          traceTarget.traceName,
          command,
          traceIdentifier,
          traceTarget.statusFilename,
        );
        this.sessions.add(deviceId, session);
      }
    }

    this.sessions.resetTimers(deviceId);
    respond(res, 200, JSON.stringify(warnings), 'application/json');
  }

  private async end(res: ServerResponse, deviceId: string): Promise<void> {
    const list = this.sessions.get(deviceId);
    if (!list || list.length === 0) {
      throw new BadRequest(`No trace in progress for ${deviceId}`);
    }

    const errors: string[] = [];
    let lastStatusFilename = '';

    for (const session of list) {
      if (session.isAlive()) await session.end();

      lastStatusFilename = session.statusFilename;
      const signalHandlerLog = Buffer.from(
        await callAdb(`shell su root cat ${SIGNAL_HANDLER_LOG}`, deviceId),
      );

      if (session.timedOut()) {
        errors.push(`Trace ${session.traceName} timed out during cleanup`);
      }
      if (!session.success()) {
        errors.push(
          `Error ending trace ${session.traceName} on the device: ${session
            .stderr()
            .toString('utf8')}`,
        );
      }

      const out = `### Shell script's stdout ###\n${
        session.stdout().toString('utf8') || '<no stdout>'
      }\n### Shell script's stderr ###\n${
        session.stderr().toString('utf8') || '<no stderr>'
      }\n### Signal handler log ###\n${
        signalHandlerLog.toString('utf8') || '<no signal handler logs>'
      }\n`;
      console.debug(out);

      const traceTarget = TRACE_TARGETS[session.traceName];
      if (traceTarget) {
        await this.moveCollectedFiles(
          traceTarget.files,
          deviceId,
          session.traceIdentifier,
        );
      } else {
        errors.push(`File location unknown for ${session.traceName}`);
      }
    }

    await callAdb(`shell su root rm ${lastStatusFilename}`, deviceId);
    this.sessions.delete(deviceId);
    respond(res, 200, JSON.stringify(errors), 'text/plain');
  }

  private async dump(
    res: ServerResponse,
    req: IncomingMessage,
    deviceId: string,
  ): Promise<void> {
    const {targets, warnings} = await this.prepareTargets(
      req,
      deviceId,
      PERFETTO_DUMP_CONFIG_FILE,
      DUMP_TARGETS,
      'perfetto_dump',
    );

    const dumpCommands: string[] = [];
    for (const [target, config] of targets) {
      const dumpTarget = target as DumpTarget;
      if (config) {
        for (const traceIdentifier of config.get_trace_identifiers()) {
          dumpCommands.push(
            formatTraceTemplate(
              dumpTarget.dumpCommand,
              traceIdentifier,
              config.get_optional_start_args(traceIdentifier),
            ),
          );
        }
      } else {
        dumpCommands.push(dumpTarget.dumpCommand);
      }
    }

    const {code, stdout, stderr} = await runShellScript(
      deviceId,
      dumpCommands.join('\n'),
    );
    if (code !== 0) {
      throw new AdbError(
        `Error executing dump command.\n\n### OUTPUT ###${stdout.toString('utf8')}\n${stderr.toString('utf8')}`,
      );
    }

    for (const [target, config] of targets) {
      const dumpTarget = target as DumpTarget;
      if (config) {
        for (const traceIdentifier of config.get_trace_identifiers()) {
          await this.moveCollectedFiles(
            dumpTarget.files,
            deviceId,
            traceIdentifier,
          );
        }
      } else {
        await this.moveCollectedFiles(dumpTarget.files, deviceId, '');
      }
    }

    respond(res, 200, JSON.stringify(warnings), 'text/plain');
  }
}
