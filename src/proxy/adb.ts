/**
 * Node re-implementation of the adb helpers from winscope_proxy.py.
 *
 * The Python proxy shells out to the `adb` binary in three ways:
 *   1. `call_adb(params, device)`  — one-shot command, stderr merged into the
 *      result/error (subprocess.check_output with stderr=STDOUT).
 *   2. `adb -s <device> shell`      — a long-lived shell whose stdin receives
 *      a multi-line trace/dump script (used by TraceSession / dump).
 *   3. `adb -s <device> exec-out`   — binary file extraction for /fetch/.
 *
 * The `adb` binary must be present on PATH; this is the one hard runtime
 * dependency that no re-implementation can remove.
 */

import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

/** Unsuccessful adb operation (mirrors winscope_proxy.py's AdbError). */
export class AdbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdbError';
  }
}

/** One-shot adb command; stderr is folded into the returned text on error. */
export async function callAdb(params: string, device?: string): Promise<string> {
  const args = ['adb', ...(device ? ['-s', device] : []), ...params.split(' ')];
  try {
    const {stdout} = await execFileAsync('adb', args.slice(1), {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {stdout?: string; stderr?: string};
    if (e.code === 'ENOENT') {
      throw new AdbError(
        `Error executing adb command: ${args.join(' ')}\n${e.message}`,
      );
    }
    throw new AdbError(
      `Error executing adb command: adb ${params}\n${e.stdout ?? ''}${e.stderr ?? ''}`,
    );
  }
}

/** Spawn a long-lived `adb -s <device> shell` for a trace/dump script. */
export function spawnAdbShell(deviceId: string): ChildProcess {
  return spawn('adb', ['-s', deviceId, 'shell'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Spawn `adb -s <device> exec-out <args...>` for binary file extraction. */
export function adbExecOut(deviceId: string, args: string[]): ChildProcess {
  return spawn('adb', ['-s', deviceId, 'exec-out', ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Run a (possibly multi-line) script on the device shell via stdin. */
export async function runShellScript(
  deviceId: string,
  script: string,
): Promise<{code: number | null; stdout: Buffer; stderr: Buffer}> {
  const child = spawnAdbShell(deviceId);
  const result = collectStdout(child);
  child.stdin!.write(script);
  child.stdin!.end();
  return result;
}

/** Collect a child's stdout (binary-safe) and resolve on close. */
export function collectStdout(
  child: ChildProcess,
): Promise<{code: number | null; stdout: Buffer; stderr: Buffer}> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on('data', (c: Buffer) => out.push(c));
    child.stderr!.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({code, stdout: Buffer.concat(out), stderr: Buffer.concat(err)}),
    );
  });
}
