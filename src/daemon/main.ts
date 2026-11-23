// The Senju daemon. Owns every terminal process and the persistent state, so
// programs keep running while the UI is closed, crashes or gets updated.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION, type Action, type ClientMessage, type DaemonMessage } from '../shared/protocol';
import { BUILD_ID } from '../shared/build';
import { paths } from '../shared/paths';
import { applyHookEvent, backgroundDiagnostics, EventSpool, hookEnv, writeHookPlugin, type HookEvent } from './agent-hooks';
import { describeSaved, insertRestored, listClosed, readSavedGroup, restoreGroup, snapshotGroup, writeSavedGroup } from './closed-groups';
import { diagnose, diagnoseError, systemInfo, watchEventLoop } from '../shared/diagnostics';
import { loadSettings, type Settings } from '../shared/settings';
import type { AppState, ClosedGroupInfo, JobState, SavedGroup, TerminalState } from '../shared/types';
import { baseEnv, BUSY_MS, TerminalSession } from './terminal';
import { hasChildren, inspectTerminals, type ProcessInfo } from './procinfo';
import { findSessionFile, listSessions, loadRecipes, programOf, matchRecipe, requiredFiles, sessionFromArgs, sessionFromPidFile, type Recipe } from './recipes';
import { planRestore } from './restore';
import { envDiff } from './shellquote';
import { deleteScrollback, loadState, pruneScrollback, readScrollback, saveState, saveStateAsync, writeScrollback, writeScrollbackSync } from './store';
import { applyAction, closeTerminal, findTerminal, type Effects } from './workspace';
import { UsageTracker } from './usage';
import { agentProfile } from './agent-profile';
import { addTokens, type AgentProfile, type AgentSessionFile, type AgentUsage, type UsageDetails } from '../shared/usage';
import { terminalIds } from '../shared/layout';

const POLL_MS = 1000;
const SESSION_POLL_MS = 2000;
/** How often the session files of running agents are read for their context and tokens. */
const USAGE_POLL_MS = 2000;
/** Sessions a tab or a workspace keeps for its totals; the oldest are dropped. */
const MAX_AGENT_SESSIONS = 50;
/** How often one terminal's scrollback may be saved; one at a time keeps each pause short. */
const SCROLLBACK_TICK_MS = 3000;
/** Minimum age of a saved scrollback before it is saved again, for quiet and for busy terminals. */
const SCROLLBACK_QUIET_MS = 15000;
const SCROLLBACK_BUSY_MS = 60000;
/** How long a vanished job or shell is kept, so processes killed by a shutdown are still restored. */
const EXIT_GRACE_MS = 3000;
/**
 * An agent that waits only for background commands but has had no child
 * process this long is done: Claude Code still lists tasks that are gone.
 * Long enough for it to resume after a command it waited for ends.
 */
const ORPHAN_TASKS_MS = 15_000;
/** Task types that run as child processes of the agent. */
const PROCESS_TASKS = new Set(['shell', 'monitor']);

/** Runs a periodic task, starting the next run only after the previous one has finished. */
function repeat(task: () => Promise<void>, ms: number): void {
  const next = () => setTimeout(() => void task().catch((err) => log('periodic task failed', err)).finally(next), ms);
  next();
}

// Thresholds for diagnostics.log (shared/diagnostics.ts).
const BLOCKED_MS = 200;
const SLOW_POLL_MS = 1000;
/** Output of one terminal in one second that is logged as a burst, such as an agent printing its conversation again. */
const OUTPUT_BURST = 1024 * 1024;

/** Runs a task and logs it to diagnostics.log when it took `thresholdMs` or more. */
async function logIfSlow(name: string, thresholdMs: number, task: () => Promise<void>): Promise<void> {
  const started = performance.now();
  await task();
  const ms = performance.now() - started;
  if (ms >= thresholdMs) diagnose('daemon', `slow ${name}`, { ms: Math.round(ms) });
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
  /** Since when an agent in the background state has had no child process. */
  childlessSince?: number;
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
    // Before the terminals start: their Claude Code loads the plugin from there.
    await writeHookPlugin(this.hookPlugin).catch((err) => log('could not write the Claude Code plugin', err));
    await this.events.start().catch((err) => log('could not watch agent events', err));
    this.closedGroups = await listClosed(paths.closedGroupsDir);
    pruneScrollback(paths.stateFile, new Set(Object.keys(this.state.terminals)));
    const jobCwds = Object.values(this.state.terminals).flatMap((t) => (t.job ? [t.job.cwd] : []));
    const present = await requiredFiles(this.recipes, jobCwds);
    for (const id of Object.keys(this.state.terminals)) this.spawn(id, true, present);
    this.saveNow();
    this.listen();
    repeat(() => logIfSlow('process poll', SLOW_POLL_MS, () => this.pollProcesses()), POLL_MS);
    repeat(() => logIfSlow('session poll', SLOW_POLL_MS, () => this.pollSessions()), SESSION_POLL_MS);
    repeat(() => logIfSlow('usage poll', SLOW_POLL_MS, () => this.pollUsage()), USAGE_POLL_MS);
    repeat(() => this.persistScrollback(), SCROLLBACK_TICK_MS);
    this.watchOutput();
    watchEventLoop('daemon', BLOCKED_MS, () => ({ busiest: this.busiest() }));
    const terminals = Object.values(this.state.terminals);
    diagnose('daemon', 'start', { build: BUILD_ID, ...systemInfo(), terminals: terminals.length, agents: terminals.filter((t) => t.job?.recipe).length });
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      process.on(signal, () => void this.shutdown(false));
    }
    log(`daemon ${process.pid} started with ${this.sessions.size} terminals`);
  }

  private readonly hookPlugin = path.join(paths.runtimeDir, 'claude-plugin');
  private readonly events = new EventSpool(path.join(paths.runtimeDir, 'events'), (id, event) => this.onHookEvent(id, event));

  /** An agent reported through its hooks. */
  private onHookEvent(terminalId: string, event: HookEvent): void {
    const terminal = this.state.terminals[terminalId];
    if (!terminal || this.shuttingDown) return;
    if (typeof event.transcript_path === 'string' && event.transcript_path) this.transcripts.set(terminalId, event.transcript_path);
    if (event.hook_event_name === 'Stop') {
      // What Claude Code lists as still running, to tell stale entries from real work.
      const background = backgroundDiagnostics(event);
      if (background) diagnose('daemon', 'agent stopped with background work', { terminal: this.describe(terminalId), ...background });
    }
    const next = applyHookEvent(terminal.agent, event, Date.now());
    const same = (a = terminal.agent, b = next) =>
      a?.state === b?.state && a?.activity === b?.activity && a?.error === b?.error && JSON.stringify(a?.tasks) === JSON.stringify(b?.tasks);
    if (same()) return;
    terminal.agent = next;
    this.changed();
  }

  // --- context and token usage of agents ---

  private readonly usage = new UsageTracker();
  /** What the UI shows of each running agent, by terminal id. */
  private readonly agentUsage = new Map<string, AgentUsage>();
  /** What each running agent runs with, by terminal id. */
  private readonly profiles = new Map<string, AgentProfile>();
  /** Session files Claude Code reported through its hooks, by terminal id. */
  private readonly transcripts = new Map<string, string>();
  /** Session files found through recipes, by recipe and session id; null until a retry is due. */
  private readonly sessionFiles = new Map<string, { file: string | null; at: number }>();

  /** The file of an agent's current session. */
  private async sessionFile(terminal: TerminalState, recipe: Recipe, job: JobState): Promise<string | null> {
    const id = job.sessionId;
    if (!id) return null;
    const reported = this.transcripts.get(terminal.id);
    if (reported && path.basename(reported).includes(id)) return reported;
    const key = `${recipe.name}\0${id}`;
    const known = this.sessionFiles.get(key);
    if (known && (known.file || Date.now() - known.at < 30_000)) return known.file;
    const env = { ...this.env, ...terminal.env, ...job.env };
    const file = await findSessionFile(recipe, { cwd: job.cwd, env }, id);
    this.sessionFiles.set(key, { file, at: Date.now() });
    return file;
  }

  /** Adds a session to the totals of its tab and workspace; true when it is new there. */
  private rememberSession(terminal: TerminalState, session: AgentSessionFile): boolean {
    const add = (owner: { agentSessions?: AgentSessionFile[] }) => {
      if (owner.agentSessions?.some((s) => s.file === session.file)) return false;
      owner.agentSessions = [...(owner.agentSessions ?? []), session].slice(-MAX_AGENT_SESSIONS);
      return true;
    };
    const workspace = findTerminal(this.state, terminal.id)?.workspace;
    const added = add(terminal);
    return (workspace ? add(workspace) : false) || added;
  }

  /** Reads the session files of the running agents for their context and tokens, and what they run with. */
  private async pollUsage(): Promise<void> {
    if (this.shuttingDown) return;
    let changed = false;
    const shown = new Set<string>();
    const profiled = new Set<string>();
    for (const terminal of Object.values(this.state.terminals)) {
      const job = terminal.job;
      const recipe = job?.recipe ? this.recipes.find((r) => r.name === job.recipe) : undefined;
      if (!job || !recipe?.usage) continue;
      const format = recipe.usage.format;
      const profile = await agentProfile(format, { ...this.env, ...terminal.env, ...job.env }, programOf(job.argv).args);
      const file = await this.sessionFile(terminal, recipe, job);
      const read = file ? await this.usage.session({ file, format }) : null;
      // The terminal may have closed or its agent changed meanwhile.
      if (this.state.terminals[terminal.id] !== terminal || terminal.job !== job) continue;
      // The model it answered with, rather than the one it was set to.
      if (read?.model.model) profile.model = read.model.model;
      profiled.add(terminal.id);
      if (JSON.stringify(profile) !== JSON.stringify(this.profiles.get(terminal.id))) {
        this.profiles.set(terminal.id, profile);
        changed = true;
      }
      if (!file || !read) continue;
      if (this.rememberSession(terminal, { file, format })) changed = true;
      const { model, subagents } = read;
      if (model.requests === 0) continue;
      shown.add(terminal.id);
      const usage: AgentUsage = { context: model.context, window: model.contextWindow(recipe.usage), model: model.model, session: addTokens(model.tokens, subagents) };
      if (JSON.stringify(usage) !== JSON.stringify(this.agentUsage.get(terminal.id))) {
        this.agentUsage.set(terminal.id, usage);
        changed = true;
      }
    }
    for (const id of this.agentUsage.keys()) {
      if (shown.has(id)) continue;
      this.agentUsage.delete(id);
      changed = true;
    }
    for (const id of this.profiles.keys()) {
      if (profiled.has(id)) continue;
      this.profiles.delete(id);
      changed = true;
    }
    for (const id of this.transcripts.keys()) if (!this.state.terminals[id]) this.transcripts.delete(id);
    const listed = [...Object.values(this.state.terminals), ...this.state.groups.flatMap((g) => g.workspaces)].flatMap((o) => o.agentSessions ?? []);
    this.usage.keepOnly(listed.map((s) => s.file));
    if (changed) this.changed();
  }

  /** Everything the usage window of an agent shows. */
  private async usageDetails(terminalId: string): Promise<UsageDetails | null> {
    const terminal = this.state.terminals[terminalId];
    const job = terminal?.job;
    const recipe = job?.recipe ? this.recipes.find((r) => r.name === job.recipe) : undefined;
    if (!terminal || !job || !recipe?.usage) return null;
    const file = await this.sessionFile(terminal, recipe, job);
    if (!file) return null;
    const { model, subagents } = await this.usage.session({ file, format: recipe.usage.format });
    const workspace = findTerminal(this.state, terminalId)?.workspace;
    return {
      terminalId,
      agent: recipe.name,
      model: model.model,
      context: model.context,
      window: model.contextWindow(recipe.usage),
      parts: model.contextParts(),
      compactions: [...model.compactions],
      session: { tokens: addTokens(model.tokens, subagents), requests: model.requests, subagents },
      prompts: [...model.prompts].reverse(),
      tab: await this.usage.totals(terminal.agentSessions ?? []),
      workspace: await this.usage.totals(workspace?.agentSessions ?? []),
    };
  }

  /** Output of each terminal in each of the last seconds, for diagnostics.log. */
  private readonly outputSeconds: Map<string, number>[] = [];
  private readonly outputSeen = new Map<string, number>();

  private watchOutput(): void {
    setInterval(() => {
      const second = new Map<string, number>();
      for (const [id, session] of this.sessions) {
        const printed = session.outputBytes - (this.outputSeen.get(id) ?? 0);
        this.outputSeen.set(id, session.outputBytes);
        if (printed > 0) second.set(id, printed);
        if (printed >= OUTPUT_BURST) diagnose('daemon', 'output burst', { terminal: this.describe(id), kb: Math.round(printed / 1024) });
      }
      for (const id of this.outputSeen.keys()) if (!this.sessions.has(id)) this.outputSeen.delete(id);
      this.outputSeconds.push(second);
      if (this.outputSeconds.length > 5) this.outputSeconds.shift();
    }, 1000).unref();
  }

  /** The terminals that printed the most in the last seconds. */
  private busiest(): { terminal: string; kbPerSecond: number }[] {
    const total = new Map<string, number>();
    for (const second of this.outputSeconds) for (const [id, n] of second) total.set(id, (total.get(id) ?? 0) + n);
    const seconds = Math.max(1, this.outputSeconds.length);
    return [...total]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, n]) => ({ terminal: this.describe(id), kbPerSecond: Math.round(n / seconds / 1024) }));
  }

  /** A terminal as diagnostics.log names it: its id and its tab name, agent or program. */
  private describe(id: string): string {
    const terminal = this.state.terminals[id];
    const what = terminal?.name || terminal?.job?.recipe || terminal?.job?.argv[0]?.split('/').pop() || 'shell';
    return `${id} ${what}`;
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
      terminal.agent = undefined;
    }
    const session = new TerminalSession({
      id: terminalId,
      cwd: terminal.cwd,
      env,
      senjuEnv: hookEnv(terminalId, this.hookPlugin, this.events.dir, this.env),
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

  /** Groups closed to disk, newest first. */
  private closedGroups: ClosedGroupInfo[] = [];

  /** Closes a group to disk: its terminals stop, and reopening it restores them as after a reboot. */
  private async closeGroup(groupId: string): Promise<void> {
    await this.saveGroup(groupId, path.join(paths.closedGroupsDir, `${groupId}.json`), (saved) => {
      this.closedGroups = [describeSaved(groupId, saved), ...this.closedGroups.filter((g) => g.id !== groupId)];
      this.applyEffects(applyAction(this.state, { type: 'deleteGroup', groupId }, os.homedir()));
    });
  }

  /** Saves a group with its terminals and their scrollback to a file. */
  private async saveGroup(groupId: string, file: string, then?: (saved: SavedGroup) => void): Promise<void> {
    const group = this.state.groups.find((g) => g.id === groupId);
    if (!group) return;
    const scrollback: Record<string, string> = {};
    await Promise.all(
      group.workspaces
        .flatMap((w) => terminalIds(w.root))
        .map(async (id) => {
          const session = this.sessions.get(id);
          if (session) scrollback[id] = await session.persistedScrollback(this.settings.persistedScrollback);
        }),
    );
    const saved = snapshotGroup(this.state, groupId, scrollback, Date.now());
    if (!saved || this.shuttingDown) return;
    await writeSavedGroup(file, saved);
    then?.(saved);
    log(`group ${groupId} saved to ${file}`);
    this.changed();
  }

  /** Opens a saved group as a new group at its old place; its terminals start as after a reboot. */
  private async openGroup(file: string): Promise<void> {
    const saved = await readSavedGroup(file);
    const restored = restoreGroup(saved);
    await Promise.all(Object.entries(restored.scrollback).map(([id, data]) => writeScrollback(paths.stateFile, id, data)));
    const jobCwds = Object.values(restored.terminals).flatMap((t) => (t.job ? [t.job.cwd] : []));
    const present = await requiredFiles(this.recipes, jobCwds);
    if (this.shuttingDown) return;
    insertRestored(this.state, restored, saved.index);
    for (const id of Object.keys(restored.terminals)) this.spawn(id, true, present);
    log(`group ${restored.group.id} opened from ${file}`);
    this.changed();
  }

  private async groupFiles(action: Extract<Action, { type: 'closeGroup' | 'reopenGroup' | 'forgetClosedGroup' | 'exportGroup' | 'importGroup' }>): Promise<void> {
    const closedFile = (id: string) => path.join(paths.closedGroupsDir, `${id.replace(/[^\w-]/g, '')}.json`);
    try {
      switch (action.type) {
        case 'closeGroup':
          return await this.closeGroup(action.groupId);
        case 'exportGroup':
          return await this.saveGroup(action.groupId, action.file);
        case 'importGroup':
          return await this.openGroup(action.file);
        case 'reopenGroup':
          await this.openGroup(closedFile(action.closedId));
          await fs.promises.rm(closedFile(action.closedId), { force: true });
          break;
        case 'forgetClosedGroup':
          await fs.promises.rm(closedFile(action.closedId), { force: true });
          break;
      }
      if (action.type === 'reopenGroup' || action.type === 'forgetClosedGroup') {
        this.closedGroups = this.closedGroups.filter((g) => g.id !== action.closedId);
        this.changed();
      }
    } catch (err) {
      log(`${action.type} failed`, err);
      for (const client of this.clients) client.send({ type: 'error', message: (err as Error).message });
    }
  }

  private handleAction(action: Action): void {
    switch (action.type) {
      case 'closeGroup':
      case 'reopenGroup':
      case 'forgetClosedGroup':
      case 'exportGroup':
      case 'importGroup':
        void this.groupFiles(action);
        return;
    }
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
        // Hooks do not report an interrupted turn or a refused permission:
        // the user pressed keys since the last event and the agent went quiet.
        const agent = terminal.agent;
        const now = Date.now();
        if (agent && !busy && ['working', 'permission', 'question'].includes(agent.state) && session.inputAt > agent.at && now - session.inputAt > BUSY_MS) {
          terminal.agent = { state: 'waiting', at: now };
          changed = true;
        }
        if (await this.backgroundGone(terminal, tracked, now)) {
          if (this.shuttingDown || this.sessions.get(terminalId) !== session) return;
          terminal.agent = { state: 'done', at: now };
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
            terminal.agent = undefined;
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
   * Whether an agent in the background state waits only for commands that
   * are gone: none of its tasks runs outside its process, and it has had no
   * child process for ORPHAN_TASKS_MS.
   */
  private async backgroundGone(terminal: TerminalState, tracked: Tracked, now: number): Promise<boolean> {
    const agent = terminal.agent;
    if (agent?.state !== 'background' || !agent.tasks?.length || !agent.tasks.every((t) => PROCESS_TASKS.has(t.type)) || !tracked.agentPid) {
      tracked.childlessSince = undefined;
      return false;
    }
    if ((await hasChildren(tracked.agentPid)) !== false) {
      tracked.childlessSince = undefined;
      return false;
    }
    tracked.childlessSince ??= now;
    if (now - tracked.childlessSince < ORPHAN_TASKS_MS || terminal.agent !== agent) return false;
    tracked.childlessSince = undefined;
    return true;
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
      terminals[id] = { ...terminal, env: {}, job: terminal.job && { ...terminal.job, env: {} }, agentSessions: undefined };
    }
    return { ...this.state, terminals, closedGroups: this.closedGroups, usage: Object.fromEntries(this.agentUsage), profiles: Object.fromEntries(this.profiles) };
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
      case 'peek': {
        const screens: Record<string, string[]> = {};
        const lines = Math.max(1, Math.min(Number(msg.lines) || 0, 100));
        for (const id of Array.isArray(msg.terminalIds) ? msg.terminalIds : []) {
          const session = this.sessions.get(id);
          if (session) screens[id] = session.peek(lines);
        }
        client.send({ type: 'peek', screens });
        break;
      }
      case 'usage':
        void this.usageDetails(String(msg.terminalId))
          .catch(() => null)
          .then((details) => client.send({ type: 'usage', terminalId: msg.terminalId, details }));
        break;
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
process.on('uncaughtException', (err) => {
  log('uncaught exception', err);
  diagnoseError('daemon', 'uncaught exception', err);
});
process.on('unhandledRejection', (err) => {
  log('unhandled rejection', err);
  diagnoseError('daemon', 'unhandled rejection', err);
});

void ensureSingleInstance().then(() => new Daemon().start());
