// What an agent runs with: its configuration folder, account, API endpoint,
// key and model, read from its environment, its command line and the files of
// its configuration (Claude Code's settings.json and .claude.json, Codex's
// config.toml and auth.json). Only the parts that tell agents apart are kept:
// never a whole key or token.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentProfile, UsageFormat } from '../shared/usage';

/** Parsed files by path, read again only when they change. */
const files = new Map<string, { mtimeMs: number; value: unknown }>();

async function readCached<T>(file: string, parse: (text: string) => T): Promise<T | undefined> {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat) return undefined;
  const cached = files.get(file);
  if (cached?.mtimeMs === stat.mtimeMs) return cached.value as T;
  let value: T | undefined;
  try {
    value = parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    value = undefined;
  }
  files.set(file, { mtimeMs: stat.mtimeMs, value });
  return value;
}

const readJson = (file: string) => readCached<Record<string, unknown>>(file, (text) => JSON.parse(text) as Record<string, unknown>);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** A path with the home folder as ~. */
export function tilde(file: string): string {
  const home = os.homedir();
  return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/** The end of a secret, enough to tell keys apart. */
export function keyHint(key: string | undefined): string | undefined {
  return key && key.length >= 12 ? `…${key.slice(-4)}` : undefined;
}

/** The host of an API address, unless it is the agent's own API. */
export function endpointOf(url: string | undefined, own: RegExp): string | undefined {
  if (!url) return undefined;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return url;
  }
  return own.test(host) ? undefined : host;
}

/** The value of an option such as --model, in either "--model x" or "--model=x" form. */
export function optionValue(argv: string[], names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    for (const name of names) {
      if (argv[i] === name && i + 1 < argv.length) return argv[i + 1];
      if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
    }
  }
  return undefined;
}

/** The claims of a JWT, without checking it: only to show who is signed in. */
function jwtClaims(token: string | undefined): Record<string, unknown> {
  const payload = token?.split('.')[1];
  if (!payload) return {};
  try {
    return record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  } catch {
    return {};
  }
}

/** The profile of an agent, by the format of its sessions. `env` is the agent's environment. */
export async function agentProfile(format: UsageFormat, env: Record<string, string | undefined>, argv: string[]): Promise<AgentProfile> {
  return format === 'claude-code' ? claudeProfile(env, argv) : codexProfile(env, argv);
}

async function claudeProfile(env: Record<string, string | undefined>, argv: string[]): Promise<AgentProfile> {
  const standard = path.join(os.homedir(), '.claude');
  // The default folder named explicitly is still the default.
  const own = env.CLAUDE_CONFIG_DIR && path.resolve(env.CLAUDE_CONFIG_DIR) !== standard ? env.CLAUDE_CONFIG_DIR : undefined;
  const dir = env.CLAUDE_CONFIG_DIR || standard;
  const settingsFile = optionValue(argv, ['--settings']);
  const settings = record(await readJson(path.join(dir, 'settings.json')));
  const extra = settingsFile && !settingsFile.trim().startsWith('{') ? record(await readJson(path.resolve(settingsFile))) : {};
  // Claude Code applies the env of its settings over the process environment.
  const vars: Record<string, string | undefined> = { ...env, ...record(settings.env), ...record(extra.env) } as Record<string, string | undefined>;
  const endpoint =
    vars.CLAUDE_CODE_USE_BEDROCK && vars.CLAUDE_CODE_USE_BEDROCK !== '0'
      ? 'Amazon Bedrock'
      : vars.CLAUDE_CODE_USE_VERTEX && vars.CLAUDE_CODE_USE_VERTEX !== '0'
        ? 'Google Vertex AI'
        : endpointOf(vars.ANTHROPIC_BASE_URL, /(^|\.)anthropic\.com$/);
  const key = keyHint(vars.ANTHROPIC_API_KEY) ?? keyHint(vars.ANTHROPIC_AUTH_TOKEN);
  const profile: AgentProfile = {
    config: own ? tilde(own) : undefined,
    endpoint,
    key,
    model: optionValue(argv, ['--model']) ?? vars.ANTHROPIC_MODEL ?? str(extra.model) ?? str(settings.model),
  };
  if (!endpoint && !key) {
    // Signed in to an Anthropic account: .claude.json in the configuration folder, or in the home folder for the default one.
    const account = record(record(await readJson(env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'))).oauthAccount);
    profile.account = str(account.emailAddress);
    profile.plan = str(account.planDisplayName);
  }
  return profile;
}

async function codexProfile(env: Record<string, string | undefined>, argv: string[]): Promise<AgentProfile> {
  const own = env.CODEX_HOME;
  const dir = own || path.join(os.homedir(), '.codex');
  const config = (await readCached(path.join(dir, 'config.toml'), topLevelToml)) ?? {};
  const auth = record(await readJson(path.join(dir, 'auth.json')));
  const provider = config.model_provider && config.model_provider !== 'openai' ? config.model_provider : undefined;
  const endpoint = provider ?? endpointOf(env.OPENAI_BASE_URL, /(^|\.)openai\.com$/);
  const key = keyHint(env.OPENAI_API_KEY) ?? keyHint(str(auth.OPENAI_API_KEY));
  const profile: AgentProfile = {
    config: own ? tilde(own) : undefined,
    endpoint,
    key,
    model: optionValue(argv, ['--model', '-m']) ?? config.model,
  };
  if (!endpoint && !key) {
    const claims = jwtClaims(str(record(auth.tokens).id_token));
    profile.account = str(claims.email);
    profile.plan = str(record(claims['https://api.openai.com/auth']).chatgpt_plan_type);
  }
  return profile;
}

/** The plain string keys at the top of a TOML file, before its first table. */
export function topLevelToml(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*([\w-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m) values[m[1]] = m[2];
  }
  return values;
}
