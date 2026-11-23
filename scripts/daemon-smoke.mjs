// End-to-end check of the daemon: panes, job detection, persistence and restore.
// Usage: node scripts/daemon-smoke.mjs  (after npm run build)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-smoke-'));
// A stand-in for Claude Code: records its session per pid like the real one does.
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, 'claude'),
  `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const args = process.argv.slice(2);
const r = args.indexOf('--resume');
const id = r >= 0 ? args[r + 1] : crypto.randomUUID();
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: id }));
console.log((r >= 0 ? 'resumed ' : 'started ') + id + ' args=' + args.join(' '));
// The session's transcript, where Claude Code records the tokens of each request.
const transcript = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl');
function answer() {
  const usage = (cacheWrite, output) => ({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: cacheWrite, output_tokens: output });
  const reply = (mid, u, block) => ({ type: 'assistant', cwd: process.cwd(), message: { id: mid, model: 'claude-sonnet-5-5', usage: u, content: [block] } });
  const lines = [
    { type: 'user', message: { role: 'user', content: 'add a test' }, timestamp: new Date().toISOString() },
    reply('m1', usage(50000, 10), { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: process.cwd() + '/src/app.ts' } }),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(40000) }] } },
    reply('m2', usage(60000, 20), { type: 'text', text: 'Done.' }),
  ];
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(transcript, lines.map((l) => JSON.stringify(l) + String.fromCharCode(10)).join(''));
}
// Keys report hook events as Claude Code does: through the plugin Senju puts into CLAUDE_CODE_PLUGIN_DIRS.
const hookEvents = {
  p: [{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }],
  a: [{ hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { file_path: process.cwd() + '/src/app.ts' } }],
  s: [{ hook_event_name: 'Stop' }],
  b: [{ hook_event_name: 'Stop', background_tasks: [{ id: 'b1', type: 'shell', status: 'running', command: 'npm run build' }], session_crons: [] }],
};
function hook(event) {
  const plugin = (process.env.CLAUDE_CODE_PLUGIN_DIRS || '').split(':').pop();
  const { hooks } = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8'));
  require('child_process').execFileSync('sh', ['-c', hooks[event.hook_event_name][0].hooks[0].command], { input: JSON.stringify({ ...event, cwd: process.cwd(), transcript_path: transcript }) });
}
process.stdin.setRawMode(true);
// A background command runs as a child of the agent, as in Claude Code; k ends it.
let background = null;
process.stdin.on('data', (d) => {
  if (d[0] === 3) process.exit(0);
  if (d.toString() === 'b') background = require('child_process').spawn('sleep', ['600']);
  if (d.toString() === 'k') background?.kill();
  if (d.toString() === 'u') answer();
  for (const event of hookEvents[d.toString()] ?? []) hook(event);
});
`,
  { mode: 0o755 },
);
// A user recipe overriding the built-in one, pointing at the stand-in.
const builtin = JSON.parse(fs.readFileSync('recipes/claude-code.json', 'utf8'));
fs.mkdirSync(path.join(home, 'recipes'));
fs.writeFileSync(
  path.join(home, 'recipes', 'claude.json'),
  JSON.stringify({ ...builtin, resume: `${bin}/claude \${flags} --resume \${sessionId}`, fallback: `${bin}/claude \${flags} --continue` }),
);
// The daemon inherits paths of AppImage mounts, as it does when an updated
// AppImage was started by the previous one; shells must not get them.
const env = {
  ...process.env,
  SENJU_HOME: home,
  ELECTRON_RUN_AS_NODE: '1',
  XDG_RUNTIME_DIR: home,
  PATH: `${bin}:/tmp/.mount_senjuOld123/usr/bin:${process.env.PATH}`,
  LD_LIBRARY_PATH: '/tmp/.mount_senjuOld123/usr/lib:/opt/senju-smoke/lib',
};
const socketPath = path.join(home, 'daemon.sock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

function startDaemon() {
  const child = spawn(electron, ['dist/daemon.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[daemon] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`[daemon:err] ${d}`));
  return child;
}

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const s = net.connect(socketPath);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
    } catch {
      await sleep(100);
    }
  }
  throw new Error('no daemon');
}

async function client() {
  const socket = await connect();
  const c = { state: null, output: {}, socket };
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.type === 'state') c.state = msg.state;
      if (msg.type === 'error') (c.errors ??= []).push(msg.message);
      if (msg.type === 'peek') c.peek = msg.screens;
      if (msg.type === 'usage') c.usage = msg.details;
      if (msg.type === 'snapshot' || msg.type === 'data') c.output[msg.terminalId] = (c.output[msg.terminalId] ?? '') + msg.data;
    }
  });
  c.send = (msg) => socket.write(`${JSON.stringify(msg)}\n`);
  c.send({ type: 'hello', protocol: 3 });
  await waitFor(() => c.state);
  return c;
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

const panesOf = (node) => (node.type === 'pane' ? [node] : node.children.flatMap(panesOf));
const workspaces = () => c.state.groups[0].workspaces;
const focusedPane = (workspace) => panesOf(workspace.root).find((p) => p.id === workspace.focusedPaneId);
const term = (id) => c.state.terminals[id];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-work-'));
fs.mkdirSync(path.join(work, 'sub'));

// 1. Fresh daemon: create a group and run things.
let daemon = startDaemon();
let c = await client();
c.send({ type: 'action', action: { type: 'createGroup', name: 'smoke', cwd: work } });
await waitFor(() => c.state.groups.length === 1);
const group = c.state.groups[0];
const paneA = focusedPane(workspaces()[0]).id;
const termA = focusedPane(workspaces()[0]).activeTab;
c.send({ type: 'attach', terminalId: termA });
c.send({ type: 'input', terminalId: termA, data: 'cd sub && echo hello-senju\r' });
check(await waitFor(() => c.output[termA]?.includes('hello-senju')), 'terminal runs shell commands');
check(await waitFor(() => term(termA).cwd === path.join(work, 'sub')), 'working directory is tracked');
c.send({ type: 'input', terminalId: termA, data: 'echo "en""v:$LD_LIBRARY_PATH:$PATH:e""nd"\r' });
const shellEnv = await waitFor(() => /env:(.*):end/.exec(c.output[termA] ?? '')?.[1]);
const cleanEnv = !!shellEnv && !shellEnv.includes('.mount_') && shellEnv.startsWith('/opt/senju-smoke/lib:');
check(cleanEnv, `the shell gets no AppImage mount paths${cleanEnv ? '' : ` (${shellEnv})`}`);

c.send({ type: 'action', action: { type: 'splitPane', paneId: paneA, side: 'right' } });
await waitFor(() => Object.keys(c.state.terminals).length === 2);
const termB = focusedPane(workspaces()[0]).activeTab;
c.send({ type: 'attach', terminalId: termB });
c.send({ type: 'input', terminalId: termB, data: 'MYVAR=42 sleep 1000\r' });
check(await waitFor(() => term(termB).job?.argv?.[0] === 'sleep'), 'foreground job is detected');

c.send({ type: 'action', action: { type: 'createTab', paneId: paneA } });
await waitFor(() => Object.keys(c.state.terminals).length === 3);
const termT = panesOf(workspaces()[0].root).find((p) => p.id === paneA).activeTab;
check(panesOf(workspaces()[0].root).find((p) => p.id === paneA).tabs.join() === [termA, termT].join(), 'a pane holds several tabs');

c.send({ type: 'action', action: { type: 'createWorkspace', groupId: group.id } });
await waitFor(() => workspaces().length === 2);
const termC = focusedPane(workspaces()[1]).activeTab;
c.send({ type: 'input', terminalId: termC, data: 'tail -f /dev/null\r' });
check(await waitFor(() => term(termC).job?.argv?.[0] === 'tail'), 'second workspace job is detected');

// 2. A client disconnect keeps processes alive; a new client gets the screen back.
c.socket.destroy();
await sleep(300);
c = await client();
c.send({ type: 'attach', terminalId: termA });
check(await waitFor(() => c.output[termA]?.includes('hello-senju')), 'reattach restores the screen');
check(term(termB).job?.argv?.[0] === 'sleep', 'job survives UI disconnect');

// 3. Daemon killed (like a reboot): state is restored on the next start.
const savedState = () => JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
check(savedState().terminals[termB].job?.env?.MYVAR === '42', 'job environment is saved');
daemon.kill('SIGTERM');
await new Promise((r) => daemon.once('exit', r));
const saved = savedState();
const scrollbackOf = (id) => fs.readFileSync(path.join(home, 'scrollback', `${id}.ansi`), 'utf8');
check(scrollbackOf(termA).includes('hello-senju'), 'scrollback is saved on shutdown, in its own file');
check(!JSON.stringify(saved).includes('hello-senju'), 'the state file holds no scrollback');
check(saved.terminals[termB].job?.argv?.[0] === 'sleep', 'running job is kept on shutdown');

daemon = startDaemon();
c = await client();
check(workspaces().length === 2, 'groups and workspaces are restored');
check(panesOf(workspaces()[0].root).find((p) => p.id === paneA)?.tabs.length === 2, 'tabs are restored');
check(term(termA).cwd === path.join(work, 'sub'), 'working directory is restored');
check(term(termB).pending?.command === 'sleep 1000', 'non-listed command waits for "Run again"');
check(await waitFor(() => term(termC).job?.argv?.[0] === 'tail'), 'listed command restarts automatically');
c.send({ type: 'attach', terminalId: termA });
check(await waitFor(() => c.output[termA]?.includes('hello-senju') && c.output[termA]?.includes('restored')), 'scrollback is restored');
c.send({ type: 'peek', terminalIds: [termA, 'missing'], lines: 30 });
check(await waitFor(() => c.peek?.[termA]?.some((line) => line.includes('hello-senju')) && !('missing' in c.peek)), 'peek returns the last lines of a screen');

c.send({ type: 'action', action: { type: 'runPending', terminalId: termB } });
check(await waitFor(() => term(termB).job?.argv?.[0] === 'sleep'), '"Run again" starts the command');
check(await waitFor(() => savedState().terminals[termB].env?.MYVAR === '42'), 'restored command gets its environment');

// Agents: two Claude Code terminals in one directory, each with its own session.
c.send({ type: 'action', action: { type: 'createWorkspace', groupId: group.id } });
await waitFor(() => workspaces().length === 3);
const agentWorkspace = () => c.state.groups[0].workspaces.find((w) => panesOf(w.root).some((p) => p.tabs.includes(termD)));
const termD = focusedPane(workspaces().find((w) => w.id === c.state.windows[0].activeWorkspaceId)).activeTab;
c.send({ type: 'action', action: { type: 'splitPane', paneId: focusedPane(agentWorkspace()).id, side: 'down' } });
await waitFor(() => agentWorkspace().root.type === 'split');
const termE = focusedPane(agentWorkspace()).activeTab;
const cc = path.join(home, 'cc config');
fs.mkdirSync(cc, { recursive: true });
fs.writeFileSync(path.join(cc, 'settings.json'), JSON.stringify({ model: 'opus' }));
fs.writeFileSync(path.join(cc, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com', planDisplayName: 'Max' } }));
for (const id of [termD, termE]) {
  c.send({ type: 'attach', terminalId: id });
  c.send({ type: 'input', terminalId: id, data: `cd ${work} && CLAUDE_CONFIG_DIR='${cc}' ${bin}/claude --dangerously-skip-permissions "fix it"\r` });
}
const sessions = await waitFor(() => {
  const d = term(termD).job?.sessionId;
  const e = term(termE).job?.sessionId;
  return d && e ? [d, e] : null;
});
check(sessions && sessions[0] !== sessions[1], 'each agent terminal has its own session');
check(term(termD).job?.recipe === 'claude-code', 'agent is recognised by recipe');
const agentIs = (state, activity) => () => term(termD).agent?.state === state && term(termD).agent?.activity === activity;
c.send({ type: 'input', terminalId: termD, data: 'p' });
check(await waitFor(agentIs('working', 'Bash: npm test')), 'agent hooks report the tool it runs');
c.send({ type: 'input', terminalId: termD, data: 'a' });
check(await waitFor(agentIs('permission', 'Edit src/app.ts')), 'agent hooks report a permission request');
// Refusing with Escape reports no event: the keys and the quiet after them do.
c.send({ type: 'input', terminalId: termD, data: '\x1b' });
check(await waitFor(agentIs('waiting', undefined)), 'an agent the user stopped is no longer waiting for permission');
c.send({ type: 'input', terminalId: termD, data: 'b' });
check(await waitFor(agentIs('background', 'Bash: npm run build')), 'agent hooks report a turn that waits for a background task');
await sleep(2500);
check(term(termD).agent?.state === 'background', 'an agent stays in the background while its command runs');
c.send({ type: 'input', terminalId: termD, data: 'k' });
// Claude Code may keep listing a task whose process is gone.
check(await waitFor(agentIs('done', undefined), 25_000), 'an agent whose background commands are gone counts as finished');
const stopped = fs.readFileSync(path.join(home, 'diagnostics.log'), 'utf8').split('\n').filter((l) => l.includes('agent stopped with background work'));
check(stopped.length === 1 && stopped[0].includes('shell:running') && !stopped[0].includes('npm run build'), 'diagnostics.log records background task types, not commands');
// A new turn first: the agent is already finished, and keys sent at once would arrive as one.
c.send({ type: 'input', terminalId: termD, data: 'p' });
await waitFor(agentIs('working', 'Bash: npm test'));
c.send({ type: 'input', terminalId: termD, data: 's' });
check(await waitFor(agentIs('done', undefined)), 'agent hooks report the end of the turn');
check(fs.readdirSync(path.join(home, 'events')).length === 0, 'reported events are removed');

// Context and tokens, read from the agent's session file.
c.send({ type: 'input', terminalId: termD, data: 'u' });
check(await waitFor(() => c.state.usage?.[termD]?.context === 60000), "agent's context is read from its session file");
const usage = c.state.usage?.[termD];
check(usage?.window?.tokens === 200000 && usage.session.output === 30 && usage.model === 'claude-sonnet-5-5', `context window and tokens (${JSON.stringify(usage)})`);
check(!c.state.usage?.[termE], 'an agent that has not answered shows no usage');
const profileE = c.state.profiles?.[termE];
check(profileE?.config === cc && profileE.account === 'dev@example.com' && profileE.plan === 'Max' && profileE.model === 'opus', `agent profile: configuration, account and the model it is set to (${JSON.stringify(profileE)})`);
check(c.state.profiles?.[termD]?.model === 'claude-sonnet-5-5', 'agent profile shows the model it answered with');
c.send({ type: 'usage', terminalId: termD });
const details = await waitFor(() => c.usage);
const read = details?.parts.find((p) => p.label === 'Read src/app.ts');
check(read && read.tokens > 9000, `usage window names what fills the context (${JSON.stringify(details?.parts)})`);
check(details?.prompts[0]?.text === 'add a test' && details.prompts[0].requests === 2, 'usage window lists the messages with their requests');
check(details?.tab.sessions === 1 && details.workspace.sessions === 1, 'usage of the tab and workspace counts the session');
check(await waitFor(() => savedState().terminals[termD].agentSessions?.length === 1), "the tab's sessions are saved for its totals");
check(!c.state.terminals[termD].agentSessions, 'session files are not sent to the UI');
await sleep(300);

daemon.kill('SIGTERM');
await new Promise((r) => daemon.once('exit', r));
daemon = startDaemon();
c = await client();
for (const id of [termD, termE]) c.send({ type: 'attach', terminalId: id });
check(await waitFor(() => c.output[termD]?.includes(`resumed ${sessions?.[0]}`)), 'agent resumes its own session after restart');
check(await waitFor(() => c.output[termE]?.includes(`resumed ${sessions?.[1]}`)), 'second agent resumes its own session');
check(c.output[termD]?.includes('args=--dangerously-skip-permissions --resume'), 'agent keeps its options, not its prompt');
check(await waitFor(() => term(termE).job?.sessionId === sessions?.[1]), 'resumed agent is tracked again');
check(await waitFor(() => c.state.usage?.[termD]?.context === 60000), 'resumed agent shows the usage of its session again');

// The user closes an agent: it does not come back.
c.send({ type: 'input', terminalId: termE, data: '\x03' });
check(await waitFor(() => !term(termE).job, 6000), 'closed agent is forgotten');
daemon.kill('SIGTERM');
await new Promise((r) => daemon.once('exit', r));
daemon = startDaemon();
c = await client();
c.send({ type: 'attach', terminalId: termE });
await sleep(1500);
check(!term(termE).job && (c.output[termE].match(/resumed/g) ?? []).length === 1, 'closed agent is not started after restart');
check(term(termB).pending?.command === 'sleep 1000', 'a job started with "Run again" is offered again');

// Closing a group to disk and opening it again: at its place, with its agent resuming.
c.send({ type: 'action', action: { type: 'createGroup', name: 'closable', cwd: work } });
await waitFor(() => c.state.groups.some((g) => g.name === 'closable'));
const closableIndex = () => c.state.groups.findIndex((g) => g.name === 'closable');
const index = closableIndex();
const closableTerminal = () => focusedPane(c.state.groups[closableIndex()].workspaces[0]).activeTab;
const termG = closableTerminal();
c.send({ type: 'attach', terminalId: termG });
c.send({ type: 'input', terminalId: termG, data: `echo closable-marker && CLAUDE_CONFIG_DIR='${cc}' ${bin}/claude "start"\r` });
const closableSession = await waitFor(() => term(termG)?.job?.sessionId);
c.send({ type: 'action', action: { type: 'closeGroup', groupId: c.state.groups[index].id } });
check(await waitFor(() => closableIndex() < 0 && c.state.closedGroups?.[0]?.name === 'closable' && !term(termG)), 'a closed group leaves the sidebar and its terminals stop');
check(fs.readdirSync(path.join(home, 'closed-groups')).length === 1, 'a closed group is saved to disk');
c.send({ type: 'action', action: { type: 'reopenGroup', closedId: c.state.closedGroups[0].id } });
check(await waitFor(() => closableIndex() === index && c.state.closedGroups?.length === 0), 'a reopened group returns to its place');
const termG2 = closableTerminal();
c.send({ type: 'attach', terminalId: termG2 });
check(termG2 !== termG && (await waitFor(() => c.output[termG2]?.includes(`resumed ${closableSession}`))), 'its agent resumes its session');
check(c.output[termG2]?.includes('closable-marker'), 'its scrollback comes back');
check(fs.readdirSync(path.join(home, 'closed-groups')).length === 0, 'a reopened group is removed from disk');
const exported = path.join(home, 'closable.senju');
c.send({ type: 'action', action: { type: 'exportGroup', groupId: c.state.groups[index].id, file: exported } });
check(await waitFor(() => fs.existsSync(exported)), 'a group can be saved to a file');
c.send({ type: 'action', action: { type: 'importGroup', file: exported } });
check(await waitFor(() => c.state.groups.filter((g) => g.name === 'closable').length === 2), 'a saved file opens as a copy next to the group');
for (const g of c.state.groups.filter((g) => g.name === 'closable')) c.send({ type: 'action', action: { type: 'deleteGroup', groupId: g.id } });
c.send({ type: 'action', action: { type: 'importGroup', file: path.join(home, 'missing.senju') } });
check(await waitFor(() => c.errors?.some((m) => m.includes('missing.senju'))), 'a file that cannot be opened is reported');
await waitFor(() => closableIndex() < 0);

// 4. A job the user stops is not restored.
c.send({ type: 'input', terminalId: termC, data: '\x03' });
check(await waitFor(() => !term(termC).job, 6000), 'stopped job is cleared');

// 5. Exiting the shell closes the tab; the pane stays with its other tab.
c.send({ type: 'input', terminalId: termA, data: 'exit\r' });
check(await waitFor(() => !term(termA)), 'shell exit closes the tab');
check(await waitFor(() => !fs.existsSync(path.join(home, 'scrollback', `${termA}.ansi`))), 'a closed terminal leaves no scrollback file');
check(panesOf(workspaces()[0].root).find((p) => p.id === paneA)?.tabs.join() === termT, 'the pane keeps its other tab');

c.send({ type: 'shutdown' });
await new Promise((r) => daemon.once('exit', r));
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
