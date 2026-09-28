/**
 * Trace session keep-alive model, translated from winscope_proxy.py's
 * TraceThread + TRACE_THREADS.
 *
 * A session owns one long-lived `adb -s <device> shell` process whose stdin is
 * fed the start script (a `trap stop_trace ...; while true; do sleep; done`
 * shell). The browser pings /status/ roughly every second; if no ping arrives
 * within KEEP_ALIVE_INTERVAL_S the session self-terminates via SIGINT.
 */

import type {ChildProcess} from 'node:child_process';
import {callAdb, spawnAdbShell} from './adb';
import {COMMAND_TIMEOUT_S, KEEP_ALIVE_INTERVAL_S} from './config';

const RETRY_INTERVAL_S = 0.1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TraceSession {
  private readonly child: ChildProcess;
  private readonly deviceId: string;
  readonly traceName: string;
  readonly statusFilename: string;
  private keepAliveTimer: NodeJS.Timeout | undefined;
  private exited = false;
  private exitResolve: (() => void) | undefined;
  private readonly exitPromise: Promise<void>;
  private cleanupResolve: (() => void) | undefined;
  private readonly cleanupPromise: Promise<void>;
  private _success = false;
  private _timedOut = false;
  private _stdout: Buffer = Buffer.alloc(0);
  private _stderr: Buffer = Buffer.alloc(0);
  readonly traceIdentifier: string;

  constructor(
    deviceId: string,
    traceName: string,
    command: Buffer,
    traceIdentifier: string,
    statusFilename: string,
  ) {
    this.deviceId = deviceId;
    this.traceName = traceName;
    this.traceIdentifier = traceIdentifier;
    this.statusFilename = statusFilename;

    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });

    this.cleanupPromise = new Promise<void>((resolve) => {
      this.cleanupResolve = resolve;
    });

    this.child = spawnAdbShell(deviceId);
    this.child.stdout!.on('data', (c: Buffer) => {
      this._stdout = Buffer.concat([this._stdout, c]);
    });
    this.child.stderr!.on('data', (c: Buffer) => {
      this._stderr = Buffer.concat([this._stderr, c]);
    });
    this.child.on('close', () => {
      this.exited = true;
      this.exitResolve?.();
      void this.onExit();
    });

    this.child.stdin!.write(command);
    this.child.stdin!.end();
    this.resetTimer();
  }

  isAlive(): boolean {
    return !this.exited;
  }

  success(): boolean {
    return this._success;
  }

  timedOut(): boolean {
    return this._timedOut;
  }

  stdout(): Buffer {
    return this._stdout;
  }

  stderr(): Buffer {
    return this._stderr;
  }

  resetTimer(): void {
    if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = setTimeout(() => {
      void this.onKeepAliveTimeout();
    }, KEEP_ALIVE_INTERVAL_S * 1000);
  }

  private async onKeepAliveTimeout(): Promise<void> {
    if (!this.exited) await this.end();
  }

  async end(): Promise<void> {
    if (this.keepAliveTimer) {
      clearTimeout(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
    if (this.exited) return;
    // Trigger the shell HUP handler so stop_trace runs before we tear down the
    // process on Windows, where SIGINT is unreliable.
    this.child.stdin?.destroy();
    await sleep(200);
    this.child.kill('SIGTERM');
    await Promise.race([this.exitPromise, sleep(COMMAND_TIMEOUT_S * 1000)]);
    if (!this.exited) {
      this.child.kill('SIGKILL');
      await this.exitPromise;
    }
    // Make sure cleanup status polling has finished before caller moves files.
    await Promise.race([this.cleanupPromise, sleep(COMMAND_TIMEOUT_S * 1000)]);
  }

  private async onExit(): Promise<void> {
    try {
      await sleep(0.2);
      for (let i = 0; i < COMMAND_TIMEOUT_S / RETRY_INTERVAL_S; i++) {
        try {
          const status = await callAdb(
            `shell su root cat ${this.statusFilename}`,
            this.deviceId,
          );
          if (this.isStatusOk(status)) {
            this.evaluateSuccess(status);
            return;
          }
        } catch {
          // status file may not exist yet; retry
        }
        await sleep(RETRY_INTERVAL_S * 1000);
      }
      this._timedOut = true;
    } finally {
      this.cleanupResolve?.();
    }
  }

  private isStatusOk(status: string): boolean {
    return status.includes('OK');
  }

  private evaluateSuccess(_status: string): void {
    if (this.traceName === 'screen_recording') {
      const err = this._stderr.toString('utf8');
      this._success =
        err.length === 0 ||
        err.includes('err=-22') ||
        err.includes('mali_kbase');
      return;
    }
    if (this.traceName === 'perfetto_trace') {
      this._success = true;
      return;
    }
    this._success = this._stderr.length === 0;
  }
}

export class TraceSessionManager {
  private readonly sessions = new Map<string, TraceSession[]>();

  has(deviceId: string): boolean {
    return this.sessions.has(deviceId);
  }

  get(deviceId: string): TraceSession[] | undefined {
    return this.sessions.get(deviceId);
  }

  add(deviceId: string, session: TraceSession): void {
    const list = this.sessions.get(deviceId);
    if (list) list.push(session);
    else this.sessions.set(deviceId, [session]);
  }

  delete(deviceId: string): void {
    this.sessions.delete(deviceId);
  }

  resetTimers(deviceId: string): void {
    for (const session of this.sessions.get(deviceId) ?? []) {
      session.resetTimer();
    }
  }
}
