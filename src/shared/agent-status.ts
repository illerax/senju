// What the UI shows about an agent, and which agents need the user: the
// counter and the system notifications.

import type { TerminalState } from './types';

/** working: busy with a task; waiting: needs the user; done: finished, ready for the next task. Also the CSS classes. */
export type AgentKind = 'working' | 'waiting' | 'done';

export interface AgentStatus {
  kind: AgentKind;
  text: string;
  /** The tool call in progress, e.g. "Bash: npm test". */
  activity?: string;
  /** Reported by the agent's hooks, not guessed from its output. */
  exact: boolean;
  /** The agent waits for the user: to allow a tool, answer, or give the next task. */
  needsYou: boolean;
}

/**
 * What an agent reports through its hooks; without hooks, a guess from its
 * output: printing means working, quiet means waiting for input.
 */
export function agentStatus(terminal: TerminalState | undefined): AgentStatus | null {
  const agent = terminal?.agent;
  if (agent) {
    const activity = agent.activity;
    const status = (kind: AgentKind, text: string, needsYou: boolean, withActivity = false): AgentStatus => ({
      kind,
      text,
      ...(withActivity && activity ? { activity } : {}),
      exact: true,
      needsYou,
    });
    switch (agent.state) {
      case 'working':
        return status('working', 'working', false, true);
      case 'permission':
        return status('waiting', 'needs permission', true, true);
      case 'question':
        return status('waiting', 'has a question', true, true);
      case 'error':
        return status('waiting', agent.error ? `failed: ${agent.error}` : 'failed', true);
      case 'done':
        return status('done', 'finished', true);
      // The user stopped it and knows.
      case 'waiting':
        return status('done', 'stopped', false);
      case 'ended':
        return null;
    }
  }
  if (!terminal?.job?.recipe) return null;
  return terminal.busy
    ? { kind: 'working', text: 'working', exact: false, needsYou: false }
    : { kind: 'waiting', text: 'waiting for input', exact: false, needsYou: true };
}

/** A guessed wait is only believed once it lasts: an agent may just pause its output. */
export const GUESSED_WAIT_MS = 10_000;

export interface AgentView {
  terminalId: string;
  status: AgentStatus | null;
  /** On screen in a focused window. */
  seenNow: boolean;
}

/**
 * Tracks which agents need the user and whether the user has seen that yet.
 * An agent counts until its terminal is on screen in the focused window; a
 * notification goes out once per wait, only for agents the user is not
 * looking at.
 */
export class Attention {
  /** The wait of each agent, by its status text, and when it began. */
  private readonly waits = new Map<string, { key: string; since: number; seen: boolean; notified: boolean }>();
  private started = false;

  /**
   * Returns the agents to notify about, the ones still unseen, every agent
   * that waits with the time it began, longest first, and when to look again
   * for guessed waits that have not lasted long enough yet.
   */
  update(views: AgentView[], now: number): { notify: string[]; unseen: string[]; waiting: Wait[]; recheckIn: number | null } {
    const notify: string[] = [];
    const unseen: string[] = [];
    const waiting: Wait[] = [];
    let recheckIn: number | null = null;
    const present = new Set<string>();
    for (const { terminalId, status, seenNow } of views) {
      if (!status?.needsYou) continue;
      present.add(terminalId);
      const key = status.text;
      let wait = this.waits.get(terminalId);
      if (!wait || wait.key !== key) {
        // What already waits when the window opens is not news.
        wait = { key, since: now, seen: !this.started, notified: !this.started };
        this.waits.set(terminalId, wait);
      }
      if (seenNow) wait.seen = true;
      const lasted = now - wait.since;
      if (!status.exact && lasted < GUESSED_WAIT_MS) {
        if (!wait.seen) recheckIn = Math.min(recheckIn ?? Infinity, GUESSED_WAIT_MS - lasted);
        continue;
      }
      waiting.push({ terminalId, since: wait.since });
      if (wait.seen) continue;
      unseen.push(terminalId);
      if (!wait.notified) {
        wait.notified = true;
        notify.push(terminalId);
      }
    }
    for (const id of this.waits.keys()) if (!present.has(id)) this.waits.delete(id);
    this.started = true;
    waiting.sort((a, b) => a.since - b.since);
    return { notify, unseen, waiting, recheckIn };
  }
}

export interface Wait {
  terminalId: string;
  /** When the agent began to wait. */
  since: number;
}

/** How long an agent has waited, in a few characters: "<1m", "12m", "2h 5m". */
export function formatWait(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/** The agent to go to after `current`: the next in the queue, or the one waiting longest. */
export function nextInQueue(queue: Wait[], current: string | undefined): string | undefined {
  const index = queue.findIndex((w) => w.terminalId === current);
  return queue[(index + 1) % queue.length]?.terminalId;
}
