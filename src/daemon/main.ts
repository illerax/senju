// The Senju daemon. Owns every terminal process and the persistent state, so
// programs keep running while the UI is closed, crashes or gets updated.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION, type Action, type ClientMessage, type DaemonMessage } from '../shared/protocol';
import { BUILD_ID } from '../shared/build';
import { paths } from '../shared/paths';
import { loadSettings, type Settings } from '../shared/settings';
import type { AppState, JobState, TerminalState } from '../shared/types';
import { baseEnv, BUSY_MS, TerminalSession } from './terminal';
import { inspectTerminals, type ProcessInfo } from './procinfo';
import { listSessions, loadRecipes, matchRecipe, requiredFiles, sessionFromArgs, sessionFromPidFile, type Recipe } from './recipes';
import { planRestore } from './restore';
import { envDiff } from './shellquote';
import { deleteScrollback, loadState, pruneScrollback, readScrollback, saveState, saveStateAsync, writeScrollback, writeScrollbackSync } from './store';
import { applyAction, closeTerminal, type Effects } from './workspace';
import { terminalIds } from '../shared/layout';

const POLL_MS = 1000;
const SESSION_POLL_MS = 2000;
/** How often one terminal's scrollback may be saved; one at a time keeps each pause short. */
const SCROLLBACK_TICK_MS = 3000;
/** Minimum age of a saved scrollback before it is saved again, for quiet and for busy terminals. */
const SCROLLBACK_QUIET_MS = 15000;
const SCROLLBACK_BUSY_MS = 60000;
/** How long a vanished job or shell is kept, so processes killed by a shutdown are still restored. */
const EXIT_GRACE_MS = 3000;

/** Runs a periodic task, starting the next run only after the previous one has finished. */
function repeat(task: () => Promise<void>, ms: number): void {
  const next = () => setTimeout(() => void task().catch((err) => log('periodic task failed', err)).finally(next), ms);
  next();
}

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

class Client {
  private buffer = '';
  private pendingData = new Map<string, string>();
  private flushTimer: NodeJS.Timeout | null = null;
  readonly detach = new Map<string, () => void>();

  constructor(
    readonly socket: net.Socket,
    onMessage: (client: Client, msg: ClientMessage) => void,
    onClose: (client: Client) => void,
  ) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          onMessage(this, JSON.parse(line));
        } catch (err) {
          log('bad message', err);
        }
      }
    });
    socket.on('close', () => onClose(this));
    socket.on('error', () => socket.destroy());
  }

  send(msg: DaemonMessage): void {
    if (!this.socket.destroyed) this.socket.write(`${JSON.stringify(msg)}\n`);
  }

  /** Coalesces terminal output into fewer, larger messages. */
  sendData(terminalId: string, data: string): void {
    this.pendingData.set(terminalId, (this.pendingData.get(terminalId) ?? '') + data);
    this.flushTimer ??= setTimeout(() => this.flush(), 4);
  }

  flush(): void {
    this.flushTimer = null;
    for (const [terminalId, data] of this.pendingData) this.send({ type: 'data', terminalId, data });
    this.pendingData.clear();
  }
}

interface Tracked {
  /** Pid of the current job leader. */
  jobPid?: number;
  /** Pid of the process a recipe matched, which may be a child of the leader. */
  agentPid?: number;
  jobGone?: NodeJS.Timeout;
  /** Ends the busy state once the job has been quiet for BUSY_MS. */
  quiet?: NodeJS.Timeout;
  shellEnv?: Record<string, string>;
}

class Daemon {
  private state: AppState;
  private settings: Settings = loadSettings();
  private recipes: Recipe[] = loadRecipes(paths.recipesDir);
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly clients = new Set<Client>();
  private readonly env = baseEnv();
  private server: net.Server | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private lastBroadcast = '';
  private shuttingDown = false;
  private persisting = false;
  private saving = false;
  private savePromise: Promise<void> = Promise.resolve();
  private saveAgain = false;

  constructor() {
    this.state = loadState(paths.stateFile);
  }

  async start(): Promise<void> {
    this.repairState();
    pruneScrollback(paths.stateFile, new Set(Object.keys(this.state.terminals)));
    const jobCwds = Object.values(this.state.terminals).flatMap((t) => (t.job ? [t.job.cwd] : []));
    const present = await requiredFiles(this.recipes, jobCwds);
    for (const id of Object.keys(this.state.terminals)) this.spawn(id, true, present);
    this.saveNow();
    this.listen();
    repeat(() => this.pollProcesses(), POLL_MS);
    repeat(() => this.pollSessions(), SESSION_POLL_MS);
    repeat(() => this.persistScrollback(), SCROLLBACK_TICK_MS);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      process.on(signal, () => void this.shutdown(false));
    }
    log(`daemon ${process.pid} started with ${this.sessions.size} terminals`);
  }

  /** Drops terminals that no tab refers to and fills in terminals a tab refers to but lacks. */
  private repairState(): void {
    const used = new Set<string>();
    for (const group of this.state.groups) {
      for (const workspace of group.workspaces) {
        for (const id of terminalIds(workspace.root)) {
          used.add(id);
          this.state.terminals[id] ??= { id, cwd: group.cwd || os.homedir(), cols: 80, rows: 24, env: {} };
        }
      }
    }
    for (const id of Object.keys(this.state.terminals)) if (!used.has(id)) delete this.state.terminals[id];
  }

  private spawn(terminalId: string, restoring: boolean, present?: ReadonlySet<string>): void {
    const terminal = this.state.terminals[terminalId];
    if (!terminal) return;
    let command: string | undefined;
    let env = terminal.env;
    if (restoring) {
      const plan = planRestore(terminal, this.recipes, this.settings.autoRestart, this.env, present);
      command = plan.command;
      env = { ...terminal.env, ...plan.env };
      terminal.pending = plan.pending;
      terminal.job = undefined;
    }
    const session = new TerminalSession({
      id: terminalId,
      cwd: terminal.cwd,
      env,
      cols: terminal.cols || 80,
      rows: terminal.rows || 24,
      settings: this.settings,
      restoredScrollback: restoring ? readScrollback(paths.stateFile, terminalId) : undefined,
      initialCommand: command,
      onExit: () => this.onShellExit(terminalId, session),
    });
    session.onWork = () => {
      const job = this.state.terminals[terminalId]?.job;
      if (job && !this.state.terminals[terminalId].busy && this.sessions.get(terminalId) === session) {
        this.setBusy(terminalId, session, true);
        this.changed();
      }
    };
    this.sessions.set(terminalId, session);
    this.tracked.set(terminalId, {});
    if (command) log(`terminal ${terminalId}: restoring with \`${command}\``);
  }

  private onShellExit(terminalId: string, session: TerminalSession): void {
    if (this.shuttingDown || this.sessions.get(terminalId) !== session) return;
    // A shell that the user exited is closed now; one killed by a signal may be
    // part of a system shutdown and is closed only if the daemon survives.
    const remove = () => {
      if (this.shuttingDown || this.sessions.get(terminalId) !== session) return;
      this.disposeSession(terminalId);
      const effects: Effects = { created: [], removed: [] };
      closeTerminal(this.state, terminalId, effects);
      this.applyEffects(effects);
      this.changed();
    };
    const status = session.exitStatus;
    if (status && (status.signal || status.exitCode >= 128)) setTimeout(remove, EXIT_GRACE_MS);
    else remove();
  }

  private disposeSession(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    this.sessions.delete(terminalId);
    const tracked = this.tracked.get(terminalId);
    if (tracked?.jobGone) clearTimeout(tracked.jobGone);
    if (tracked?.quiet) clearTimeout(tracked.quiet);
    this.tracked.delete(terminalId);
    for (const client of this.clients) {
      client.detach.get(terminalId)?.();
      client.detach.delete(terminalId);
    }
    session.dispose();
    deleteScrollback(paths.stateFile, terminalId);
  }

  private applyEffects(effects: Effects): void {
    for (const id of effects.removed) this.disposeSession(id);
    for (const id of effects.created) this.spawn(id, false);
  }

  private handleAction(action: Action): void {
    if (action.type === 'runPending' || action.type === 'dismissPending') {
      const terminal = this.state.terminals[action.terminalId];
      const pending = terminal?.pending;
      if (!terminal || !pending) return;
      terminal.pending = undefined;
      if (action.type === 'runPending') this.sessions.get(action.terminalId)?.write(`${pending.command}\r`);
    } else {
      this.applyEffects(applyAction(this.state, action, os.homedir()));
    }
    this.changed();
  }

  // --- process tracking ---

  private async pollProcesses(): Promise<void> {
    if (this.shuttingDown) return;
    let changed = false;
    const sessions = [...this.sessions].filter(([terminalId, session]) => !session.exited && this.state.terminals[terminalId] && this.tracked.has(terminalId));
    const infos = await inspectTerminals(sessions.map(([, session]) => session.pid));
    await Promise.all(
      sessions.map(async ([terminalId, session]) => {
        const terminal = this.state.terminals[terminalId];
        const tracked = this.tracked.get(terminalId);
        const info = infos.get(session.pid);
        if (!terminal || !tracked || !info) return;
        if (this.shuttingDown || this.sessions.get(terminalId) !== session) return;

        if (info.shellCwd && info.shellCwd !== terminal.cwd) {
          terminal.cwd = info.shellCwd;
          changed = true;
        }
        if (info.shellEnv && !tracked.shellEnv) {
          tracked.shellEnv = info.shellEnv;
          terminal.env = envDiff(info.shellEnv, this.env);
          changed = true;
        }

        const busy = info.job ? Date.now() - session.workedAt < BUSY_MS : undefined;
        if (terminal.busy !== busy) {
          this.setBusy(terminalId, session, busy);
          changed = true;
        }

        if (info.job) {
          if (tracked.jobGone) {
            clearTimeout(tracked.jobGone);
            tracked.jobGone = undefined;
          }
          if (tracked.jobPid !== info.job.pid || !terminal.job) {
            tracked.jobPid = info.job.pid;
            const { job, pid } = await this.describeJob(info.job, info.jobChildren, tracked.shellEnv ?? info.shellEnv);
            if (this.shuttingDown || this.sessions.get(terminalId) !== session || tracked.jobPid !== info.job.pid) return;
            terminal.job = job;
            tracked.agentPid = pid;
            terminal.pending = undefined;
            changed = true;
          } else if (terminal.job && !terminal.job.recipe) {
            // The leader may exec into another program, or start an agent as a child.
            const { job, pid } = await this.describeJob(info.job, info.jobChildren, tracked.shellEnv ?? info.shellEnv);
            if (this.shuttingDown || this.sessions.get(terminalId) !== session || !terminal.job) return;
            if (job.recipe || job.argv.join('\0') !== terminal.job.argv.join('\0')) {
              terminal.job = { ...job, startedAt: terminal.job.startedAt };
              tracked.agentPid = pid;
              changed = true;
            }
          }
        } else if (terminal.job && !tracked.jobGone) {
          tracked.jobGone = setTimeout(() => {
            tracked.jobGone = undefined;
            if (this.shuttingDown || this.sessions.get(terminalId) !== session) return;
            terminal.job = undefined;
            tracked.jobPid = undefined;
            tracked.agentPid = undefined;
            this.changed();
          }, EXIT_GRACE_MS);
        }
      }),
    );
    if (changed) this.changed();
  }

  /**
   * Marks a job as busy or waiting. A busy job is marked waiting as soon as it
   * has been quiet for BUSY_MS, not at the next poll.
   */
  private setBusy(terminalId: string, session: TerminalSession, busy: boolean | undefined): void {
    const terminal = this.state.terminals[terminalId];
    const tracked = this.tracked.get(terminalId);
    if (!terminal || !tracked) return;
    terminal.busy = busy;
    if (tracked.quiet) clearTimeout(tracked.quiet);
    tracked.quiet = undefined;
    if (!busy) return;
    const check = () => {
      tracked.quiet = undefined;
      if (this.shuttingDown || this.sessions.get(terminalId) !== session || !terminal.busy) return;
      const left = session.workedAt + BUSY_MS - Date.now();
      if (left > 0) {
        tracked.quiet = setTimeout(check, left);
        return;
      }
      terminal.busy = false;
      this.changed();
    };
    tracked.quiet = setTimeout(check, Math.max(0, session.workedAt + BUSY_MS - Date.now()));
  }

  private async describeJob(leader: ProcessInfo, children: ProcessInfo[], shellEnv: Record<string, string> | null | undefined) {
    const cwd = leader.cwd ?? '';
    const candidates = [leader, ...children];
    const present = await requiredFiles(this.recipes, candidates.map((c) => c.cwd ?? cwd));
    let target = leader;
    let recipe: Recipe | null = null;
    for (const candidate of candidates) {
      recipe = matchRecipe(this.recipes, candidate.argv, candidate.cwd ?? cwd, present);
      if (recipe) {
        target = candidate;
        break;
      }
    }
    const env = target.env && shellEnv ? envDiff(target.env, shellEnv) : {};
    const job: JobState = {
      argv: recipe ? target.argv : leader.argv,
      cwd: target.cwd ?? cwd,
      env,
      startedAt: Date.now(),
      recipe: recipe?.name,
      sessionId: recipe ? (sessionFromArgs(recipe, target.argv) ?? undefined) : undefined,
    };
    return { job, pid: target.pid };
  }

  /**
   * Finds the session of every agent terminal. The agent's per-process file is
   * exact when the recipe has one. Otherwise each terminal claims the newest
   * session file written after its agent started that no other terminal holds;
   * with several agents in one directory, the file goes to the terminal whose
   * output coincides with the file's last write.
   */
  private async pollSessions(): Promise<void> {
    if (this.shuttingDown) return;
    let changed = false;
    const groups = new Map<string, { recipe: Recipe; cwd: string; env: Record<string, string>; terminals: TerminalState[] }>();
    for (const terminal of Object.values(this.state.terminals)) {
      const job = terminal.job;
      const recipe = job?.recipe ? this.recipes.find((r) => r.name === job.recipe) : undefined;
      if (!job || !recipe) continue;
      const env = { ...this.env, ...terminal.env, ...job.env };
      const pid = this.tracked.get(terminal.id)?.agentPid;
      const exact = await sessionFromPidFile(recipe, { cwd: job.cwd, env, pid });
      if (exact) {
        if (terminal.job === job && job.sessionId !== exact) {
          job.sessionId = exact;
          changed = true;
        }
        continue;
      }
      if (!recipe.session?.files) continue;
      const key = `${recipe.name}\0${job.cwd}\0${env.CLAUDE_CONFIG_DIR ?? ''}\0${env.CODEX_HOME ?? ''}`;
      const group = groups.get(key) ?? { recipe, cwd: job.cwd, env, terminals: [] };
      group.terminals.push(terminal);
      groups.set(key, group);
    }

    for (const { recipe, cwd, env, terminals } of groups.values()) {
      const since = Math.min(...terminals.map((p) => p.job!.startedAt)) - 5000;
      const files = await listSessions(recipe, { cwd, env }, since);
      if (files.length === 0) continue;
      const claimed = new Set(terminals.map((p) => p.job!.sessionId).filter(Boolean));
      const activity = (p: TerminalState) => this.sessions.get(p.id)?.lastActivity ?? 0;
      const byActivity = [...terminals].sort((a, b) => activity(b) - activity(a));

      for (const terminal of byActivity) {
        const job = terminal.job!;
        const current = files.find((f) => f.id === job.sessionId);
        const candidates = files.filter((f) => !claimed.has(f.id) && f.mtime >= job.startedAt - 2000);
        const fits = (mtime: number) => terminals.length === 1 || Math.abs(mtime - activity(terminal)) < 3000;
        // A newer file than the current session means the agent switched (e.g. /clear or /resume).
        const pick = candidates.find((f) => fits(f.mtime) && (!current || f.mtime > current.mtime + 1000));
        if (pick && (!job.sessionId || !current || Date.now() - current.mtime > 2000)) {
          if (job.sessionId) claimed.delete(job.sessionId);
          job.sessionId = pick.id;
          claimed.add(pick.id);
          changed = true;
        }
      }
    }
    if (changed) this.changed();
  }

  /**
   * Saves the scrollback of one terminal per tick: the one saved longest ago
   * among those with new output. Serializing a long scrollback takes tens of
   * milliseconds, so terminals that keep printing are saved less often.
   */
  private async persistScrollback(): Promise<void> {
    if (this.shuttingDown || this.persisting) return;
    const now = Date.now();
    let pick: [string, TerminalSession] | null = null;
    for (const entry of this.sessions) {
      const session = entry[1];
      if (!session.dirty) continue;
      const busy = now - session.lastActivity < 2000;
      if (now - session.persistedAt < (busy ? SCROLLBACK_BUSY_MS : SCROLLBACK_QUIET_MS)) continue;
      if (!pick || session.persistedAt < pick[1].persistedAt) pick = entry;
    }
    if (!pick) return;
    const [terminalId, session] = pick;
    this.persisting = true;
    try {
      const data = await session.persistedScrollback(this.settings.persistedScrollback);
      if (this.sessions.get(terminalId) === session && !this.shuttingDown) await writeScrollback(paths.stateFile, terminalId, data);
    } catch (err) {
      log('failed to save scrollback', err);
    } finally {
      this.persisting = false;
    }
  }

  // --- state distribution ---

  /** Publishes the state to clients and saves it. */
  private changed(): void {
    const view = this.viewState();
    const json = JSON.stringify(view);
    if (json !== this.lastBroadcast) {
      this.lastBroadcast = json;
      for (const client of this.clients) client.send({ type: 'state', state: view });
    }
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 50);
  }

  private viewState(): AppState {
    const terminals: AppState['terminals'] = {};
    for (const [id, terminal] of Object.entries(this.state.terminals)) {
      terminals[id] = { ...terminal, env: {}, job: terminal.job && { ...terminal.job, env: {} } };
    }
    return { ...this.state, terminals };
  }

  /** Saves in the background; changes made while a save runs are written right after it. */
  private save(): void {
    // Shutdown writes the final state itself.
    if (this.shuttingDown) return;
    if (this.saving) {
      this.saveAgain = true;
      return;
    }
    this.saving = true;
    this.savePromise = saveStateAsync(paths.stateFile, this.state)
      .catch((err) => log('failed to save state', err))
      .finally(() => {
        this.saving = false;
        if (this.saveAgain && !this.shuttingDown) {
          this.saveAgain = false;
          this.save();
        }
      });
  }

  /** Blocking save for startup and shutdown, when nothing else must run first. */
  private saveNow(): void {
    try {
      saveState(paths.stateFile, this.state);
    } catch (err) {
      log('failed to save state', err);
    }
  }

  // --- clients ---

  private listen(): void {
    const socketPath = paths.socket;
    if (process.platform !== 'win32') fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    const server = net.createServer((socket) => {
      const client = new Client(socket, (c, msg) => this.onMessage(c, msg), (c) => this.onClose(c));
      this.clients.add(client);
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      log('server error', err);
      process.exit(1);
    });
    server.listen(socketPath, () => {
      if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
    });
    this.server = server;
  }

  private onClose(client: Client): void {
    for (const detach of client.detach.values()) detach();
    this.clients.delete(client);
  }

  private onMessage(client: Client, msg: ClientMessage): void {
    switch (msg.type) {
      case 'hello':
        client.send({ type: 'hello', protocol: PROTOCOL_VERSION, pid: process.pid, build: BUILD_ID });
        client.send({ type: 'state', state: this.viewState() });
        break;
      case 'action':
        this.handleAction(msg.action);
        break;
      case 'attach': {
        const session = this.sessions.get(msg.terminalId);
        if (!session || client.detach.has(msg.terminalId)) return;
        const detach = session.attach(
          (data) => client.send({ type: 'snapshot', terminalId: msg.terminalId, data }),
          (data) => client.sendData(msg.terminalId, data),
        );
        client.detach.set(msg.terminalId, detach);
        break;
      }
      case 'input':
        this.sessions.get(msg.terminalId)?.write(msg.data);
        break;
      case 'resize': {
        const terminal = this.state.terminals[msg.terminalId];
        this.sessions.get(msg.terminalId)?.resize(msg.cols, msg.rows);
        if (terminal && (terminal.cols !== msg.cols || terminal.rows !== msg.rows)) {
          terminal.cols = msg.cols;
          terminal.rows = msg.rows;
          this.changed();
        }
        break;
      }
      case 'shutdown':
        void this.shutdown(true);
        break;
    }
  }

  /** Saves everything, including running jobs so they are restored on the next start, and exits. */
  private async shutdown(requested: boolean): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log(`shutting down (${requested ? 'requested' : 'signal'})`);
    const sessions = [...this.sessions];
    await Promise.race([
      Promise.all(
        sessions.map(async ([terminalId, session]) => {
          if (!this.state.terminals[terminalId] || !session.dirty) return;
          writeScrollbackSync(paths.stateFile, terminalId, await session.persistedScrollback(this.settings.persistedScrollback));
        }),
      ),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    // A background save still running would otherwise overwrite this final one.
    await this.savePromise;
    this.saveNow();
    for (const [, session] of sessions) session.kill();
    this.server?.close();
    if (process.platform !== 'win32') fs.rmSync(paths.socket, { force: true });
    process.exit(0);
  }
}

/** Exits if another daemon already serves the socket; removes a stale socket otherwise. */
function ensureSingleInstance(): Promise<void> {
  return new Promise((resolve) => {
    const probe = net.connect(paths.socket);
    probe.once('connect', () => {
      log('another daemon is running');
      process.exit(0);
    });
    probe.once('error', () => {
      if (process.platform !== 'win32') fs.rmSync(paths.socket, { force: true });
      resolve();
    });
  });
}

/**
 * Closes files the UI process left open for us. Chromium opens its own files
 * without close-on-exec, so a daemon started from an AppImage would otherwise
 * keep that version's mount alive after an update, and pass the files on to
 * every shell.
 */
function closeInheritedAppFiles(): void {
  if (process.platform !== 'linux') return;
  let fds: string[];
  try {
    fds = fs.readdirSync('/proc/self/fd');
  } catch {
    return;
  }
  for (const fd of fds.map(Number).filter((n) => n > 2)) {
    try {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`).includes('/.mount_')) fs.closeSync(fd);
    } catch {
      // Already closed, or not ours to inspect.
    }
  }
}

closeInheritedAppFiles();
process.on('uncaughtException', (err) => log('uncaught exception', err));
process.on('unhandledRejection', (err) => log('unhandled rejection', err));

void ensureSingleInstance().then(() => new Daemon().start());
