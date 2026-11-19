// A live terminal: a shell in a pseudo terminal mirrored into a headless xterm,
// which provides scrollback snapshots for reattaching UIs and for persistence.

import fs from 'node:fs';
import os from 'node:os';
import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { withoutAppImagePaths } from '../shared/env';
import { diagnose } from '../shared/diagnostics';
import type { Settings } from '../shared/settings';

export interface TerminalOptions {
  id: string;
  cwd: string;
  /** Variables added on top of the daemon environment. */
  env: Record<string, string>;
  cols: number;
  rows: number;
  settings: Settings;
  /** Scrollback from a previous run, shown above the new shell. */
  restoredScrollback?: string;
  /** Command typed into the shell once it is ready. */
  initialCommand?: string;
  onExit: () => void;
}

/** Serializing a screen slower than this is logged to diagnostics.log. */
const SLOW_SERIALIZE_MS = 100;

const restoredBanner = '\r\n\x1b[0m\x1b[2m──── restored ────\x1b[0m\r\n';

export function defaultShell(settings: Settings): { file: string; args: string[] } {
  if (settings.shell) return { file: settings.shell, args: settings.shellArgs ?? [] };
  if (process.platform === 'win32') return { file: process.env.COMSPEC?.includes('powershell') ? process.env.COMSPEC : 'powershell.exe', args: settings.shellArgs ?? [] };
  return { file: process.env.SHELL || '/bin/sh', args: settings.shellArgs ?? (process.platform === 'darwin' ? ['-l'] : []) };
}

/**
 * The daemon's own environment, without variables that only make sense for
 * Electron and without AppImage mounts, which a daemon started by an older
 * version may still have.
 */
export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('ELECTRON_') || key === 'CHROME_DESKTOP' || key === 'GOOGLE_API_KEY') continue;
    env[key] = value;
  }
  return withoutAppImagePaths(env);
}

/** Output within this time marks a program as busy rather than waiting. */
export const BUSY_MS = 1500;
/**
 * Output this soon after input or a resize is taken as the program echoing
 * keys or redrawing, not as work of its own.
 */
const ECHO_MS = 300;

export class TerminalSession {
  readonly id: string;
  readonly pty: pty.IPty;
  private readonly term: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly listeners = new Set<(data: string) => void>();
  /** Time of the last output, used to tell apart agents sharing a directory. */
  lastActivity = 0;
  /** Characters of output so far, for finding terminals that print the most. */
  outputBytes = 0;
  /** Time of the last output that was the program's own work, not an echo of input. */
  workedAt = 0;
  /** Called on every output counted as work. */
  onWork: (() => void) | null = null;
  private inputAt = 0;
  /** Output arrived since the scrollback was last persisted. */
  dirty = false;
  /** When the scrollback was last persisted. */
  persistedAt = 0;
  exited = false;
  exitStatus: { exitCode: number; signal?: number } | null = null;

  constructor(opts: TerminalOptions) {
    this.id = opts.id;
    this.term = new Terminal({ cols: opts.cols, rows: opts.rows, scrollback: opts.settings.scrollback, allowProposedApi: true });
    this.term.loadAddon(this.serializer);
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = '11';
    if (opts.restoredScrollback) {
      this.term.write(opts.restoredScrollback);
      this.term.write(restoredBanner);
    }

    const shell = defaultShell(opts.settings);
    const cwd = opts.cwd || os.homedir();
    // On Unix the shell changes into its folder itself, starting in the home
    // folder when that one is gone: a folder on a network share that stopped
    // answering then stalls only this shell, not the daemon with all terminals.
    const start =
      process.platform === 'win32'
        ? { file: shell.file, args: shell.args, cwd: fs.existsSync(cwd) ? cwd : os.homedir() }
        : { file: '/bin/sh', args: ['-c', 'cd -- "$0" 2>/dev/null; exec "$@"', cwd, shell.file, ...shell.args], cwd: os.homedir() };
    this.pty = pty.spawn(start.file, start.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: start.cwd,
      // Saved environments of terminals from older versions may still point into AppImage mounts.
      env: {
        ...withoutAppImagePaths({ ...baseEnv(), ...opts.env }),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'senju',
        SENJU_PANE_ID: opts.id,
      },
    });

    let pendingCommand = opts.initialCommand;
    this.pty.onData((data) => {
      const now = Date.now();
      this.lastActivity = now;
      this.outputBytes += data.length;
      // While busy every output counts, so typing ahead does not end the work.
      if (now - this.inputAt > ECHO_MS || now - this.workedAt < BUSY_MS) {
        this.workedAt = now;
        this.onWork?.();
      }
      this.dirty = true;
      this.term.write(data);
      for (const listener of this.listeners) listener(data);
      if (pendingCommand) {
        // Give the shell a moment to finish drawing its first prompt.
        const command = pendingCommand;
        pendingCommand = undefined;
        // Ctrl+U first clears what reached the line before the command (type-ahead,
        // mouse reports of a UI that still shows the previous program); Windows
        // shells do not treat it as a line kill.
        const clear = process.platform === 'win32' ? '' : '\x15';
        setTimeout(() => this.write(`${clear}${command}\r`), 300);
      }
    });
    this.pty.onExit((status) => {
      this.exited = true;
      this.exitStatus = status;
      opts.onExit();
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  write(data: string): void {
    if (this.exited) return;
    this.inputAt = Date.now();
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited || cols < 2 || rows < 1) return;
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.inputAt = Date.now();
    this.pty.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  /**
   * Subscribes to output. The callback first receives a full snapshot of the
   * screen, then every later chunk, with nothing lost or duplicated in between.
   */
  attach(onSnapshot: (data: string) => void, onData: (data: string) => void): () => void {
    let ready = false;
    const buffered: string[] = [];
    const listener = (data: string) => (ready ? onData(data) : buffered.push(data));
    this.listeners.add(listener);
    this.term.write('', () => {
      const started = performance.now();
      const snapshot = this.serializer.serialize();
      const ms = performance.now() - started;
      if (ms >= SLOW_SERIALIZE_MS) diagnose('daemon', 'slow snapshot', { terminal: this.id, ms: Math.round(ms), kb: Math.round(snapshot.length / 1024) });
      onSnapshot(snapshot);
      for (const chunk of buffered) onData(chunk);
      buffered.length = 0;
      ready = true;
    });
    return () => this.listeners.delete(listener);
  }

  /** Scrollback for persistence: the normal buffer only, without terminal modes. */
  persistedScrollback(lines: number): Promise<string> {
    return new Promise((resolve) => {
      this.term.write('', () => {
        this.dirty = false;
        this.persistedAt = Date.now();
        const started = performance.now();
        const scrollback = this.serializer.serialize({ scrollback: lines, excludeAltBuffer: true, excludeModes: true });
        const ms = performance.now() - started;
        if (ms >= SLOW_SERIALIZE_MS) diagnose('daemon', 'slow scrollback save', { terminal: this.id, ms: Math.round(ms), kb: Math.round(scrollback.length / 1024) });
        resolve(scrollback);
      });
    });
  }

  kill(): void {
    if (this.exited) return;
    try {
      this.pty.kill();
    } catch {
      // Already gone.
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.kill();
    this.term.dispose();
  }
}
