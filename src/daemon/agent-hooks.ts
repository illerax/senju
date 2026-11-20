// Exact agent status from Claude Code hooks. Every terminal gets a plugin
// directory in CLAUDE_CODE_PLUGIN_DIRS whose hooks drop each event as a JSON
// file into a spool directory, named after the terminal (SENJU_TERMINAL_ID).
// The daemon reads and deletes the files and keeps the agent's state on the
// terminal. Nothing in the user's own Claude Code settings is changed; outside
// Senju the variables are not set and the hooks do nothing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentState } from '../shared/types';

/** The events Senju listens to; each one only reports, never decides. */
const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
];

/**
 * Writes the event to a hidden file, then renames it, so the daemon never
 * reads half an event. POSIX sh only: Claude Code runs hooks with sh on Unix
 * and Git Bash on Windows. Exits 0 in every case, as a failing hook shows an
 * error in Claude Code on each event.
 */
const HOOK_COMMAND =
  '[ -d "$SENJU_EVENTS" ] || exit 0; f=$(mktemp "$SENJU_EVENTS/.$SENJU_TERMINAL_ID.XXXXXX") || exit 0; cat > "$f" && mv "$f" "$SENJU_EVENTS/${f##*/.}.json"; exit 0';

/** Writes the plugin with the hooks; Claude Code loads it from CLAUDE_CODE_PLUGIN_DIRS. */
export async function writeHookPlugin(dir: string): Promise<void> {
  const hooks = Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }]]));
  await fs.promises.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await fs.promises.mkdir(path.join(dir, 'hooks'), { recursive: true });
  const manifest = { name: 'senju', version: '1.0.0', description: 'Reports agent status to the Senju terminal' };
  await fs.promises.writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.promises.writeFile(path.join(dir, 'hooks', 'hooks.json'), `${JSON.stringify({ hooks }, null, 2)}\n`);
}

/** Variables that let Claude Code in a terminal report to the daemon, keeping plugin directories the user set. */
export function hookEnv(terminalId: string, pluginDir: string, spoolDir: string, base: Record<string, string>): Record<string, string> {
  const separator = process.platform === 'win32' ? ';' : ':';
  const dirs = (base.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(separator).filter((d) => d && d !== pluginDir);
  return {
    SENJU_TERMINAL_ID: terminalId,
    SENJU_EVENTS: spoolDir,
    CLAUDE_CODE_PLUGIN_DIRS: [...dirs, pluginDir].join(separator),
  };
}

/** The fields of a hook event Senju reads. */
export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  notification_type?: string;
  message?: string;
  error?: unknown;
  error_type?: unknown;
  reason?: unknown;
}

/** The agent's state after an event. Unknown events leave the state as it is. */
export function applyHookEvent(previous: AgentState | undefined, event: HookEvent, now: number): AgentState | undefined {
  const at = now;
  switch (event.hook_event_name) {
    case 'SessionStart':
      return { state: 'done', at };
    case 'SessionEnd':
      // Kept until the program is gone, so its exit is not taken for waiting.
      return { state: 'ended', at };
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { state: 'working', at };
    case 'PreToolUse':
      // AskUserQuestion shows its questions as soon as it runs.
      if (event.tool_name === 'AskUserQuestion') return { state: 'question', activity: toolActivity(event), at };
      return { state: 'working', activity: toolActivity(event), at };
    case 'PermissionRequest':
      return { state: 'permission', activity: toolActivity(event), at };
    case 'Notification':
      if (event.notification_type === 'permission_prompt') return { state: 'permission', activity: previous?.activity, at };
      if (event.notification_type === 'elicitation_dialog' || event.notification_type === 'agent_needs_input') {
        return { state: 'question', activity: previous?.activity, at };
      }
      return previous;
    case 'Stop':
      return { state: 'done', at };
    case 'StopFailure': {
      const reason = [event.error_type, event.error, event.reason].find((v) => typeof v === 'string' && v) as string | undefined;
      return { state: 'error', error: reason?.replace(/_/g, ' '), at };
    }
    default:
      return previous;
  }
}

const MAX_ACTIVITY = 80;
const MAX_PATH = 60;

/** What a tool call does, in a few words: "Edit src/app.ts", "Bash: npm test". */
export function toolActivity(event: Pick<HookEvent, 'tool_name' | 'tool_input' | 'cwd'>): string | undefined {
  const tool = event.tool_name;
  if (!tool) return undefined;
  const input = event.tool_input ?? {};
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  // Files show relative to the agent's folder, or from ~; a long path keeps its end, which names the file.
  const file = (key: string) => {
    const value = text(key);
    const relative = value && event.cwd ? path.relative(event.cwd, value) : '';
    const home = os.homedir();
    const shown =
      relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative
        : value.startsWith(home + path.sep)
          ? `~${value.slice(home.length)}`
          : value;
    return shown.length > MAX_PATH ? `…${shown.slice(-(MAX_PATH - 1))}` : shown;
  };
  let detail: string;
  switch (tool) {
    case 'Bash':
      detail = `: ${text('command').split('\n')[0]}`;
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      detail = ` ${file('file_path')}`;
      break;
    case 'NotebookEdit':
      detail = ` ${file('notebook_path')}`;
      break;
    case 'Grep':
    case 'Glob':
      detail = ` ${text('pattern')}`;
      break;
    case 'WebFetch':
      detail = ` ${text('url')}`;
      break;
    case 'WebSearch':
      detail = ` ${text('query')}`;
      break;
    case 'Task':
    case 'Agent':
      detail = `: ${text('description')}`;
      break;
    default: {
      // MCP tools are named mcp__<server>__<tool>.
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      return truncate(mcp ? `${mcp[2]} (${mcp[1]})` : tool);
    }
  }
  return truncate(detail.trim() === ':' || !detail.trim() ? tool : `${tool}${detail}`);
}

function truncate(text: string): string {
  return text.length > MAX_ACTIVITY ? `${text.slice(0, MAX_ACTIVITY - 1)}…` : text;
}

/**
 * Reads the events the hooks drop into a directory, oldest first, and deletes
 * them. A file's name starts with the terminal id.
 */
export class EventSpool {
  private reading = false;
  private again = false;
  private watcher: fs.FSWatcher | null = null;

  constructor(
    readonly dir: string,
    private readonly onEvent: (terminalId: string, event: HookEvent) => void,
  ) {}

  async start(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Events from before this start describe agents that may be gone.
    for (const name of await fs.promises.readdir(this.dir)) await fs.promises.rm(path.join(this.dir, name), { force: true }).catch(() => {});
    try {
      this.watcher = fs.watch(this.dir, () => void this.read());
      this.watcher.on('error', () => {});
    } catch {
      // Without a watcher the periodic read still picks events up.
    }
    setInterval(() => void this.read(), 1000).unref();
  }

  stop(): void {
    this.watcher?.close();
  }

  private async read(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.again = false;
        const names = (await fs.promises.readdir(this.dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
        if (names.length === 0) break;
        const files = await Promise.all(
          names.map(async (name) => {
            const file = path.join(this.dir, name);
            const stat = await fs.promises.stat(file, { bigint: true }).catch(() => null);
            return { name, file, time: stat?.mtimeNs ?? 0n };
          }),
        );
        files.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
        for (const { name, file } of files) {
          const text = await fs.promises.readFile(file, 'utf8').catch(() => null);
          await fs.promises.rm(file, { force: true }).catch(() => {});
          if (text === null) continue;
          let event: HookEvent;
          try {
            event = JSON.parse(text) as HookEvent;
          } catch {
            continue;
          }
          // <terminal id>.<random>.json
          this.onEvent(name.slice(0, name.lastIndexOf('.', name.length - '.json'.length - 1)), event);
        }
      } while (this.again);
    } finally {
      this.reading = false;
    }
  }
}
