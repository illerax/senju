// Connection from the Electron main process to the daemon. Starts the daemon
// when it is not running and replaces it when its protocol is incompatible.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION, type ClientMessage, type DaemonMessage } from '../shared/protocol';
import { BUILD_ID } from '../shared/build';
import { paths } from '../shared/paths';
import type { DaemonLauncher } from './daemon-runtime';

function connectOnce(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(paths.socket);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

const LOG_MAX_BYTES = 1_000_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startDaemon(launch: () => Promise<DaemonLauncher>): Promise<void> {
  const { executable, script, env } = await launch();
  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true });
  // Each daemon appends to the log; the previous megabyte is kept in daemon.log.1.
  try {
    if (fs.statSync(paths.logFile).size > LOG_MAX_BYTES) fs.renameSync(paths.logFile, `${paths.logFile}.1`);
  } catch {
    // No log yet.
  }
  const log = fs.openSync(paths.logFile, 'a', 0o600);
  const child = spawn(executable, [script], {
    detached: true,
    // Not the app's own folder: inside an AppImage that is its mount, which must be able to go away.
    cwd: os.homedir(),
    stdio: ['ignore', log, log],
    env,
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);
}

/** The user chose not to restart an incompatible daemon. */
export class DaemonReplaceDeclined extends Error {
  constructor() {
    super('the user kept the running background service');
  }
}

export interface DaemonClientEvents {
  message: [DaemonMessage];
  /** A new connection was established; panes must be attached again. */
  connected: [];
  /** The user kept an incompatible daemon running; this UI cannot use it. */
  declined: [];
}

export class DaemonClient extends EventEmitter<DaemonClientEvents> {
  private socket: net.Socket | null = null;
  private closing = false;
  private daemonBuild = '';

  constructor(
    private readonly launch: () => Promise<DaemonLauncher>,
    /** Asked before an incompatible daemon is replaced, which restarts the user's programs. */
    private readonly confirmReplace: () => Promise<boolean>,
  ) {
    super();
  }

  async connect(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const socket = await this.open();
      const hello = await this.handshake(socket);
      if (hello.protocol === PROTOCOL_VERSION) {
        this.daemonBuild = hello.build;
        this.adopt(socket);
        return;
      }
      if (attempt > 0) throw new Error(`daemon speaks protocol ${hello.protocol}, expected ${PROTOCOL_VERSION}`);
      // An older or newer daemon: with the user's consent, ask it to save and stop, then start ours.
      if (!(await this.confirmReplace())) {
        socket.destroy();
        throw new DaemonReplaceDeclined();
      }
      socket.write(`${JSON.stringify({ type: 'shutdown' } satisfies ClientMessage)}\n`);
      socket.resume();
      await new Promise((resolve) => socket.once('close', resolve));
    }
  }

  private async open(): Promise<net.Socket> {
    try {
      return await connectOnce();
    } catch {
      await startDaemon(this.launch);
    }
    for (let i = 0; i < 100; i++) {
      await delay(100);
      try {
        return await connectOnce();
      } catch {
        // Daemon still starting.
      }
    }
    throw new Error(`could not start the daemon; see ${paths.logFile}`);
  }

  private handshake(socket: net.Socket): Promise<{ protocol: number; build: string }> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        // Pause so nothing is lost before the next listener is attached.
        socket.pause();
        socket.off('data', onData);
        const rest = buffer.slice(newline + 1);
        const msg = JSON.parse(buffer.slice(0, newline)) as DaemonMessage;
        if (rest) socket.unshift(Buffer.from(rest, 'utf8'));
        resolve(msg.type === 'hello' ? { protocol: msg.protocol, build: msg.build ?? '' } : { protocol: -1, build: '' });
      };
      socket.on('data', onData);
      socket.once('error', reject);
      socket.write(`${JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION } satisfies ClientMessage)}\n`);
    });
  }

  private adopt(socket: net.Socket): void {
    this.socket = socket;
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.emit('message', JSON.parse(line) as DaemonMessage);
      }
    });
    socket.resume();
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.socket = null;
      if (!this.closing) void this.reconnect();
    });
    this.emit('connected');
  }

  /** The daemon died (crash or kill): start a new one, which restores the panes. */
  private async reconnect(): Promise<void> {
    while (!this.closing) {
      try {
        await this.connect();
        return;
      } catch (err) {
        if (err instanceof DaemonReplaceDeclined) {
          this.closing = true;
          this.emit('declined');
          return;
        }
        await delay(1000);
      }
    }
  }

  /**
   * The daemon runs code from another build than this UI. It keeps running
   * after an update so processes survive; restarting it applies the update.
   */
  get outdated(): boolean {
    return this.daemonBuild !== BUILD_ID;
  }

  /** Stops the daemon, saving everything, and starts a new one from the current build. */
  restartDaemon(): void {
    this.send({ type: 'shutdown' });
  }

  send(msg: ClientMessage): void {
    this.socket?.write(`${JSON.stringify(msg)}\n`);
  }

  /** Disconnects; the daemon and its processes keep running. */
  close(): void {
    this.closing = true;
    this.socket?.end();
  }

  /** Stops the daemon and every pane process. */
  stopDaemon(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => {
      socket.once('close', () => resolve());
      this.send({ type: 'shutdown' });
    });
  }
}
