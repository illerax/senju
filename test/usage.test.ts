import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionModel, SessionReader, UsageTracker } from '../src/daemon/usage';
import { contextPercent, formatTokens } from '../src/shared/usage';

const line = (entry: unknown) => JSON.stringify(entry);
const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
});
/** One reply of Claude Code, written as one line per content block with the same usage. */
const reply = (id: string, u: ReturnType<typeof usage>, blocks: unknown[], extra: Record<string, unknown> = {}) =>
  (blocks.length ? blocks : [{ type: 'text', text: '' }]).map((block) => line({ type: 'assistant', cwd: '/p', message: { id, model: 'claude-opus-5-5', usage: u, content: [block] }, timestamp: '2026-01-01T00:00:00Z', ...extra }));
const prompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-01-01T00:00:00Z' });
const result = (id: string, text: string) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

function claude(lines: string[]): SessionModel {
  const model = new SessionModel('claude-code');
  for (const l of lines) model.feed(l);
  return model;
}

describe('Claude Code sessions', () => {
  it('counts a reply written as several lines once', () => {
    const model = claude([
      prompt('fix the tests'),
      ...reply('m1', usage(10, 0, 1000, 50), [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/src/app.ts' } },
      ]),
    ]);
    expect(model.requests).toBe(1);
    expect(model.tokens).toEqual({ input: 10, cacheRead: 0, cacheWrite: 1000, output: 50 });
    expect(model.context).toBe(1010);
    expect(model.prompts).toEqual([{ at: Date.parse('2026-01-01T00:00:00Z'), text: 'fix the tests', requests: 1, tokens: model.tokens }]);
  });

  it('names what each request added to the context', () => {
    const model = claude([
      line({ type: 'api-request-shape', shape: { system: [{ text: 'x'.repeat(3000) }], tools: [{ name: 'Read', d: 'x'.repeat(900) }, { name: 'mcp__github__get_issue', d: 'x'.repeat(2900) }] } }),
      line({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: '/p/CLAUDE.md', content: 'x'.repeat(2000) }] } }),
      line({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: 'x'.repeat(100000) } }),
      prompt('fix the tests'),
      ...reply('m1', usage(0, 0, 2000, 10), [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/src/app.ts' } }]),
      result('t1', 'x'.repeat(40000)),
      ...reply('m2', usage(0, 2000, 10000, 10), [{ type: 'text', text: 'Done.' }]),
    ]);
    const parts = Object.fromEntries(model.contextParts().map((p) => [p.label, p.tokens]));
    expect(model.context).toBe(12000);
    // The second request added 10000 tokens, nearly all of them the file.
    expect(parts['Read src/app.ts']).toBeGreaterThan(9900);
    expect(parts['Memory: CLAUDE.md']).toBeGreaterThan(400);
    expect(parts['MCP tools: github (1)']).toBeGreaterThan(400);
    expect(parts['Built-in tools (1)']).toBeGreaterThan(100);
    expect(parts['System prompt']).toBeGreaterThan(500);
    // Claude Code's own records never count.
    expect(Object.keys(parts).join()).not.toMatch(/snapshot|Reminders/);
    expect(model.contextParts().reduce((sum, p) => sum + p.tokens, 0)).toBeCloseTo(12000, -1);
  });

  it('gives the system prompt the rest of the first request when its size is unknown', () => {
    const model = claude([prompt('x'.repeat(400)), ...reply('m1', usage(0, 0, 50000, 10), [])]);
    expect(model.contextParts()).toEqual([
      { label: 'System prompt and tools', tokens: 49900 },
      { label: 'Your messages', tokens: 100 },
    ]);
  });

  it('starts over after a compaction and records it', () => {
    const model = claude([
      prompt('a'),
      ...reply('m1', usage(0, 0, 150000, 10), [{ type: 'text', text: 'x' }]),
      line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 150000, postTokens: 20000 }, timestamp: '2026-01-01T01:00:00Z' }),
      line({ type: 'user', isCompactSummary: true, message: { content: 'x'.repeat(30000) } }),
      ...reply('m2', usage(0, 0, 21000, 10), [{ type: 'text', text: 'x' }]),
    ]);
    expect(model.compactions).toEqual([{ at: Date.parse('2026-01-01T01:00:00Z'), before: 150000, after: 20000 }]);
    expect(model.context).toBe(21000);
    const parts = model.contextParts();
    expect(parts).toContainEqual({ label: 'Summary of the earlier conversation', tokens: 7500 });
    expect(parts.reduce((sum, p) => sum + p.tokens, 0)).toBeCloseTo(21000, -1);
  });

  it('shrinks all parts when the agent drops some of the context', () => {
    const model = claude([
      prompt('a'),
      ...reply('m1', usage(0, 0, 1000, 10), [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      result('t1', 'x'.repeat(4000)),
      ...reply('m2', usage(0, 2000, 0, 10), []),
      ...reply('m3', usage(0, 1000, 0, 10), []),
    ]);
    expect(model.context).toBe(1000);
    expect(model.contextParts().reduce((sum, p) => sum + p.tokens, 0)).toBeCloseTo(1000, -1);
  });

  it('counts subagent requests in the totals, not in the context', () => {
    const model = claude([
      prompt('a'),
      ...reply('m1', usage(0, 0, 5000, 10), []),
      ...reply('s1', usage(0, 0, 90000, 500), [{ type: 'text', text: 'x' }], { isSidechain: true }),
    ]);
    expect(model.context).toBe(5000);
    expect(model.tokens.output).toBe(510);
  });

  it('turns slash commands into prompts and skips reminders', () => {
    const model = claude([prompt('<command-name>/compact</command-name><command-args></command-args>'), prompt('<local-command-stdout>ok</local-command-stdout>'), line({ type: 'user', isMeta: true, message: { content: 'Caveat' } })]);
    expect(model.prompts.map((p) => p.text)).toEqual(['/compact']);
  });

  it('takes the context window from the recipe', () => {
    const model = claude([prompt('a'), ...reply('m1', usage(0, 0, 50000, 10), [])]);
    const spec = { format: 'claude-code' as const, contextWindows: [{ model: '\\[1m\\]', tokens: 1_000_000 }, { model: '^claude-', tokens: 200_000 }] };
    expect(model.contextWindow(spec)).toEqual({ tokens: 200_000, exact: false });
    model.feed(reply('m2', usage(0, 0, 300_000, 10), [])[0]);
    // A larger context than assumed proves the 1M variant.
    expect(model.contextWindow(spec)).toEqual({ tokens: 1_000_000, exact: false });
    expect(model.contextWindow({ format: 'claude-code' })).toBeUndefined();
  });

  it('skips lines it does not understand', () => {
    const model = claude(['not json', '{"type":"api-request-blob","x":1}', line({ type: 'assistant', message: 'odd' }), line(null)]);
    expect(model.requests).toBe(0);
  });
});

describe('Codex sessions', () => {
  const token = (total: Record<string, number>, last: Record<string, number>) =>
    line({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 } } });

  it('reads totals, the context and the window, ignoring repeated counts', () => {
    const model = new SessionModel('codex');
    for (const l of [
      line({ type: 'turn_context', payload: { model: 'gpt-5.6' } }),
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'update the docs' } }),
      line({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.exec_command({"cmd":"sed -n 1,200p docs/a.md"})' } }),
      token({ input_tokens: 13000, cached_input_tokens: 11000, output_tokens: 100, total_tokens: 13100 }, { input_tokens: 13000 }),
      line({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'x'.repeat(40000) } }),
      token({ input_tokens: 36000, cached_input_tokens: 24000, output_tokens: 300, total_tokens: 36300 }, { input_tokens: 23000 }),
      token({ input_tokens: 36000, cached_input_tokens: 24000, output_tokens: 300, total_tokens: 36300 }, { input_tokens: 23000 }),
    ])
      model.feed(l);
    expect(model.model).toBe('gpt-5.6');
    expect(model.requests).toBe(2);
    expect(model.tokens).toEqual({ input: 12000, cacheRead: 24000, cacheWrite: 0, output: 300 });
    expect(model.context).toBe(23000);
    expect(model.contextWindow({ format: 'codex' })).toEqual({ tokens: 258400, exact: true });
    // The second request added the command's output.
    expect(model.contextParts()).toContainEqual({ label: 'Shell: sed -n 1,200p docs/a.md', tokens: 10000 });
    expect(model.prompts[0]).toMatchObject({ text: 'update the docs', requests: 2 });
  });
});

describe('reading session files', () => {
  it('reads only what was added, keeping a line still being written', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-usage-'));
    const file = path.join(dir, 's.jsonl');
    const [first] = reply('m1', usage(0, 0, 1000, 10), [{ type: 'text', text: 'x' }]);
    const [second] = reply('m2', usage(0, 1000, 500, 10), [{ type: 'text', text: 'y' }]);
    fs.writeFileSync(file, `${prompt('a')}\n${first}\n${second.slice(0, 20)}`);
    const reader = new SessionReader(file, 'claude-code');
    expect(await reader.update()).toBe(true);
    expect(reader.model.requests).toBe(1);
    expect(await reader.update()).toBe(false);
    fs.appendFileSync(file, `${second.slice(20)}\n`);
    await reader.update();
    expect(reader.model.requests).toBe(2);
    expect(reader.model.context).toBe(1500);
    fs.rmSync(dir, { recursive: true });
  });

  it('adds the subagents of a session to its totals', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-usage-'));
    const file = path.join(dir, 'abc.jsonl');
    fs.writeFileSync(file, `${reply('m1', usage(1, 0, 1000, 10), [])[0]}\n`);
    fs.mkdirSync(path.join(dir, 'abc', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'abc', 'subagents', 'agent-1.jsonl'), `${reply('s1', usage(2, 0, 3000, 30), [], { isSidechain: true })[0]}\n`);
    const tracker = new UsageTracker();
    const { model, subagents } = await tracker.session({ file, format: 'claude-code' });
    expect(model.tokens.output).toBe(10);
    expect(subagents).toEqual({ input: 2, cacheRead: 0, cacheWrite: 3000, output: 30 });
    const totals = await tracker.totals([{ file, format: 'claude-code' }, { file: path.join(dir, 'gone.jsonl'), format: 'claude-code' }]);
    expect(totals).toMatchObject({ tokens: { input: 3, cacheRead: 0, cacheWrite: 4000, output: 40 }, sessions: 2 });
    fs.rmSync(dir, { recursive: true });
  });
});

describe('formatting', () => {
  it('shortens token counts', () => {
    expect([999, 1234, 12345, 999_999, 1_234_567, 70_226_596].map(formatTokens)).toEqual(['999', '1.2k', '12k', '1000k', '1.2M', '70M']);
  });
  it('gives the context in percent of the window', () => {
    expect(contextPercent({ context: 50_000, window: { tokens: 200_000, exact: false } })).toBe(25);
    expect(contextPercent({ context: 50_000 })).toBeNull();
  });
});
