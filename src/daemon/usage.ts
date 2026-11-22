// Token usage and context of agent sessions, read from the files the agents
// write: Claude Code's session jsonl (with its subagents' files next to it)
// and Codex's rollout jsonl. The formats are the agents' own and may change;
// lines that don't fit are skipped, so a new format shows less, never wrong
// numbers. Files are read incrementally, in chunks with pauses in between, so
// a session of many megabytes never stalls the terminals.

import fs from 'node:fs';
import path from 'node:path';
import { toolActivity } from './agent-hooks';
import { addTokens, noTokens, type ContextPart, type ContextWindow, type PromptUsage, type TokenCounts, type UsageFormat, type AgentSessionFile, type UsageTotals } from '../shared/usage';

/** How a recipe reads usage from the agent's session files. */
export interface UsageSpec {
  format: UsageFormat;
  /** Context windows by model, for agents that don't record theirs: the first regular expression that matches the model wins. */
  contextWindows?: { model: string; tokens: number }[];
}

const AGENT = "The agent's replies and tool calls";
const YOU = 'Your messages';
const REMINDERS = 'Reminders and attachments';
const SUMMARY = 'Summary of the earlier conversation';
const OTHER = 'Other';
/** Parts listed by name; the rest are summed up as "Other". */
const MAX_PARTS = 14;
const MAX_PROMPTS = 30;
const CHARS_PER_TOKEN = 4;

interface Pending {
  label: string;
  chars: number;
}

/**
 * What one session file says: totals, the last context and what fills it.
 * Fed line by line; the context is split among its parts in proportion to
 * their text, as the agent reports only the total of each request.
 */
export class SessionModel {
  model?: string;
  context = 0;
  /** Reported by the agent (Codex). */
  window?: number;
  tokens = noTokens();
  requests = 0;
  readonly compactions: { at: number; before: number; after: number }[] = [];
  readonly prompts: PromptUsage[] = [];
  /** Labels of tool calls by id, to name their results. */
  private readonly calls = new Map<string, string>();
  private readonly counted = new Set<string>();
  private parts = new Map<string, number>();
  private pending: Pending[] = [];
  /** Context at the last request of this segment; 0 at the start and after a compaction. */
  private previous = 0;
  /** System prompt and tools of the last request, by label, in characters (Claude Code). */
  private base: Pending[] = [];
  private codexTotal = -1;
  private compactedAt?: number;

  constructor(readonly format: UsageFormat) {}

  feed(line: string): void {
    // Skip lines that are large and never needed before parsing them.
    if (this.format === 'claude-code' && /^\{"type":"(api-request-blob|api-request"|file-history|queue-operation)/.test(line)) return;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    if (this.format === 'claude-code') this.claude(entry);
    else this.codex(entry);
  }

  /** The parts of the context, biggest first; the smaller ones summed up by kind. */
  contextParts(): ContextPart[] {
    const parts = [...this.parts].filter(([, tokens]) => tokens >= 1).sort((a, b) => b[1] - a[1]);
    const shown = parts.slice(0, MAX_PARTS).map(([label, tokens]) => ({ label, tokens: Math.round(tokens) }));
    const kinds = new Map<string, { tokens: number; count: number }>();
    for (const [label, tokens] of parts.slice(MAX_PARTS)) {
      const kind = kindOf(label);
      const entry = kinds.get(kind) ?? { tokens: 0, count: 0 };
      entry.tokens += tokens;
      entry.count++;
      kinds.set(kind, entry);
    }
    const rest = [...kinds].sort((a, b) => b[1].tokens - a[1].tokens);
    for (const [kind, { tokens, count }] of rest) if (tokens >= 1) shown.push({ label: `${kind} (${count})`, tokens: Math.round(tokens) });
    return shown;
  }

  // --- Claude Code ---

  private claude(entry: Record<string, unknown>): void {
    const at = time(entry.timestamp);
    const sidechain = entry.isSidechain === true;
    switch (entry.type) {
      case 'assistant': {
        const message = record(entry.message);
        const id = str(message.id);
        const usage = record(message.usage);
        if (id && Object.keys(usage).length && !this.counted.has(id)) {
          // One reply is written as several lines, one per block, each with the same usage.
          this.counted.add(id);
          const counts: TokenCounts = {
            input: num(usage.input_tokens),
            cacheRead: num(usage.cache_read_input_tokens),
            cacheWrite: num(usage.cache_creation_input_tokens),
            output: num(usage.output_tokens),
          };
          const model = str(message.model);
          if (model && !model.startsWith('<')) this.model = model;
          this.request(counts, sidechain ? null : counts.input + counts.cacheRead + counts.cacheWrite, at);
        }
        if (sidechain) return;
        for (const block of list(message.content)) {
          if (block.type === 'tool_use') {
            this.calls.set(str(block.id), toolActivity({ tool_name: str(block.name), tool_input: record(block.input), cwd: str(entry.cwd) }) ?? str(block.name));
            this.add(AGENT, JSON.stringify(block.input ?? '').length + str(block.name).length);
          } else if (block.type === 'text') {
            this.add(AGENT, str(block.text).length);
          }
        }
        return;
      }
      case 'user': {
        if (sidechain) return;
        const message = record(entry.message);
        const content = message.content;
        if (entry.isCompactSummary === true) {
          this.add(SUMMARY, textOf(content).length);
          return;
        }
        if (typeof content === 'string') {
          this.userText(content, entry.isMeta === true, at);
          return;
        }
        const blocks = list(content);
        const results = blocks.filter((b) => b.type === 'tool_result');
        for (const block of results) this.add(this.calls.get(str(block.tool_use_id)) ?? 'Tool results', textOf(block.content).length);
        for (const block of blocks) {
          if (block.type === 'text') this.userText(str(block.text), entry.isMeta === true || results.length > 0, at);
          else if (block.type === 'image') this.add(YOU, 1500 * CHARS_PER_TOKEN);
        }
        return;
      }
      case 'attachment':
        if (!sidechain) this.attachment(record(entry.attachment));
        return;
      case 'system':
        if (entry.subtype === 'compact_boundary') {
          const meta = record(entry.compactMetadata);
          this.compact(at, num(meta.preTokens) || this.context, num(meta.postTokens));
        }
        return;
      case 'api-request-shape': {
        // The system prompt and tool definitions sent with the requests.
        const shape = record(entry.shape);
        const base: Pending[] = [{ label: 'System prompt', chars: JSON.stringify(shape.system ?? '').length }];
        const servers = new Map<string, { count: number; chars: number }>();
        for (const tool of list(shape.tools)) {
          const name = str(tool.name);
          const server = /^mcp__(.+?)__/.exec(name)?.[1];
          const key = server ? `MCP tools: ${server}` : 'Built-in tools';
          const group = servers.get(key) ?? { count: 0, chars: 0 };
          group.count++;
          group.chars += JSON.stringify(tool).length;
          servers.set(key, group);
        }
        for (const [label, { count, chars }] of servers) base.push({ label: `${label} (${count})`, chars });
        this.base = base;
        return;
      }
    }
  }

  /** What Claude Code adds to the conversation besides messages: memory files, skills, files. */
  private attachment(attachment: Record<string, unknown>): void {
    const size = (value: unknown) => (typeof value === 'string' ? value.length : JSON.stringify(value ?? '').length);
    switch (attachment.type) {
      // Records for Claude Code itself, not sent to the model.
      case 'prompt_snapshot':
      case 'deferred_tools_record':
      case 'thinking_drop':
      case 'remote_session_change':
      case 'credential_org':
      case 'auto_mode':
      case 'compact_file_reference':
        return;
      case 'instructions':
        for (const file of list(attachment.files)) this.add(`Memory: ${path.basename(str(file.path)) || 'instructions'}`, size(file.content));
        return;
      case 'skill_listing':
        this.add('Skills list', size(attachment.content));
        return;
      case 'deferred_tools_delta':
      case 'mcp_instructions_delta':
      case 'agent_listing_delta':
        this.add('Tool, MCP and agent lists', size(attachment));
        return;
      case 'file':
        this.add(`File ${path.basename(str(attachment.filename))}`, size(attachment.content));
        return;
      case 'edited_text_file':
        this.add(`Edited ${path.basename(str(attachment.filename))}`, size(attachment.snippet));
        return;
      default:
        this.add(REMINDERS, size(attachment));
    }
  }

  /** A text the user's side sent: a prompt, a slash command, or a reminder the agent added. */
  private userText(text: string, meta: boolean, at: number): void {
    const command = /^<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
    if (meta || (!command && text.startsWith('<'))) {
      this.add(REMINDERS, text.length);
      return;
    }
    this.add(YOU, text.length);
    this.prompt(command ?? text, at);
  }

  // --- Codex ---

  private codex(entry: Record<string, unknown>): void {
    const at = time(entry.timestamp);
    const payload = record(entry.payload);
    if (entry.type === 'turn_context') {
      if (str(payload.model)) this.model = str(payload.model);
      return;
    }
    if (entry.type === 'compacted') {
      this.compact(at, this.context, 0);
      return;
    }
    if (entry.type === 'event_msg') {
      if (payload.type === 'user_message') {
        const text = str(payload.message);
        this.add(YOU, text.length);
        this.prompt(text, at);
      } else if (payload.type === 'token_count') {
        const info = record(payload.info);
        const total = record(info.total_token_usage);
        const last = record(info.last_token_usage);
        if (num(info.model_context_window)) this.window = num(info.model_context_window);
        // The same totals are reported more than once.
        const sum = num(total.total_tokens);
        if (!Object.keys(total).length || sum === this.codexTotal) return;
        const before = this.tokens;
        const totals: TokenCounts = {
          input: num(total.input_tokens) - num(total.cached_input_tokens),
          cacheRead: num(total.cached_input_tokens),
          cacheWrite: num(total.cache_write_input_tokens),
          output: num(total.output_tokens),
        };
        this.codexTotal = sum;
        const counts: TokenCounts = {
          input: Math.max(0, totals.input - before.input),
          cacheRead: Math.max(0, totals.cacheRead - before.cacheRead),
          cacheWrite: Math.max(0, totals.cacheWrite - before.cacheWrite),
          output: Math.max(0, totals.output - before.output),
        };
        this.request(counts, num(last.input_tokens) + num(last.cache_write_input_tokens), at);
      }
      return;
    }
    if (entry.type !== 'response_item') return;
    switch (payload.type) {
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const input = str(payload.input) || str(payload.arguments) || JSON.stringify(payload.action ?? '');
        this.calls.set(str(payload.call_id), codexActivity(str(payload.name), input));
        this.add(AGENT, input.length);
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
        this.add(this.calls.get(str(payload.call_id)) ?? 'Tool results', textOf(payload.output).length);
        return;
      case 'message':
        if (payload.role === 'assistant') this.add(AGENT, textOf(payload.content).length);
        return;
    }
  }

  // --- common ---

  private add(label: string, chars: number): void {
    if (chars > 0) this.pending.push({ label, chars });
  }

  private prompt(text: string, at: number): void {
    const line = text.trim().split('\n')[0].slice(0, 120);
    this.prompts.push({ at, text: line, requests: 0, tokens: noTokens() });
    if (this.prompts.length > MAX_PROMPTS) this.prompts.shift();
  }

  private compact(at: number, before: number, after: number): void {
    this.compactions.push({ at, before, after });
    this.compactedAt = after ? undefined : this.compactions.length - 1;
    this.parts = new Map();
    this.previous = 0;
  }

  /**
   * A request to the model. `context` is its input, or null for a subagent's
   * request, which counts towards the totals but not the main context.
   */
  private request(counts: TokenCounts, context: number | null, at: number): void {
    this.tokens = addTokens(this.tokens, counts);
    this.requests++;
    const prompt = this.prompts.at(-1);
    if (prompt) {
      prompt.tokens = addTokens(prompt.tokens, counts);
      prompt.requests++;
    }
    if (context === null || context <= 0) return;
    if (this.compactedAt !== undefined) {
      this.compactions[this.compactedAt].after = context;
      this.compactedAt = undefined;
    }
    if (this.previous === 0) {
      // The first request of the session or after a compaction: besides the
      // messages so far, its input holds the system prompt and the tools.
      if (this.base.length) {
        this.distribute([...this.base, ...this.pending], context);
      } else {
        // Without the sizes of the system prompt and tools, the messages get their estimated size and the rest is the base.
        const known = Math.min(context, this.pending.reduce((sum, p) => sum + p.chars, 0) / CHARS_PER_TOKEN);
        this.distribute(this.pending, known);
        this.distribute([{ label: 'System prompt and tools', chars: 1 }], context - known);
      }
    } else if (context >= this.previous) {
      this.distribute(this.pending.length ? this.pending : [{ label: OTHER, chars: 1 }], context - this.previous);
    } else {
      // The agent dropped parts of the context (old tool results, reasoning); shrink all parts alike.
      const scale = context / this.previous;
      for (const [label, tokens] of this.parts) this.parts.set(label, tokens * scale);
    }
    this.pending = [];
    this.previous = context;
    this.context = context;
    void at;
  }

  private distribute(items: Pending[], tokens: number): void {
    const chars = items.reduce((sum, p) => sum + p.chars, 0);
    if (chars <= 0 || tokens <= 0) return;
    for (const item of items) this.parts.set(item.label, (this.parts.get(item.label) ?? 0) + (tokens * item.chars) / chars);
  }

  /** The context window: what the agent reports, else what the recipe assumes for the model. */
  contextWindow(spec: UsageSpec): ContextWindow | undefined {
    if (this.window) return { tokens: this.window, exact: true };
    const model = this.model ?? '';
    const known = spec.contextWindows?.find((w) => safeTest(w.model, model))?.tokens;
    if (!known) return undefined;
    // A context larger than assumed proves a larger window, e.g. a 1M variant.
    const largest = Math.max(this.context, ...this.compactions.map((c) => c.before));
    return { tokens: largest > known ? 1_000_000 : known, exact: false };
  }
}

/** The kind of a part, to sum up the small ones: "Bash: npm test" → "Other command output". */
function kindOf(label: string): string {
  if (/^(Bash|Shell):/.test(label)) return 'Other command output';
  if (/^(Read|File) /.test(label)) return 'Other files read';
  if (/^(Edit|Write|MultiEdit|NotebookEdit|Edited) /.test(label)) return 'Other edits';
  if (/^(Grep|Glob|WebSearch|WebFetch)\b/.test(label)) return 'Other searches';
  if (/^(Task|Agent):/.test(label)) return 'Other subagent results';
  return OTHER;
}

/** What a Codex tool call did: "Shell: npm test", "Edit src/app.ts". */
function codexActivity(name: string, input: string): string {
  const file = /\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/.exec(input)?.[1];
  if (file) return `Edit ${path.basename(file)}`;
  const command = /"(?:cmd|command)"\s*:\s*(?:\[\s*"(?:bash|sh|zsh)"\s*,\s*"-l?c"\s*,\s*)?"((?:[^"\\]|\\.)*)"/.exec(input)?.[1];
  if (command) {
    const text = command.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1').trim();
    return `Shell: ${text.length > 70 ? `${text.slice(0, 69)}…` : text}`;
  }
  return name || 'Tool call';
}

function safeTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const time = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) || 0 : 0);

/** The text of a message's content, whatever its shape. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : JSON.stringify(c ?? ''))).join('\n');
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

/** Bytes read before pausing, so other work of the daemon runs in between. */
const CHUNK = 512 * 1024;
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Reads a session file as it grows, feeding new lines to its model. */
export class SessionReader {
  model: SessionModel;
  private offset = 0;
  private rest: Buffer = Buffer.alloc(0);
  private reading: Promise<boolean> | null = null;

  constructor(
    readonly file: string,
    readonly format: UsageFormat,
  ) {
    this.model = new SessionModel(format);
  }

  /** Reads what was added since the last call; true when something was. */
  update(): Promise<boolean> {
    this.reading ??= this.read().finally(() => (this.reading = null));
    return this.reading;
  }

  private async read(): Promise<boolean> {
    const size = await fs.promises.stat(this.file).then((s) => s.size, () => -1);
    if (size < 0 || size === this.offset) return false;
    if (size < this.offset) {
      // Rewritten from the start.
      this.model = new SessionModel(this.format);
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    const handle = await fs.promises.open(this.file, 'r');
    try {
      while (this.offset < size) {
        const buffer = Buffer.alloc(Math.min(CHUNK, size - this.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        const data = this.rest.length ? Buffer.concat([this.rest, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        const end = data.lastIndexOf(10);
        // A line still being written stays for the next read.
        this.rest = end < 0 ? data : data.subarray(end + 1);
        if (end >= 0) {
          for (const line of data.subarray(0, end).toString('utf8').split('\n')) if (line) this.model.feed(line);
        }
        await pause();
      }
    } finally {
      await handle.close();
    }
    return true;
  }
}

/** The files Claude Code writes for the subagents of a session: <session>/subagents/*.jsonl. */
export async function subagentFiles(sessionFile: string, format: UsageFormat): Promise<string[]> {
  if (format !== 'claude-code') return [];
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n));
}

/** Keeps a reader per session file and sums up sessions with their subagents. */
export class UsageTracker {
  private readonly readers = new Map<string, SessionReader>();

  private reader(file: string, format: UsageFormat): SessionReader {
    let reader = this.readers.get(file);
    if (!reader) {
      reader = new SessionReader(file, format);
      this.readers.set(file, reader);
    }
    return reader;
  }

  /** Reads what a session and its subagents added since the last call. */
  async session({ file, format }: AgentSessionFile): Promise<{ model: SessionModel; subagents: TokenCounts; changed: boolean }> {
    const main = this.reader(file, format);
    let changed = await main.update();
    let subagents = noTokens();
    for (const sub of await subagentFiles(file, format)) {
      const reader = this.reader(sub, format);
      changed = (await reader.update()) || changed;
      subagents = addTokens(subagents, reader.model.tokens);
    }
    return { model: main.model, subagents, changed };
  }

  /** What the sessions used together, subagents included. */
  async totals(files: AgentSessionFile[]): Promise<UsageTotals> {
    let tokens = noTokens();
    for (const file of files) {
      const { model, subagents } = await this.session(file);
      tokens = addTokens(tokens, addTokens(model.tokens, subagents));
    }
    return { tokens, sessions: files.length };
  }

  /** Forgets the readers of files no longer listed, keeping their memory bounded. */
  keepOnly(files: Iterable<string>): void {
    const keep = new Set(files);
    for (const file of this.readers.keys()) {
      const main = file.includes(`${path.sep}subagents${path.sep}`) ? `${path.dirname(path.dirname(file))}.jsonl` : file;
      if (!keep.has(main)) this.readers.delete(file);
    }
  }
}
