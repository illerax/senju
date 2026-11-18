import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinRecipes, expand, listSessions, matchRecipe, programOf, sessionFromArgs } from '../src/daemon/recipes';
import { planRestore } from '../src/daemon/restore';
import { defaultSettings } from '../src/shared/settings';
import type { TerminalState } from '../src/shared/types';

const claude = builtinRecipes.find((r) => r.name === 'claude-code')!;

function pane(job?: TerminalState['job']): TerminalState {
  return { id: 'p', cwd: '/work', cols: 80, rows: 24, env: {}, job };
}

const job = (argv: string[], extra: Partial<NonNullable<TerminalState['job']>> = {}) => ({ argv, cwd: '/work', env: {}, startedAt: 0, ...extra });

describe('recipes', () => {
  it('recognises programs run through an interpreter', () => {
    expect(programOf(['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', '-c']).args).toEqual(['-c']);
    expect(matchRecipe(builtinRecipes, ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'], '/')?.name).toBe('claude-code');
    expect(matchRecipe(builtinRecipes, ['/home/u/.local/bin/claude'], '/')?.name).toBe('claude-code');
    expect(matchRecipe(builtinRecipes, ['vim'], '/nonexistent')).toBeNull();
  });

  it('reads a session id from arguments', () => {
    const id = '0b5e7a52-6f1e-4c55-9c1f-0f3a2b1c4d5e';
    expect(sessionFromArgs(claude, ['claude', '--resume', id])).toBe(id);
    expect(sessionFromArgs(claude, ['claude', `--session-id=${id}`])).toBe(id);
    expect(sessionFromArgs(claude, ['claude'])).toBeNull();
  });

  it('expands templates with environment defaults', () => {
    const ctx = { cwd: '/home/u/my.app', env: {} };
    expect(expand('${env:CLAUDE_CONFIG_DIR:-~/.claude}/projects/${cwdSlug}', ctx)).toBe(`${os.homedir()}/.claude/projects/-home-u-my-app`);
    expect(expand('${env:CLAUDE_CONFIG_DIR:-~/.claude}', { ...ctx, env: { CLAUDE_CONFIG_DIR: '/cfg' } })).toBe('/cfg');
  });

  it('lists session files newest first, honouring CLAUDE_CONFIG_DIR', async () => {
    const config = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-'));
    const dir = path.join(config, 'projects', '-work');
    fs.mkdirSync(dir, { recursive: true });
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    fs.writeFileSync(path.join(dir, `${a}.jsonl`), '{}');
    fs.writeFileSync(path.join(dir, `${b}.jsonl`), '{}');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(dir, `${a}.jsonl`), now - 100, now - 100);
    const sessions = await listSessions(claude, { cwd: '/work', env: { CLAUDE_CONFIG_DIR: config } }, 0);
    expect(sessions.map((s) => s.id)).toEqual([b, a]);
    fs.rmSync(config, { recursive: true });
  });
});

describe('planRestore', () => {
  const plan = (p: TerminalState) => planRestore(p, builtinRecipes, defaultSettings.autoRestart, {});

  it('does nothing for an idle shell', () => {
    expect(plan(pane())).toEqual({});
  });

  it('resumes a Claude Code session, keeping its config dir', () => {
    const result = plan(pane(job(['claude'], { recipe: 'claude-code', sessionId: 'abc', env: { CLAUDE_CONFIG_DIR: '/cfg x' } })));
    expect(result.command).toBe('claude --resume abc');
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: '/cfg x' });
  });

  it('falls back to --continue without a session id', () => {
    expect(plan(pane(job(['claude'], { recipe: 'claude-code' }))).command).toBe('claude --continue');
  });

  it('restarts commands from the auto-restart list', () => {
    expect(plan(pane(job(['npm', 'run', 'dev']))).command).toBe('npm run dev');
    expect(plan(pane(job(['tail', '-f', '/var/log/syslog']))).command).toBe('tail -f /var/log/syslog');
  });

  it('offers other commands to run again in their directory', () => {
    const result = plan(pane(job(['make', 'test'], { cwd: '/work/sub' })));
    expect(result.command).toBeUndefined();
    expect(result.pending).toEqual({ command: 'cd /work/sub && make test', cwd: '/work/sub' });
  });

  it('keeps a pending command that was never run', () => {
    const p = { ...pane(), pending: { command: 'ls', cwd: '/' } };
    expect(plan(p)).toEqual({ pending: { command: 'ls', cwd: '/' } });
  });
});

describe('flags', () => {
  it('keeps options and drops positional prompts and session options', () => {
    const command = planRestore(
      pane(job(['claude', '--dangerously-skip-permissions', '--model', 'opus', 'fix the bug', '-c'], { recipe: 'claude-code', sessionId: 'abc' })),
      builtinRecipes,
      [],
      {},
    ).command;
    expect(command).toBe('claude --dangerously-skip-permissions --model opus --resume abc');
  });

  it('drops a previous --resume and its value', () => {
    const command = planRestore(pane(job(['claude', '--resume', 'old', '--verbose'], { recipe: 'claude-code', sessionId: 'new' })), builtinRecipes, [], {}).command;
    expect(command).toBe('claude --verbose --resume new');
  });
});
