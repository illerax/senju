// Watches the window for slow moments and errors and reports them to
// diagnostics.log through the main process (shared/diagnostics.ts): long tasks,
// slow switches, terminals whose output piles up, slow snapshots and uncaught
// errors. Each report carries what happened in the seconds before it and the
// terminals that printed the most.

import { senju } from './api';

const LONG_TASK_MS = 200;
const SLOW_SWITCH_MS = 300;
const SLOW_SNAPSHOT_MS = 200;
/** Output that waits this long before xterm has parsed it means the terminal falls behind. */
const BEHIND_MS = 1000;
/** A visible window that shows no new frame for this long has stalled, whatever the cause (script, layout, GPU). */
const FRAME_STALL_MS = 500;
const RECENT_MS = 5000;

const recent: { at: number; what: string }[] = [];
/** Characters received per terminal, per second, for the last seconds. */
const output: Map<string, number>[] = [new Map()];
let describe: (terminalId: string) => string = (id) => id;

/** Sets how reports name a terminal, e.g. by its tab label. */
export function nameTerminals(name: (terminalId: string) => string): void {
  describe = (id) => `${id} ${name(id)}`;
}

export function terminalName(terminalId: string): string {
  return describe(terminalId);
}

/** Remembers something that happened, to explain a slow moment that follows. */
export function note(what: string): void {
  const now = performance.now();
  recent.push({ at: now, what });
  while (recent.length && now - recent[0].at > RECENT_MS) recent.shift();
}

export function countOutput(terminalId: string, chars: number): void {
  const second = output[output.length - 1];
  second.set(terminalId, (second.get(terminalId) ?? 0) + chars);
}

/** The window's JavaScript memory (a Chromium extension of `performance`). */
function heapMB(): number | undefined {
  const used = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  return used === undefined ? undefined : Math.round(used / 1024 / 1024);
}

function context(): Record<string, unknown> {
  const now = performance.now();
  const total = new Map<string, number>();
  for (const second of output) for (const [id, n] of second) total.set(id, (total.get(id) ?? 0) + n);
  const busiest = [...total]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, n]) => ({ terminal: describe(id), kbPerSecond: Math.round(n / output.length / 1024) }));
  return { before: recent.filter((r) => now - r.at <= RECENT_MS).map((r) => `-${Math.round(now - r.at)}ms ${r.what}`), busiest, heapMB: heapMB() };
}

export function report(event: string, details: Record<string, unknown>): void {
  senju.diagnose(event, { ...details, ...context() });
}

/** Measures from now to the frame that shows a switch; reports it when slow. */
export function measureSwitch(what: string, since = performance.now()): void {
  note(what);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const ms = performance.now() - since;
      if (ms >= SLOW_SWITCH_MS) report('slow switch', { what, ms: Math.round(ms) });
    }),
  );
}

/** Times how long xterm takes to parse a snapshot; reports it when slow. */
export function snapshotTimer(terminalId: string, chars: number): () => void {
  const started = performance.now();
  note(`snapshot ${describe(terminalId)} ${Math.round(chars / 1024)}KB`);
  return () => {
    const ms = performance.now() - started;
    if (ms >= SLOW_SNAPSHOT_MS) report('slow snapshot', { terminal: describe(terminalId), ms: Math.round(ms), kb: Math.round(chars / 1024) });
  };
}

const behindReported = new Map<string, number>();

/** Times output from its arrival until xterm parsed it; reports a terminal that falls behind, at most every 10s. */
export function outputTimer(terminalId: string): () => void {
  const queued = performance.now();
  return () => {
    const now = performance.now();
    const ms = now - queued;
    if (ms < BEHIND_MS || now - (behindReported.get(terminalId) ?? -Infinity) < 10_000) return;
    behindReported.set(terminalId, now);
    report('terminal behind', { terminal: describe(terminalId), ms: Math.round(ms) });
  };
}

function reportError(event: string, error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error));
  senju.diagnoseError(event, { name: e.name, message: e.message, stack: e.stack, heapMB: heapMB() });
}

export function startPerfMonitor(): void {
  window.addEventListener('error', (e) => reportError('uncaught exception', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('unhandled rejection', e.reason));
  setInterval(() => {
    output.push(new Map());
    if (output.length > RECENT_MS / 1000) output.shift();
  }, 1000);
  // A few times a second, see how late the timer came (the script was busy) and
  // ask for a frame to see how long it takes to come (nothing was drawn).
  const tick = 250;
  let last = performance.now();
  let lastAlive = 0;
  setInterval(() => {
    const asked = performance.now();
    const blocked = asked - last - tick;
    last = asked;
    if (blocked >= LONG_TASK_MS) report('blocked', { ms: Math.round(blocked) });
    if (asked - lastAlive >= 1000) {
      // Tells the main process this window still runs, so it can log one that hangs for good.
      lastAlive = asked;
      senju.alive(document.visibilityState === 'visible');
    }
    if (document.visibilityState !== 'visible') return;
    requestAnimationFrame(() => {
      const ms = performance.now() - asked;
      if (ms >= FRAME_STALL_MS && document.visibilityState === 'visible') report('no frames', { ms: Math.round(ms) });
    });
  }, tick);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.duration >= LONG_TASK_MS) report('long task', { ms: Math.round(entry.duration) });
    }).observe({ type: 'longtask' });
  } catch {
    // Long tasks are not observable here.
  }
}
