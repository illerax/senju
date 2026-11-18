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
const thoughts = ['Checking where the scrollback is written…', 'Running the daemon tests…', 'Updating the README…'];
let i = 0;
if (busy) setInterval(() => process.stdout.write('\\r\\x1b[K' + y('✻') + ' ' + thoughts[i++ % thoughts.length]), 900);
else process.stdout.write(d('> '));
process.stdin.setRawMode(true);
process.stdin.on('data', (k) => k[0] === 3 && process.exit(0));
`,
  { mode: 0o755 },
);
const rc = path.join(home, 'bashrc');
fs.writeFileSync(rc, `export PATH="${bin}:$PATH"\nPS1='\\[\\e[32m\\]dev\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]$ '\n`);
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ shell: '/bin/bash', shellArgs: ['--noprofile', '--rcfile', rc, '-i'] }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await _electron.launch({ args: ['--no-sandbox', '.'], env: { ...process.env, HOME: home, SENJU_HOME: home, XDG_RUNTIME_DIR: home } });
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
await type(website.root.activeTab, 'claude\r');
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
