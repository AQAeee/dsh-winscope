/**
 * Trace config classes and file matchers, translated from winscope_proxy.py.
 *
 * These encode every optional SurfaceFlinger / WindowManager / perfetto data
 * source configuration (legacy `service call` flags and perfetto text configs)
 * plus the device-side file matchers used to locate produced trace files.
 */

import {AdbError, callAdb, runShellScript} from './adb';
import {
  PERFETTO_DUMP_CONFIG_FILE,
  PERFETTO_TRACE_CONFIG_FILE,
  WINSCOPE_EXTS,
} from './config';

/* ------------------------------------------------------------------ */
/* File matchers                                                       */
/* ------------------------------------------------------------------ */

export interface TraceFileLike {
  getFilepaths(deviceId: string): Promise<string[]>;
  getFiletype(): string;
}

/** A single fixed path on the device. */
export class TraceFile implements TraceFileLike {
  constructor(readonly file: string, readonly type: string) {}

  async getFilepaths(_deviceId: string): Promise<string[]> {
    return [this.file];
  }

  getFiletype(): string {
    return this.type;
  }
}

/** A path + `find -name` matcher on the device. */
export class FileMatcher implements TraceFileLike {
  constructor(
    readonly path: string,
    readonly matcher: string,
    readonly type: string,
  ) {}

  async getFilepaths(deviceId: string): Promise<string[]> {
    const matchingFiles =
      this.matcher.length > 0
        ? await callAdb(
            `shell su root find ${this.path} -name ${this.matcher}`,
            deviceId,
          )
        : await callAdb(`shell su root find ${this.path}`, deviceId);
    return matchingFiles
      .split('\n')
      .slice(0, -1)
      .map((line) => line.replace(/\r/g, ''));
  }

  getFiletype(): string {
    return this.type;
  }
}

/** Matcher that tries `.winscope` then `.pb` for the same base name. */
export class WinscopeFileMatcher implements TraceFileLike {
  private readonly internalMatchers: FileMatcher[];

  constructor(path: string, matcher: string, type: string) {
    this.internalMatchers = WINSCOPE_EXTS.map(
      (ext) => new FileMatcher(path, `${matcher}${ext}`, type),
    );
    this.type = type;
  }

  readonly type: string;

  async getFilepaths(deviceId: string): Promise<string[]> {
    for (const matcher of this.internalMatchers) {
      const files = await matcher.getFilepaths(deviceId);
      if (files.length > 0) return files;
    }
    return [];
  }

  getFiletype(): string {
    return this.type;
  }
}

/* ------------------------------------------------------------------ */
/* TraceConfig base + concrete configs                                 */
/* ------------------------------------------------------------------ */

export abstract class TraceConfig {
  constructor(public readonly isPerfetto: boolean) {}

  abstract add(config: string, value: string | string[] | null): void;
  abstract is_valid(config: string): boolean;
  abstract execute_command(deviceId: string): Promise<void>;

  get_trace_identifiers(): string[] {
    return [''];
  }

  get_optional_start_args(_identifier: string): string {
    return '';
  }

  protected async runConfigScript(deviceId: string, command: string): Promise<void> {
    const {code, stdout, stderr} = await runShellScript(deviceId, command);
    if (code !== 0) {
      throw new AdbError(
        `Error executing command:\n ${command}\n\n### OUTPUT ###${stdout.toString('utf8')}\n${stderr.toString('utf8')}`,
      );
    }
  }
}

const SF_LEGACY_FLAGS_MAP: Record<string, number> = {
  input: 1 << 1,
  composition: 1 << 2,
  metadata: 1 << 3,
  hwc: 1 << 4,
  tracebuffers: 1 << 5,
  virtualdisplays: 1 << 6,
};

const SF_PERFETTO_FLAGS_MAP: Record<string, string> = {
  input: 'TRACE_FLAG_INPUT',
  composition: 'TRACE_FLAG_COMPOSITION',
  metadata: 'TRACE_FLAG_EXTRA',
  hwc: 'TRACE_FLAG_HWC',
  tracebuffers: 'TRACE_FLAG_BUFFERS',
  virtualdisplays: 'TRACE_FLAG_VIRTUAL_DISPLAYS',
};

export class SurfaceFlingerTraceConfig extends TraceConfig {
  private readonly flags: string[] = [];
  private readonly selectedConfigs: Record<string, string> = {
    sfbuffersize: '16000',
  };

  add(config: string, value: string | string[] | null): void {
    if (config in SF_LEGACY_FLAGS_MAP) {
      this.flags.push(config);
    } else if (config in this.selectedConfigs) {
      this.selectedConfigs[config] = value as string;
    }
  }

  is_valid(config: string): boolean {
    return config in SF_LEGACY_FLAGS_MAP || config in this.selectedConfigs;
  }

  async execute_command(deviceId: string): Promise<void> {
    if (this.isPerfetto) {
      await this.runConfigScript(deviceId, this.perfettoConfigCommand());
    } else {
      await this.runConfigScript(deviceId, this.legacyFlagsCommand());
      await this.runConfigScript(deviceId, this.legacyBufferSizeCommand());
    }
  }

  private perfettoConfigCommand(): string {
    const flags = this.flags
      .map((flag) => `trace_flags: ${SF_PERFETTO_FLAGS_MAP[flag]}`)
      .join('\n');
    return `
cat << EOF >> ${PERFETTO_TRACE_CONFIG_FILE}
data_sources: {
    config {
        name: "android.surfaceflinger.layers"
        surfaceflinger_layers_config: {
            mode: MODE_ACTIVE
            ${flags}
        }
    }
}
EOF
`;
  }

  private legacyBufferSizeCommand(): string {
    return `su root service call SurfaceFlinger 1029 i32 ${this.selectedConfigs['sfbuffersize']}`;
  }

  private legacyFlagsCommand(): string {
    let flags = 0;
    for (const flag of this.flags) {
      flags |= SF_LEGACY_FLAGS_MAP[flag];
    }
    return `su root service call SurfaceFlinger 1033 i32 ${flags}`;
  }
}

const WM_PERFETTO_LOG_LEVEL_MAP: Record<string, string> = {
  verbose: 'LOG_LEVEL_VERBOSE',
  debug: 'LOG_LEVEL_DEBUG',
  critical: 'LOG_LEVEL_CRITICAL',
};

const WM_PERFETTO_LOG_FREQUENCY_MAP: Record<string, string> = {
  frame: 'LOG_FREQUENCY_FRAME',
  transaction: 'LOG_FREQUENCY_TRANSACTION',
};

export class WindowManagerTraceConfig extends TraceConfig {
  private readonly selectedConfigs: Record<string, string> = {
    wmbuffersize: '16000',
    tracinglevel: 'debug',
    tracingtype: 'frame',
  };

  add(config: string, value: string | string[] | null): void {
    this.selectedConfigs[config] = value as string;
  }

  is_valid(config: string): boolean {
    return config in this.selectedConfigs;
  }

  async execute_command(deviceId: string): Promise<void> {
    if (this.isPerfetto) {
      await this.runConfigScript(deviceId, this.perfettoConfigCommand());
    } else {
      await this.runConfigScript(deviceId, this.legacyTracingTypeCommand());
      await this.runConfigScript(deviceId, this.legacyTracingLevelCommand());
      // buffer size must be configured last, otherwise overridden
      await this.runConfigScript(deviceId, this.legacyBufferSizeCommand());
    }
  }

  private perfettoConfigCommand(): string {
    const logLevel = WM_PERFETTO_LOG_LEVEL_MAP[this.selectedConfigs['tracinglevel']];
    const logFrequency =
      WM_PERFETTO_LOG_FREQUENCY_MAP[this.selectedConfigs['tracingtype']];
    return `
cat << EOF >> ${PERFETTO_TRACE_CONFIG_FILE}
data_sources: {
    config {
        name: "android.windowmanager"
        windowmanager_config: {
            log_level: ${logLevel}
            log_frequency: ${logFrequency}
        }
    }
}
EOF
`;
  }

  private legacyTracingTypeCommand(): string {
    return `su root cmd window tracing ${this.selectedConfigs['tracingtype']}`;
  }

  private legacyTracingLevelCommand(): string {
    return `su root cmd window tracing level ${this.selectedConfigs['tracinglevel']}`;
  }

  private legacyBufferSizeCommand(): string {
    return `su root cmd window tracing size ${this.selectedConfigs['wmbuffersize']}`;
  }
}

export class ViewCaptureTraceConfig extends TraceConfig {
  private static readonly COMMAND = `
cat << EOF >> ${PERFETTO_TRACE_CONFIG_FILE}
data_sources: {
    config {
        name: "android.viewcapture"
    }
}
EOF
`;

  add(_config: string, _value: string | string[] | null): void {}

  is_valid(_config: string): boolean {
    return false;
  }

  async execute_command(deviceId: string): Promise<void> {
    if (this.isPerfetto) {
      await this.runConfigScript(deviceId, ViewCaptureTraceConfig.COMMAND);
    }
  }
}

export class TransactionsConfig extends TraceConfig {
  private static readonly COMMAND = `
cat << EOF >> ${PERFETTO_TRACE_CONFIG_FILE}
data_sources: {
    config {
        name: "android.surfaceflinger.transactions"
        surfaceflinger_transactions_config: {
            mode: MODE_ACTIVE
        }
    }
}
EOF
`;

  add(_config: string, _value: string | string[] | null): void {}

  is_valid(_config: string): boolean {
    return false;
  }

  async execute_command(deviceId: string): Promise<void> {
    if (this.isPerfetto) {
      await this.runConfigScript(deviceId, TransactionsConfig.COMMAND);
    }
  }
}

export class ProtoLogConfig extends TraceConfig {
  private static readonly COMMAND = `
cat << EOF >> ${PERFETTO_TRACE_CONFIG_FILE}
data_sources: {
    config {
        name: "android.protolog"
        protolog_config: {
            tracing_mode: ENABLE_ALL
        }
    }
}
EOF
`;

  add(_config: string, _value: string | string[] | null): void {}

  is_valid(_config: string): boolean {
    return false;
  }

  async execute_command(deviceId: string): Promise<void> {
    if (this.isPerfetto) {
      await this.runConfigScript(deviceId, ProtoLogConfig.COMMAND);
    }
  }
}

export class ImeConfig extends TraceConfig {
  private static readonly COMMAND = `
cat << EOF >> ${PERFETTO_TRACE_CONFIG_FILE}
data_sources: {
    config {
        name: "android.inputmethod"
    }
}
EOF
`;

  add(_config: string, _value: string | string[] | null): void {}

  is_valid(_config: string): boolean {
    return false;
  }

  async execute_command(deviceId: string): Promise<void> {
    if (this.isPerfetto) {
      await this.runConfigScript(deviceId, ImeConfig.COMMAND);
    }
  }
}

export class TransitionTracesConfig extends TraceConfig {
  private static readonly COMMAND = `
cat << EOF >> ${PERFETTO_TRACE_CONFIG_FILE}
data_sources: {
    config {
        name: "com.android.wm.shell.transition"
    }
}
EOF
`;

  add(_config: string, _value: string | string[] | null): void {}

  is_valid(_config: string): boolean {
    return false;
  }

  async execute_command(deviceId: string): Promise<void> {
    if (this.isPerfetto) {
      await this.runConfigScript(deviceId, TransitionTracesConfig.COMMAND);
    }
  }
}

export class InputConfig extends TraceConfig {
  private static readonly COMMAND = `
cat << EOF >> ${PERFETTO_TRACE_CONFIG_FILE}
data_sources: {
    config {
        name: "android.input.inputevent"
        android_input_event_config {
            mode: TRACE_MODE_TRACE_ALL
        }
    }
}
EOF
`;

  add(_config: string, _value: string | string[] | null): void {}

  is_valid(_config: string): boolean {
    return false;
  }

  async execute_command(deviceId: string): Promise<void> {
    if (this.isPerfetto) {
      await this.runConfigScript(deviceId, InputConfig.COMMAND);
    }
  }
}

export class MediaBasedConfig extends TraceConfig {
  protected traceIdentifiers: string[] = ['active'];

  get_trace_identifiers(): string[] {
    return this.traceIdentifiers;
  }

  is_valid(config: string): boolean {
    return config === 'displays';
  }

  add(config: string, value: string | string[] | null): void {
    if (config !== 'displays') return;
    if (value && value.length > 0) {
      if (typeof value === 'string') {
        this.traceIdentifiers = [value.split(' ')[0]];
      } else {
        this.traceIdentifiers = value.map((d) => d.split(' ')[0]);
      }
    }
  }

  async execute_command(_deviceId: string): Promise<void> {}
}

export class ScreenRecordingConfig extends MediaBasedConfig {
  get_optional_start_args(identifier: string): string {
    if (identifier === 'active') return '';
    return `--display-id ${identifier}`;
  }
}

export class ScreenshotConfig extends MediaBasedConfig {
  get_optional_start_args(identifier: string): string {
    if (identifier === 'active') return '';
    return `-d ${identifier}`;
  }
}

export class SurfaceFlingerDumpConfig extends TraceConfig {
  private static readonly COMMAND = `
cat << EOF >> ${PERFETTO_DUMP_CONFIG_FILE}
data_sources: {
    config {
        name: "android.surfaceflinger.layers"
        surfaceflinger_layers_config: {
            mode: MODE_DUMP
            trace_flags: TRACE_FLAG_INPUT
            trace_flags: TRACE_FLAG_COMPOSITION
            trace_flags: TRACE_FLAG_HWC
            trace_flags: TRACE_FLAG_BUFFERS
            trace_flags: TRACE_FLAG_VIRTUAL_DISPLAYS
        }
    }
}
EOF
`;

  add(_config: string, _value: string | string[] | null): void {}

  is_valid(_config: string): boolean {
    return false;
  }

  async execute_command(deviceId: string): Promise<void> {
    if (this.isPerfetto) {
      await this.runConfigScript(deviceId, SurfaceFlingerDumpConfig.COMMAND);
    }
  }
}
