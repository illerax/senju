import { describe, expect, it } from 'vitest';
import { applyHookEvent, hookEnv, toolActivity } from '../src/daemon/agent-hooks';

describe('agent hook events', () => {
  const at = 1000;
  it('follows a turn from the prompt to the end', () => {
    let agent = applyHookEvent(undefined, { hook_event_name: 'SessionStart' }, at);
    expect(agent?.state).toBe('done');
    agent = applyHookEvent(agent, { hook_event_name: 'UserPromptSubmit' }, at);
    expect(agent).toEqual({ state: 'working', at });
    agent = applyHookEvent(agent, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test\necho done' } }, at);
    expect(agent).toEqual({ state: 'working', activity: 'Bash: npm test', at });
    agent = applyHookEvent(agent, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }, at);
    expect(agent).toEqual({ state: 'permission', activity: 'Bash: rm -rf dist', at });
    agent = applyHookEvent(agent, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, at);
    expect(agent).toEqual({ state: 'working', at });
    agent = applyHookEvent(agent, { hook_event_name: 'Stop' }, at);
    expect(agent?.state).toBe('done');
    expect(applyHookEvent(agent, { hook_event_name: 'SessionEnd' }, at)?.state).toBe('ended');
  });

  it('tells questions, permission notifications and failures apart', () => {
    const working = { state: 'working' as const, activity: 'Edit a.ts', at };
    expect(applyHookEvent(working, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }, at)?.state).toBe('question');
    expect(applyHookEvent(working, { hook_event_name: 'Notification', notification_type: 'permission_prompt' }, at)).toEqual({ state: 'permission', activity: 'Edit a.ts', at });
    expect(applyHookEvent(working, { hook_event_name: 'Notification', notification_type: 'idle_prompt' }, at)).toBe(working);
    expect(applyHookEvent(working, { hook_event_name: 'StopFailure', error_type: 'rate_limit' }, at)).toEqual({ state: 'error', error: 'rate limit', at });
    expect(applyHookEvent(working, { hook_event_name: 'SomethingNew' }, at)).toBe(working);
  });
});

describe('tool activity', () => {
  it('names the tool and what it works on', () => {
    expect(toolActivity({ tool_name: 'Edit', tool_input: { file_path: '/p/src/app.ts' }, cwd: '/p' })).toBe('Edit src/app.ts');
    expect(toolActivity({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, cwd: '/p' })).toBe('Read /etc/hosts');
    const long = `/srv/${'deep/'.repeat(20)}name.ts`;
    expect(toolActivity({ tool_name: 'Write', tool_input: { file_path: long }, cwd: '/p' })).toMatch(/^Write ….*\/name\.ts$/);
    expect(toolActivity({ tool_name: 'Grep', tool_input: { pattern: 'TODO' } })).toBe('Grep TODO');
    expect(toolActivity({ tool_name: 'Task', tool_input: { description: 'Find usages' } })).toBe('Task: Find usages');
    expect(toolActivity({ tool_name: 'mcp__github__create_issue', tool_input: {} })).toBe('create_issue (github)');
    expect(toolActivity({ tool_name: 'Bash', tool_input: {} })).toBe('Bash');
    expect(toolActivity({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(200) } })?.length).toBe(80);
  });
});

describe('hook environment', () => {
  it('adds the plugin to the plugin directories the user set', () => {
    const env = hookEnv('t1', '/run/senju/claude-plugin', '/run/senju/events', { CLAUDE_CODE_PLUGIN_DIRS: '/mine:/run/senju/claude-plugin' });
    expect(env).toEqual({ SENJU_TERMINAL_ID: 't1', SENJU_EVENTS: '/run/senju/events', CLAUDE_CODE_PLUGIN_DIRS: '/mine:/run/senju/claude-plugin' });
    expect(hookEnv('t1', '/p', '/e', {}).CLAUDE_CODE_PLUGIN_DIRS).toBe('/p');
  });
});
