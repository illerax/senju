import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentProfile, endpointOf, keyHint, optionValue, topLevelToml } from '../src/daemon/agent-profile';
import { profileText } from '../src/shared/usage';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-profile-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function folder(name: string, files: Record<string, unknown>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

describe('Claude Code profiles', () => {
  it('names the configuration folder, the account and the model it is set to', async () => {
    const dir = folder('claude-work', {
      'settings.json': { model: 'opus' },
      '.claude.json': { oauthAccount: { emailAddress: 'me@work.example', planDisplayName: 'Max' } },
    });
    const profile = await agentProfile('claude-code', { CLAUDE_CONFIG_DIR: dir }, []);
    expect(profile).toEqual({ config: dir, account: 'me@work.example', plan: 'Max', endpoint: undefined, key: undefined, model: 'opus' });
    expect(profileText(profile)).toBe(`${dir} · me@work.example (Max) · opus`);
  });

  it('shows another API behind Claude Code and the end of its key, not the account', async () => {
    const dir = folder('claude-kimi', {
      'settings.json': { env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-moonshot-0123456789abcd', ANTHROPIC_MODEL: 'kimi-k3' } },
      '.claude.json': { oauthAccount: { emailAddress: 'me@example.com' } },
    });
    const profile = await agentProfile('claude-code', { CLAUDE_CONFIG_DIR: dir }, []);
    expect(profile).toMatchObject({ endpoint: 'api.moonshot.ai', key: '…abcd', model: 'kimi-k3' });
    expect(profile.account).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain('0123456789');
  });

  it('prefers the command line and the environment to the settings', async () => {
    const dir = folder('claude-flags', { 'settings.json': { model: 'opus' } });
    const profile = await agentProfile('claude-code', { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: 'sk-ant-api-xxxxxxxx9f2e' }, ['--model=sonnet', '-p']);
    expect(profile).toMatchObject({ key: '…9f2e', model: 'sonnet' });
    expect((await agentProfile('claude-code', { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_USE_BEDROCK: '1' }, [])).endpoint).toBe('Amazon Bedrock');
  });

  it('shows nothing for a configuration it cannot read', async () => {
    const profile = await agentProfile('claude-code', { CLAUDE_CONFIG_DIR: path.join(root, 'missing') }, []);
    expect(profile).toEqual({ config: path.join(root, 'missing'), account: undefined, plan: undefined, endpoint: undefined, key: undefined, model: undefined });
  });
});

describe('Codex profiles', () => {
  const jwt = (claims: unknown) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

  it('reads the model and the ChatGPT account', async () => {
    const dir = folder('codex', {
      'config.toml': 'model = "gpt-5.6"\napproval_policy = "never"\n\n[projects."/p"]\nmodel = "other"\n',
      'auth.json': { tokens: { id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }) } },
    });
    expect(await agentProfile('codex', { CODEX_HOME: dir }, [])).toEqual({ config: dir, account: 'me@example.com', plan: 'pro', endpoint: undefined, key: undefined, model: 'gpt-5.6' });
    expect((await agentProfile('codex', { CODEX_HOME: dir }, ['-m', 'o5'])).model).toBe('o5');
  });

  it('names another provider', async () => {
    const dir = folder('codex-local', { 'config.toml': 'model_provider = "ollama"\nmodel = "qwen"\n' });
    expect(await agentProfile('codex', { CODEX_HOME: dir }, [])).toMatchObject({ endpoint: 'ollama', model: 'qwen' });
  });
});

describe('profile helpers', () => {
  it('keeps only the end of long keys', () => {
    expect(keyHint('sk-ant-0123456789')).toBe('…6789');
    expect(keyHint('short')).toBeUndefined();
    expect(keyHint(undefined)).toBeUndefined();
  });
  it("hides the agent's own API", () => {
    expect(endpointOf('https://api.anthropic.com', /(^|\.)anthropic\.com$/)).toBeUndefined();
    expect(endpointOf('http://localhost:4000/v1', /(^|\.)anthropic\.com$/)).toBe('localhost:4000');
  });
  it('reads options in both forms', () => {
    expect(optionValue(['--model', 'opus'], ['--model'])).toBe('opus');
    expect(optionValue(['--model=opus'], ['--model'])).toBe('opus');
    expect(optionValue(['--modelx'], ['--model'])).toBeUndefined();
  });
  it('reads the top of a TOML file only', () => {
    expect(topLevelToml('a = "1"\n# c\nb="x \\"y\\""\n[t]\nc = "3"')).toEqual({ a: '1', b: 'x \\"y\\"' });
  });
});
