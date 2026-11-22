// What an agent's session costs in tokens and how full its context is, read
// by the daemon from the session files the agent writes (daemon/usage.ts).

/** How an agent's session files are read: Claude Code's or Codex's jsonl. */
export type UsageFormat = 'claude-code' | 'codex';

/** A session file of an agent, kept to count what a tab or a workspace used over all its sessions. */
export interface AgentSessionFile {
  file: string;
  format: UsageFormat;
}

/**
 * What an agent runs with, to tell agents with different settings apart:
 * several Claude Code configurations or keys, or another model behind it.
 */
export interface AgentProfile {
  /** The configuration folder, when not the agent's default one, e.g. "~/.claude-work". */
  config?: string;
  /** Who the agent is signed in as. */
  account?: string;
  /** The subscription of that account, e.g. "Max". */
  plan?: string;
  /** Where requests go, when not the agent's own API: "api.moonshot.ai", "Amazon Bedrock". */
  endpoint?: string;
  /** The last characters of the API key, enough to tell keys apart: "…a1b2". */
  key?: string;
  /** The model: the one it answered with, else the one it is set to use. */
  model?: string;
}

/** The profile in one line: "~/.claude-work · me@example.com · claude-opus-5-5". */
export function profileText(profile: AgentProfile | undefined): string {
  if (!profile) return '';
  const account = profile.account && profile.plan ? `${profile.account} (${profile.plan})` : (profile.account ?? profile.plan);
  return [profile.config, account, profile.endpoint, profile.key && `key ${profile.key}`, profile.model].filter(Boolean).join(' · ');
}

/** Tokens of requests to the model. */
export interface TokenCounts {
  /** Input sent without the cache. */
  input: number;
  /** Input read from the cache, cheaper than new input. */
  cacheRead: number;
  /** Input written to the cache. */
  cacheWrite: number;
  /** Output, reasoning included. */
  output: number;
}

export function noTokens(): TokenCounts {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return { input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output };
}

export function totalTokens(t: TokenCounts): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output;
}

/** The context window of a model, and whether the agent reports it or the recipe assumes it. */
export interface ContextWindow {
  tokens: number;
  exact: boolean;
}

/** What the UI shows on an agent's tab, sent with every state. */
export interface AgentUsage {
  /** Tokens in the context at the last request. */
  context: number;
  window?: ContextWindow;
  model?: string;
  /** All requests of the current session, its subagents included. */
  session: TokenCounts;
}

/** A part of the context: a file the agent read, a command's output, the user's messages. */
export interface ContextPart {
  label: string;
  tokens: number;
}

export interface PromptUsage {
  at: number;
  /** The start of the user's message. */
  text: string;
  requests: number;
  tokens: TokenCounts;
}

export interface UsageTotals {
  tokens: TokenCounts;
  /** Sessions counted, e.g. after /clear or with several agents. */
  sessions: number;
}

/** The usage window of an agent, asked for when the user opens it. */
export interface UsageDetails {
  terminalId: string;
  /** The recipe that reads the agent's sessions, e.g. "claude-code". */
  agent: string;
  model?: string;
  context: number;
  window?: ContextWindow;
  /** What fills the context, biggest first. Estimated: the agent reports only the total. */
  parts: ContextPart[];
  /** Compactions of the session, oldest first. */
  compactions: { at: number; before: number; after: number }[];
  session: { tokens: TokenCounts; requests: number; subagents: TokenCounts };
  /** The user's messages of the session with what each cost, newest first. */
  prompts: PromptUsage[];
  /** Every session of this tab. */
  tab: UsageTotals;
  /** Every session of every agent of the tab's workspace, closed tabs included. */
  workspace: UsageTotals;
}

/** 1234 → "1.2k", 1234567 → "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, '')}M`;
}

/** How full the context is, 0–100, or null when the window is unknown. */
export function contextPercent(usage: Pick<AgentUsage, 'context' | 'window'>): number | null {
  if (!usage.window?.tokens) return null;
  return Math.min(100, Math.round((usage.context / usage.window.tokens) * 100));
}
