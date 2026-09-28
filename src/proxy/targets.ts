/**
 * Trace / dump target registries, translated from winscope_proxy.py.
 *
 * Each target maps a client-requested trace name to (a) the device files it
 * produces, (b) whether a perfetto data source can serve it, (c) the legacy
 * start/stop shell commands and (d) an optional TraceConfig factory.
 */

import {
  PERFETTO_DUMP_CONFIG_FILE,
  PERFETTO_DUMP_FILE,
  PERFETTO_TRACE_CONFIG_FILE,
  PERFETTO_TRACE_FILE,
  PERFETTO_UNIQUE_SESSION_NAME,
  WINSCOPE_BACKUP_DIR,
  WINSCOPE_DIR,
  WINSCOPE_EXT,
  WINSCOPE_STATUS,
  isAnyPerfettoDataSourceAvailable,
  isPerfettoDataSourceAvailable,
} from './config';
import {
  FileMatcher,
  InputConfig,
  ImeConfig,
  ProtoLogConfig,
  ScreenRecordingConfig,
  ScreenshotConfig,
  SurfaceFlingerDumpConfig,
  SurfaceFlingerTraceConfig,
  TraceConfig,
  TraceFile,
  TraceFileLike,
  TransactionsConfig,
  TransitionTracesConfig,
  ViewCaptureTraceConfig,
  WindowManagerTraceConfig,
  WinscopeFileMatcher,
} from './traceConfigs';

export interface TraceTarget {
  readonly traceName: string;
  readonly files: TraceFileLike[];
  readonly statusFilename: string;
  isPerfettoAvailable(queryResult: string): boolean;
  readonly traceStart: string;
  readonly traceStop: string;
  getTraceConfig?(isPerfetto: boolean): TraceConfig | undefined;
}

export interface DumpTarget {
  readonly traceName: string;
  readonly files: TraceFileLike[];
  isPerfettoAvailable(queryResult: string): boolean;
  readonly dumpCommand: string;
  getTraceConfig?(isPerfetto: boolean): TraceConfig | undefined;
}

function asFiles(files: TraceFileLike | TraceFileLike[]): TraceFileLike[] {
  return Array.isArray(files) ? files : [files];
}

function traceTarget(args: {
  traceName: string;
  files: TraceFileLike | TraceFileLike[];
  isPerfettoAvailable: (queryResult: string) => boolean;
  traceStart: string;
  traceStop: string;
  getTraceConfig?: (isPerfetto: boolean) => TraceConfig;
}): TraceTarget {
  return {
    traceName: args.traceName,
    files: asFiles(args.files),
    statusFilename: `${WINSCOPE_STATUS}_${args.traceName}`,
    isPerfettoAvailable: args.isPerfettoAvailable,
    traceStart: args.traceStart,
    traceStop: args.traceStop,
    getTraceConfig: args.getTraceConfig,
  };
}

function dumpTarget(args: {
  traceName: string;
  files: TraceFileLike | TraceFileLike[];
  isPerfettoAvailable: (queryResult: string) => boolean;
  dumpCommand: string;
  getTraceConfig?: (isPerfetto: boolean) => TraceConfig;
}): DumpTarget {
  return {
    traceName: args.traceName,
    files: asFiles(args.files),
    isPerfettoAvailable: args.isPerfettoAvailable,
    dumpCommand: args.dumpCommand,
    getTraceConfig: args.getTraceConfig,
  };
}

// Order of files matters as they will be expected in that order and decoded in
// that order (same contract as the Python proxy).
export const TRACE_TARGETS: Record<string, TraceTarget> = {
  view_capture_trace: traceTarget({
    traceName: 'view_capture_trace',
    files: new TraceFile(
      '/data/misc/wmtrace/view_capture_trace.zip',
      'view_capture_trace.zip',
    ),
    isPerfettoAvailable: (res) =>
      isPerfettoDataSourceAvailable('android.viewcapture', res),
    traceStart: `
su root settings put global view_capture_enabled 1
echo 'ViewCapture tracing (legacy) started.'
        `,
    traceStop: `
su root sh -c 'cmd launcherapps dump-view-hierarchies >/data/misc/wmtrace/view_capture_trace.zip'
su root settings put global view_capture_enabled 0
echo 'ViewCapture tracing (legacy) stopped.'
        `,
    getTraceConfig: (isPerfetto) => new ViewCaptureTraceConfig(isPerfetto),
  }),

  window_trace: traceTarget({
    traceName: 'window_trace',
    files: new WinscopeFileMatcher(WINSCOPE_DIR, 'wm_trace', 'window_trace'),
    isPerfettoAvailable: (res) =>
      isPerfettoDataSourceAvailable('android.windowmanager', res),
    traceStart: `
su root cmd window tracing start
echo 'WM trace (legacy) started.'
        `,
    traceStop: `
su root cmd window tracing stop >/dev/null 2>&1
echo 'WM trace (legacy) stopped.'
        `,
    getTraceConfig: (isPerfetto) => new WindowManagerTraceConfig(isPerfetto),
  }),

  layers_trace: traceTarget({
    traceName: 'layers_trace',
    files: new WinscopeFileMatcher(WINSCOPE_DIR, 'layers_trace', 'layers_trace'),
    isPerfettoAvailable: (res) =>
      isPerfettoDataSourceAvailable('android.surfaceflinger.layers', res),
    traceStart: `
su root service call SurfaceFlinger 1025 i32 1
echo 'SF layers trace (legacy) started.'
        `,
    traceStop: `
su root service call SurfaceFlinger 1025 i32 0 >/dev/null 2>&1
echo 'SF layers trace (legacy) stopped.'
        `,
    getTraceConfig: (isPerfetto) => new SurfaceFlingerTraceConfig(isPerfetto),
  }),

  screen_recording: traceTarget({
    traceName: 'screen_recording',
    files: new TraceFile(
      '/data/local/tmp/screen_{trace_identifier}.mp4',
      'screen_recording_{trace_identifier}',
    ),
    isPerfettoAvailable: () => false,
    traceStart: `
        settings put system show_touches 1 && \\
        settings put system pointer_location 1 && \\
        screenrecord --bugreport --bit-rate 8M {options} /data/local/tmp/screen_{trace_identifier}.mp4 & \\
        echo "ScreenRecorder started."
        `,
    traceStop: `settings put system pointer_location 0 && \\
        settings put system show_touches 0 && \\
        pkill -l SIGINT screenrecord >/dev/null 2>&1
        `.trim(),
    getTraceConfig: (isPerfetto) => new ScreenRecordingConfig(isPerfetto),
  }),

  transactions: traceTarget({
    traceName: 'transactions',
    files: new WinscopeFileMatcher(
      WINSCOPE_DIR,
      'transactions_trace',
      'transactions',
    ),
    isPerfettoAvailable: (res) =>
      isPerfettoDataSourceAvailable('android.surfaceflinger.transactions', res),
    traceStart: `
su root service call SurfaceFlinger 1041 i32 1
echo 'SF transactions trace (legacy) started.'
        `,
    traceStop:
      'su root service call SurfaceFlinger 1041 i32 0 >/dev/null 2>&1',
    getTraceConfig: (isPerfetto) => new TransactionsConfig(isPerfetto),
  }),

  transactions_legacy: traceTarget({
    traceName: 'transactions_legacy',
    files: [
      new WinscopeFileMatcher(
        WINSCOPE_DIR,
        'transaction_trace',
        'transactions_legacy',
      ),
      new FileMatcher(WINSCOPE_DIR, 'transaction_merges_*', 'transaction_merges'),
    ],
    isPerfettoAvailable: () => false,
    traceStart:
      'su root service call SurfaceFlinger 1020 i32 1\necho "SF transactions recording started."',
    traceStop: 'su root service call SurfaceFlinger 1020 i32 0 >/dev/null 2>&1',
  }),

  proto_log: traceTarget({
    traceName: 'proto_log',
    files: new WinscopeFileMatcher(WINSCOPE_DIR, 'wm_log', 'proto_log'),
    isPerfettoAvailable: (res) =>
      isPerfettoDataSourceAvailable('android.protolog', res),
    traceStart: `
su root cmd window logging start
echo "ProtoLog (legacy) started."
        `,
    traceStop: `
su root cmd window logging stop >/dev/null 2>&1
echo "ProtoLog (legacy) stopped."
        `,
    getTraceConfig: (isPerfetto) => new ProtoLogConfig(isPerfetto),
  }),

  ime: traceTarget({
    traceName: 'ime',
    files: [
      new WinscopeFileMatcher(WINSCOPE_DIR, 'ime_trace_clients', 'ime_trace_clients'),
      new WinscopeFileMatcher(WINSCOPE_DIR, 'ime_trace_service', 'ime_trace_service'),
      new WinscopeFileMatcher(
        WINSCOPE_DIR,
        'ime_trace_managerservice',
        'ime_trace_managerservice',
      ),
    ],
    isPerfettoAvailable: (res) =>
      isPerfettoDataSourceAvailable('android.inputmethod', res),
    traceStart: `
su root ime tracing start
echo "IME tracing (legacy) started."
        `,
    traceStop: `
su root ime tracing stop >/dev/null 2>&1
echo "IME tracing (legacy) stopped."
        `,
    getTraceConfig: (isPerfetto) => new ImeConfig(isPerfetto),
  }),

  wayland_trace: traceTarget({
    traceName: 'wayland_trace',
    files: new WinscopeFileMatcher('/data/misc/wltrace', 'wl_trace', 'wl_trace'),
    isPerfettoAvailable: () => false,
    traceStart:
      'su root service call Wayland 26 i32 1 >/dev/null\necho "Wayland trace started."',
    traceStop: 'su root service call Wayland 26 i32 0 >/dev/null',
  }),

  eventlog: traceTarget({
    traceName: 'eventlog',
    files: new WinscopeFileMatcher('/data/local/tmp', 'eventlog', 'eventlog'),
    isPerfettoAvailable: () => false,
    traceStart:
      'rm -f /data/local/tmp/eventlog.winscope && EVENT_LOG_TRACING_START_TIME=$EPOCHREALTIME\necho "Event Log trace started."',
    traceStop:
      'echo "EventLog\\n" > /data/local/tmp/eventlog.winscope && su root logcat -b events -v threadtime -v printable -v uid -v nsec -v epoch -b events -t $EVENT_LOG_TRACING_START_TIME >> /data/local/tmp/eventlog.winscope',
  }),

  transition_traces: traceTarget({
    traceName: 'transition_traces',
    files: [
      new WinscopeFileMatcher(
        WINSCOPE_DIR,
        'wm_transition_trace',
        'wm_transition_trace',
      ),
      new WinscopeFileMatcher(
        WINSCOPE_DIR,
        'shell_transition_trace',
        'shell_transition_trace',
      ),
    ],
    isPerfettoAvailable: (res) =>
      isPerfettoDataSourceAvailable('com.android.wm.shell.transition', res),
    traceStart: `
su root cmd window shell tracing start && su root dumpsys activity service SystemUIService WMShell transitions tracing start
echo "Transition traces (legacy) started."
        `,
    traceStop: `
su root cmd window shell tracing stop && su root dumpsys activity service SystemUIService WMShell transitions tracing stop >/dev/null 2>&1
echo 'Transition traces (legacy) stopped.'
        `,
    getTraceConfig: (isPerfetto) => new TransitionTracesConfig(isPerfetto),
  }),

  input: traceTarget({
    traceName: 'input',
    files: [new WinscopeFileMatcher(WINSCOPE_DIR, 'input_trace', 'input_trace')],
    isPerfettoAvailable: (res) =>
      isPerfettoDataSourceAvailable('android.input.inputevent', res),
    traceStart: '',
    traceStop: '',
    getTraceConfig: (isPerfetto) => new InputConfig(isPerfetto),
  }),

  perfetto_trace: traceTarget({
    traceName: 'perfetto_trace',
    files: new TraceFile(PERFETTO_TRACE_FILE, 'trace.perfetto-trace'),
    isPerfettoAvailable: (res) => isAnyPerfettoDataSourceAvailable(res),
    traceStart: `
cat << EOF >> ${PERFETTO_TRACE_CONFIG_FILE}
buffers: {
    size_kb: 500000
    fill_policy: RING_BUFFER
}
duration_ms: 0
file_write_period_ms: 999999999
write_into_file: true
unique_session_name: "${PERFETTO_UNIQUE_SESSION_NAME}"
EOF

rm -f ${PERFETTO_TRACE_FILE}
perfetto --out ${PERFETTO_TRACE_FILE} --txt --config ${PERFETTO_TRACE_CONFIG_FILE} --detach=WINSCOPE-PROXY-TRACING-SESSION
echo 'Started perfetto trace.'
`,
    traceStop: `
perfetto --attach=WINSCOPE-PROXY-TRACING-SESSION --stop
sleep 2
echo 'Stopped perfetto trace.'
`,
  }),
};

export const DUMP_TARGETS: Record<string, DumpTarget> = {
  window_dump: dumpTarget({
    traceName: 'window_dump',
    files: new TraceFile(`/data/local/tmp/wm_dump${WINSCOPE_EXT}`, 'window_dump'),
    isPerfettoAvailable: () => false,
    dumpCommand: `su root dumpsys window --proto > /data/local/tmp/wm_dump${WINSCOPE_EXT}`,
  }),

  layers_dump: dumpTarget({
    traceName: 'layers_dump',
    files: new TraceFile(`/data/local/tmp/sf_dump${WINSCOPE_EXT}`, 'layers_dump'),
    isPerfettoAvailable: (res) =>
      isPerfettoDataSourceAvailable('android.surfaceflinger.layers', res),
    dumpCommand: `
su root dumpsys SurfaceFlinger --proto > /data/local/tmp/sf_dump${WINSCOPE_EXT}
        `,
    getTraceConfig: (isPerfetto) => new SurfaceFlingerDumpConfig(isPerfetto),
  }),

  screenshot: dumpTarget({
    traceName: 'screenshot',
    files: new TraceFile(
      '/data/local/tmp/screenshot_{trace_identifier}.png',
      'screenshot_{trace_identifier}.png',
    ),
    isPerfettoAvailable: () => false,
    dumpCommand:
      'screencap -p {options}> /data/local/tmp/screenshot_{trace_identifier}.png',
    getTraceConfig: (isPerfetto) => new ScreenshotConfig(isPerfetto),
  }),

  perfetto_dump: dumpTarget({
    traceName: 'perfetto_dump',
    files: new TraceFile(PERFETTO_DUMP_FILE, 'dump.perfetto-trace'),
    isPerfettoAvailable: (res) => isAnyPerfettoDataSourceAvailable(res),
    dumpCommand: `
cat << EOF >> ${PERFETTO_DUMP_CONFIG_FILE}
buffers: {
    size_kb: 500000
    fill_policy: RING_BUFFER
}
duration_ms: 1
EOF

rm -f ${PERFETTO_DUMP_FILE}
perfetto --out ${PERFETTO_DUMP_FILE} --txt --config ${PERFETTO_DUMP_CONFIG_FILE}
echo 'Recorded perfetto dump.'
        `,
  }),
};

/** Substitute `{trace_identifier}` / `{options}` in a start/dump template. */
export function formatTraceTemplate(
  template: string,
  traceIdentifier: string,
  options: string,
): string {
  return template
    .replaceAll('{trace_identifier}', traceIdentifier)
    .replaceAll('{options}', options);
}

/** Path the collected file should be moved to on the device. */
export function backupPathFor(fileType: string): string {
  return `${WINSCOPE_BACKUP_DIR}${fileType}`;
}
