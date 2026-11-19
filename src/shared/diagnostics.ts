// The diagnostics log, for finding what makes Senju hang or fail: the daemon,
// the main process and the window write an entry when they start (with the
// system they run on), when something took long (with what was going on at
// the time, such as the terminals that printed the most) and on errors. One
// JSON object per line in diagnostics.log; kept below a megabyte. Entries
// carry no terminal contents, user names or host names.

import fs from 'node:fs';
import os from 'node:os';
import { paths } from './paths';

export type DiagnosticSource = 'daemon' | 'main' | 'window';

const MAX_BYTES = 1_000_000;
/** The same error is logged once in this time, so an error repeated in a loop doesn't fill the log. */
const REPEAT_MS = 60_000;
const MB = 1024 * 1024;
let writing: Promise<void> = Promise.resolve();

/** How loaded the machine and the writing process are, added to every entry; the window reports its own memory. */
function load(source: DiagnosticSource): Record<string, unknown> {
  return {
    load: os.loadavg().map((n) => Math.round(n * 10) / 10),
    freeMemoryMB: Math.round(os.freemem() / MB),
    ...(source === 'window' ? {} : { processMemoryMB: Math.round(process.memoryUsage().rss / MB) }),
  };
}

/** Appends an entry in the background; a full log moves to diagnostics.log.1 first. */
export function diagnose(source: DiagnosticSource, event: string, details: Record<string, unknown> = {}): void {
  const line = `${JSON.stringify({ at: new Date().toISOString(), source, event, ...details, ...load(source) })}\n`;
  const file = paths.diagnosticsFile;
  writing = writing
    .then(async () => {
      const size = await fs.promises.stat(file).then((s) => s.size, () => 0);
      if (size + line.length > MAX_BYTES) await fs.promises.rename(file, `${file}.1`);
      await fs.promises.appendFile(file, line, { mode: 0o600 });
    })
    .catch(() => {});
}

/** The system a process runs on, for its start entry. */
export function systemInfo(): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    osVersion: os.version(),
    cpu: `${cpus.length} × ${cpus[0]?.model.trim() ?? 'unknown'}`,
    memoryMB: Math.round(os.totalmem() / MB),
    node: process.versions.node,
    electron: process.versions.electron,
    pid: process.pid,
  };
}

const lastErrors = new Map<string, number>();

/** Logs an error, once a minute at most for the same message. */
export function diagnoseError(source: DiagnosticSource, event: string, error: unknown, details: Record<string, unknown> = {}): void {
  const home = os.homedir();
  const hide = (text: string) => (home.length > 1 ? text.split(home).join('~') : text);
  // An Error, or one sent over IPC as a plain object.
  const err = typeof error === 'object' && error !== null && typeof (error as Error).message === 'string' ? (error as Partial<Error>) : null;
  const message = hide(err ? `${err.name ?? 'Error'}: ${err.message}` : String(error));
  const key = `${source} ${event} ${message}`;
  const now = Date.now();
  if (now - (lastErrors.get(key) ?? -Infinity) < REPEAT_MS) return;
  lastErrors.set(key, now);
  if (lastErrors.size > 100) lastErrors.delete(lastErrors.keys().next().value!);
  const stack = err?.stack ? hide(err.stack).split('\n').slice(1, 9).map((s) => s.trim()) : undefined;
  diagnose(source, event, { message, stack, ...details });
}

/**
 * Logs whenever this process's event loop was blocked for `thresholdMs` or
 * more, with `context()` describing what it was busy with.
 */
export function watchEventLoop(source: DiagnosticSource, thresholdMs: number, context: () => Record<string, unknown> = () => ({})): void {
  const tick = 100;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const blocked = now - last - tick;
    last = now;
    if (blocked >= thresholdMs) diagnose(source, 'event loop blocked', { ms: Math.round(blocked), ...context() });
  }, tick).unref();
}
