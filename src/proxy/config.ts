/**
 * Proxy constants mirroring the top of winscope_proxy.py. Keep VERSION in
 * sync with ProxyConnection#VERSION in WinScope (winscope/src/trace_collection/
 * proxy_connection.ts).
 */

export const VERSION = '4.0.8';

export const PERFETTO_TRACE_CONFIG_FILE =
  '/data/misc/perfetto-configs/winscope-proxy-trace.conf';
export const PERFETTO_DUMP_CONFIG_FILE =
  '/data/misc/perfetto-configs/winscope-proxy-dump.conf';
export const PERFETTO_TRACE_FILE =
  '/data/misc/perfetto-traces/winscope-proxy-trace.perfetto-trace';
export const PERFETTO_DUMP_FILE =
  '/data/misc/perfetto-traces/winscope-proxy-dump.perfetto-trace';
export const PERFETTO_UNIQUE_SESSION_NAME = 'winscope proxy perfetto tracing';

export const PERFETTO_TRACING_SESSIONS_QUERY_START = `TRACING SESSIONS:

ID      UID     STATE      BUF (#) KB   DUR (s)   #DS  STARTED  NAME
===     ===     =====      ==========   =======   ===  =======  ====\n`;
export const PERFETTO_TRACING_SESSIONS_QUERY_END =
  '\nNOTE: Some tracing sessions are not reported in the list above.';

export const WINSCOPE_VERSION_HEADER = 'Winscope-Proxy-Version';
export const WINSCOPE_TOKEN_HEADER = 'Winscope-Token';

// Location to save the proxy security token (same path as the Python proxy so
// an existing token is reused).
export const WINSCOPE_TOKEN_LOCATION = (() => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  return `${home}/.config/winscope/.token`;
})();

// Winscope traces extensions
export const WINSCOPE_EXT = '.winscope';
export const WINSCOPE_EXT_LEGACY = '.pb';
export const WINSCOPE_EXTS = [WINSCOPE_EXT, WINSCOPE_EXT_LEGACY];

// Winscope traces directories
export const WINSCOPE_DIR = '/data/misc/wmtrace/';
export const WINSCOPE_BACKUP_DIR = '/data/local/tmp/last_winscope_tracing_session/';

// Tracing handlers
export const SIGNAL_HANDLER_LOG = '/data/local/tmp/winscope_signal_handler.log';
export const WINSCOPE_STATUS = '/data/local/tmp/winscope_status';

// Max interval between the client keep-alive requests in seconds
export const KEEP_ALIVE_INTERVAL_S = 5;

// Perfetto's default timeout for getting an ACK from producer processes is 5s.
export const COMMAND_TIMEOUT_S = 15;

const PERFETTO_SOURCES = [
  'android.inputmethod',
  'android.protolog',
  'android.surfaceflinger.layers',
  'android.surfaceflinger.transactions',
  'com.android.wm.shell.transition',
  'android.viewcapture',
  'android.windowmanager',
  'android.input.inputevent',
] as const;

export function isPerfettoDataSourceAvailable(
  name: string,
  queryResult: string,
): boolean {
  return queryResult.includes(name);
}

export function isAnyPerfettoDataSourceAvailable(queryResult: string): boolean {
  return PERFETTO_SOURCES.some((name) => queryResult.includes(name));
}
