import { describe, expect, it } from 'vitest';
import { agentStatus, Attention, formatWait, GUESSED_WAIT_MS, nextInQueue, type AgentStatus } from '../src/shared/agent-status';
import type { TerminalState } from '../src/shared/types';

const terminal = (extra: Partial<TerminalState>): TerminalState => ({ id: 't', cwd: '/', cols: 80, rows: 24, env: {}, ...extra });
const job = { argv: ['claude'], cwd: '/', env: {}, startedAt: 0, recipe: 'claude-code' };

describe('agent status', () => {
  it('reads the hooks, or guesses from output without them', () => {
    expect(agentStatus(terminal({ agent: { state: 'permission', activity: 'Bash: ls', at: 0 } }))).toEqual({
      kind: 'waiting',
      text: 'needs permission',
      activity: 'Bash: ls',
      exact: true,
      needsYou: true,
    });
    expect(agentStatus(terminal({ agent: { state: 'waiting', at: 0 } }))?.needsYou).toBe(false);
    expect(agentStatus(terminal({ agent: { state: 'ended', at: 0 } }))).toBeNull();
    expect(agentStatus(terminal({ job, busy: false }))).toMatchObject({ kind: 'waiting', exact: false, needsYou: true });
    expect(agentStatus(terminal({}))).toBeNull();
  });
});

describe('attention', () => {
  const exact = (text: string, needsYou = true): AgentStatus => ({ kind: 'waiting', text, exact: true, needsYou });
  it('counts and notifies a wait until the user sees it, once', () => {
    const a = new Attention();
    // Waits that exist when the window opens are not news.
    expect(a.update([{ terminalId: 'old', status: exact('finished'), seenNow: false }], 0)).toMatchObject({ notify: [], unseen: [] });
    const hidden = [{ terminalId: 'old', status: exact('finished'), seenNow: false }, { terminalId: 't', status: exact('needs permission'), seenNow: false }];
    expect(a.update(hidden, 1)).toMatchObject({ notify: ['t'], unseen: ['t'] });
    expect(a.update(hidden, 2)).toMatchObject({ notify: [], unseen: ['t'] });
    expect(a.update([{ terminalId: 't', status: exact('needs permission'), seenNow: true }], 3)).toMatchObject({ unseen: [] });
    expect(a.update([{ terminalId: 't', status: exact('needs permission'), seenNow: false }], 4)).toMatchObject({ notify: [], unseen: [] });
    // Working again, then finished: a new wait.
    a.update([{ terminalId: 't', status: exact('working', false), seenNow: false }], 5);
    expect(a.update([{ terminalId: 't', status: exact('finished'), seenNow: false }], 6)).toMatchObject({ notify: ['t'], unseen: ['t'] });
  });

  it('believes a guessed wait only once it lasts', () => {
    const a = new Attention();
    a.update([], 0);
    const guessed = [{ terminalId: 'g', status: { kind: 'waiting' as const, text: 'waiting for input', exact: false, needsYou: true }, seenNow: false }];
    expect(a.update(guessed, 1000)).toEqual({ notify: [], unseen: [], waiting: [], recheckIn: GUESSED_WAIT_MS });
    expect(a.update(guessed, 1000 + GUESSED_WAIT_MS)).toMatchObject({ notify: ['g'], unseen: ['g'] });
  });
});

describe('waiting queue', () => {
  const exact = (text: string): AgentStatus => ({ kind: 'waiting', text, exact: true, needsYou: true });
  it('puts the agent that waits longest first, seen or not', () => {
    const a = new Attention();
    a.update([], 0);
    a.update([{ terminalId: 'early', status: exact('finished'), seenNow: true }], 100);
    const { waiting } = a.update(
      [
        { terminalId: 'late', status: exact('needs permission'), seenNow: false },
        { terminalId: 'early', status: exact('finished'), seenNow: false },
      ],
      500,
    );
    expect(waiting).toEqual([
      { terminalId: 'early', since: 100 },
      { terminalId: 'late', since: 500 },
    ]);
    expect(nextInQueue(waiting, undefined)).toBe('early');
    expect(nextInQueue(waiting, 'early')).toBe('late');
    expect(nextInQueue(waiting, 'late')).toBe('early');
    expect(nextInQueue([], 'x')).toBeUndefined();
  });

  it('shows waits in minutes and hours', () => {
    expect(formatWait(30_000)).toBe('<1m');
    expect(formatWait(12 * 60_000)).toBe('12m');
    expect(formatWait(125 * 60_000)).toBe('2h 5m');
    expect(formatWait(120 * 60_000)).toBe('2h');
  });
});
