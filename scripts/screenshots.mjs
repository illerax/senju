// Takes the README screenshots in a throwaway environment: a neutral shell
// prompt, real commands, and a stand-in agent that prints like one.
// Usage: npm run screenshots  (writes docs/screenshots/*.png)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';

const repo = process.cwd();
const out = path.join(repo, 'docs', 'screenshots');
fs.mkdirSync(out, { recursive: true });
// A demo home of its own, so no real user name or path shows up in the pictures.
const home = path.join(os.tmpdir(), 'senju-demo');
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home);
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
const project = path.join(home, 'senju');
fs.cpSync(repo, project, { recursive: true, filter: (src) => !/[\\/](node_modules|dist|release|\.git|ui-smoke)$/.test(src) });
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(project, 'node_modules'));
for (const dir of ['website', 'infra']) fs.mkdirSync(path.join(home, dir));

// The stand-in agent: recognised by the Claude Code recipe, busy or idle on request.
fs.writeFileSync(
  path.join(bin, 'claude'),
  `#!/usr/bin/env node
const busy = process.argv.includes('--busy');
const y = (s) => '\\x1b[33m' + s + '\\x1b[0m', b = (s) => '\\x1b[34m' + s + '\\x1b[0m', g = (s) => '\\x1b[32m' + s + '\\x1b[0m', d = (s) => '\\x1b[2m' + s + '\\x1b[0m', r = (s) => '\\x1b[31m' + s + '\\x1b[0m';
const steps = busy
  ? [y('●') + ' Read ' + b('src/daemon/store.ts') + d(' (183 lines)'), y('●') + ' Edit ' + b('src/daemon/main.ts') + '  ' + g('+42') + ' ' + r('−7'), '  Saving the state no longer waits for the disk,', '  so keystrokes stay instant on a busy machine.', y('●') + ' Bash ' + d('npm test'), '  ' + g('✓') + ' 48 passed ' + d('(1.9 s)'), '']
  : [y('●') + ' Read ' + b('src/pages/pricing.tsx'), y('●') + ' The pricing table is ready for review.', '', d('  Should the yearly plan show the monthly price too?'), ''];
for (const s of steps) console.log(s);
// Its session as Claude Code records it, so the tab shows how full its context is.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const id = crypto.randomUUID();
const config = process.env.CLAUDE_CONFIG_DIR;
const model = config.includes('kimi') ? 'kimi-k3' : 'claude-opus-5-5';
fs.mkdirSync(path.join(config, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(config, 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: id }));
const transcript = path.join(config, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl');
fs.mkdirSync(path.dirname(transcript), { recursive: true });
const at = (m) => new Date(Date.now() - m * 60000).toISOString();
// Each request carries the result of the call before it.
let context = 0, n = 0, added = 24000;
const lines = [{ type: 'api-request-shape', shape: { system: ['x'.repeat(14000)], tools: [...Array(14)].map((_, i) => ({ name: 't' + i, d: 'x'.repeat(4000) })).concat([...Array(9)].map((_, i) => ({ name: 'mcp__github__t' + i, d: 'x'.repeat(2400) }))) } }];
lines.push({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: process.cwd() + '/CLAUDE.md', content: 'x'.repeat(26000) }] } });
const ask = (text, m) => lines.push({ type: 'user', message: { role: 'user', content: text }, timestamp: at(m) });
const call = (name, input, output, m) => {
  const grow = added;
  context += grow;
  added = Math.round(output / 4) + 300;
  const tid = 't' + n;
  lines.push({ type: 'assistant', cwd: process.cwd(), timestamp: at(m), message: { id: 'm' + n++, model, usage: { input_tokens: 3, cache_read_input_tokens: context - grow, cache_creation_input_tokens: grow, output_tokens: 900 }, content: [{ type: 'tool_use', id: tid, name, input }] } });
  lines.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'x'.repeat(output) }] } });
};
const plan = busy
  ? [['Make saving the state never wait for the disk', 42], ['Read', { file_path: process.cwd() + '/src/daemon/store.ts' }, 30000], ['Read', { file_path: process.cwd() + '/src/daemon/main.ts' }, 120000], ['Grep', { pattern: 'saveState' }, 9000], ['Edit', { file_path: process.cwd() + '/src/daemon/main.ts' }, 6000], ['Also cover it with a test', 18], ['Bash', { command: 'npm test' }, 52000], ['Read', { file_path: process.cwd() + '/README.md' }, 40000], ['Edit', { file_path: process.cwd() + '/README.md' }, 3000]]
  : [['Build the pricing page from the design', 95], ['Read', { file_path: process.cwd() + '/src/pages/pricing.tsx' }, 60000], ['Bash', { command: 'npm run build' }, 210000], ['Read', { file_path: process.cwd() + '/src/styles/plans.css' }, 90000], ['Bash', { command: 'npx playwright test pricing' }, 260000], ['Edit', { file_path: process.cwd() + '/src/pages/pricing.tsx' }, 9000]];
let minutes = 0;
for (const [name, input, output] of plan) {
  if (typeof input === 'number') { minutes = input; ask(name, minutes); added += 100; continue; }
  minutes -= 2;
  call(name, input, output, minutes);
}
fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join(String.fromCharCode(10)) + String.fromCharCode(10));
const thoughts = ['Checking where the scrollback is written…', 'Running the daemon tests…', 'Updating the README…'];
let i = 0;
if (busy) setInterval(() => process.stdout.write('\\r\\x1b[K' + y('✻') + ' ' + thoughts[i++ % thoughts.length]), 900);
else process.stdout.write(d('> '));
process.stdin.setRawMode(true);
process.stdin.on('data', (k) => k[0] === 3 && process.exit(0));
`,
  { mode: 0o755 },
);
// Two configurations: the default one signed in to an account, and Kimi behind Claude Code.
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com', planDisplayName: 'Max' } }));
fs.mkdirSync(path.join(home, '.claude-kimi'), { recursive: true });
fs.writeFileSync(
  path.join(home, '.claude-kimi', 'settings.json'),
  JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-demo-000000000000k7q2', ANTHROPIC_MODEL: 'kimi-k3' } }),
);
const rc = path.join(home, 'bashrc');
fs.writeFileSync(rc, `export PATH="${bin}:$PATH"\nPS1='\\[\\e[32m\\]dev\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]$ '\n`);
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ shell: '/bin/bash', shellArgs: ['--noprofile', '--rcfile', rc, '-i'] }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await _electron.launch({ args: ['--no-sandbox', '.'], env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false', HOME: home, SENJU_HOME: home, XDG_RUNTIME_DIR: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') } });
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
await page.waitForSelector('.empty');
const act = (a) => page.evaluate((a) => window.senju.send({ type: 'action', action: a }), a);
const state = () => page.evaluate(() => window.senju.state());
const type = (id, data) => page.evaluate(([id, data]) => window.senju.send({ type: 'input', terminalId: id, data }), [id, data]);
const panesOf = (n) => (n.type === 'pane' ? [n] : n.children.flatMap(panesOf));

await act({ type: 'createGroup', name: 'senju', cwd: project });
await act({ type: 'createGroup', name: 'website', cwd: path.join(home, 'website') });
await act({ type: 'createGroup', name: 'infra', cwd: path.join(home, 'infra') });
await sleep(500);
let s = await state();
await act({ type: 'createWorkspace', groupId: s.groups[0].id });
await act({ type: 'createWorkspace', groupId: s.groups[0].id });
await sleep(400);
s = await state();
const [agents, servers, review] = s.groups[0].workspaces;
const website = s.groups[1].workspaces[0];
const names = [
  [agents, 'agents', '#c678dd'],
  [servers, 'servers', '#98c379'],
  [review, 'review', null],
  [website, 'pricing page', '#e8955c'],
  [s.groups[2].workspaces[0], 'cluster', '#61afef'],
];
for (const [w, name, color] of names) {
  await act({ type: 'renameWorkspace', workspaceId: w.id, name });
  if (color) await act({ type: 'setWorkspaceColor', workspaceId: w.id, color });
}
await act({ type: 'setGroupCollapsed', groupId: s.groups[2].id, collapsed: true });
await sleep(300);

// An agent elsewhere that waits for input.
await type(website.root.activeTab, 'clear; CLAUDE_CONFIG_DIR=~/.claude-kimi claude\r');
await act({ type: 'activateWorkspace', workspaceId: agents.id });
await sleep(800);

s = await state();
const left = panesOf(s.groups[0].workspaces[0].root)[0];
await type(left.activeTab, 'clear; claude --busy\r');
await act({ type: 'createTab', paneId: left.id });
await sleep(300);
await act({ type: 'activateTab', terminalId: left.activeTab });
await act({ type: 'splitPane', paneId: left.id, side: 'right' });
await sleep(400);
s = await state();
const right = panesOf(s.groups[0].workspaces[0].root)[1];
await type(right.activeTab, 'clear; python3 -m http.server 8000\r');
await act({ type: 'splitPane', paneId: right.id, side: 'down' });
await sleep(400);
s = await state();
const bottom = panesOf(s.groups[0].workspaces[0].root)[2];
await type(bottom.activeTab, 'clear; npx vitest run --reporter=dot\r');
await act({ type: 'resizeSplit', splitId: s.groups[0].workspaces[0].root.id, sizes: [0.54, 0.46] });
await sleep(1500);
// A few requests, so the server shows a log.
for (let i = 0; i < 4; i++) await fetch('http://localhost:8000/').catch(() => {});
await act({ type: 'focusPane', paneId: left.id });
await sleep(6000);
await page.screenshot({ path: path.join(out, 'main.png') });

// What fills the context of the agent at work.
await page.locator('.tab-usage:not([hidden])').first().click();
await page.waitForSelector('.usage-part');
await sleep(300);
await page.screenshot({ path: path.join(out, 'usage.png') });
await page.keyboard.press('Escape');

// Every agent with what it runs with.
await page.keyboard.press('Control+Shift+A');
await page.waitForSelector('.overview-profile:not([hidden])');
await sleep(1200);
await page.screenshot({ path: path.join(out, 'overview.png') });
await page.keyboard.press('Escape');
await sleep(300);

// A report an agent shows next to its terminal, in the servers workspace.
fs.writeFileSync(
  path.join(project, 'report.md'),
  `# Save the state in the background

Saving \`state.json\` blocked the event loop on a busy disk, so keystrokes stalled for up to **180 ms**.

## What changed

- The structure is written by a worker; the daemon only queues the latest copy.
- Scrollback files go one terminal per tick, busy terminals less often.
- Everything is flushed on shutdown, as before.

## Measured

| Case | Before | After |
| --- | --- | --- |
| Keystroke, idle disk | 4 ms | 4 ms |
| Keystroke, busy disk | 180 ms | 6 ms |
| Save on shutdown | 40 ms | 42 ms |

\`\`\`ts
queue.push(() => store.write(snapshot(state)));
\`\`\`
`,
);
await act({ type: 'activateWorkspace', workspaceId: servers.id });
await sleep(800);
await type(servers.root.activeTab, 'clear; senju open report.md\r');
await page.waitForSelector('.viewer-body h1');
await sleep(1000);
await page.screenshot({ path: path.join(out, 'viewer.png') });
await act({ type: 'activateWorkspace', workspaceId: agents.id });
await sleep(500);

// Menu with the color submenu.
await page.locator('.workspace', { hasText: 'agents' }).click({ button: 'right' });
await sleep(200);
await page.locator('.menu-item', { hasText: 'Color' }).hover();
await sleep(300);
await page.screenshot({ path: path.join(out, 'menu.png'), clip: { x: 0, y: 0, width: 760, height: 470 } });
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');

// Settings: themes with the editor open.
await page.click('#open-settings');
await page.locator('.settings-nav-item', { hasText: 'Theme' }).click();
await page.locator('.theme-card', { hasText: 'Tokyo Night' }).click();
await sleep(300);
await page.screenshot({ path: path.join(out, 'themes.png') });
await page.locator('.settings-nav-item', { hasText: 'Keyboard' }).click();
await sleep(300);
await page.screenshot({ path: path.join(out, 'shortcuts.png') });

// Light theme.
await page.locator('.settings-nav-item', { hasText: 'Theme' }).click();
await page.locator('.theme-card', { hasText: 'GitHub Light' }).click();
await page.keyboard.press('Escape');
await sleep(800);
await page.screenshot({ path: path.join(out, 'light.png') });

const exited = new Promise((r) => app.process().once('exit', r));
await page.evaluate(() => window.senju.stopAll());
await exited;
fs.rmSync(home, { recursive: true, force: true });
console.log(`screenshots in ${path.relative(repo, out)}`);
