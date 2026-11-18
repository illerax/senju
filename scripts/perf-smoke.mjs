// Stress test of the UI: many terminals with output, fast tab and workspace
// switching, and repeated settings changes. Reports response times, long
// tasks on the renderer's main thread, and every error from the logs.
// Usage: node scripts/perf-smoke.mjs  (after npm run build)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-perf-'));
const env = { ...process.env, SENJU_HOME: home, XDG_RUNTIME_DIR: home };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const app = await _electron.launch({ args: ['--no-sandbox', '.'], env });
app.process().stderr.on('data', (d) => {
  const text = String(d);
  if (/error|exception|warn/i.test(text) && !/atom_cache|DevTools listening|Debugger/.test(text)) errors.push(`main: ${text.trim()}`);
});
const page = await app.firstWindow();
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`renderer ${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => errors.push(`renderer exception: ${e.message}`));

await page.waitForSelector('.empty');
// Long tasks block input; collect them for the whole run.
await page.evaluate(() => {
  window.__long = [];
  new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask', buffered: true });
});

const state = () => page.evaluate(() => window.senju.state());
const active = (st) => st.groups.flatMap((g) => g.workspaces).find((w) => w.id === st.activeWorkspaceId);
const panesOf = (node) => (node.type === 'pane' ? [node] : node.children.flatMap(panesOf));
/** Time from a key press until the UI shows its effect. */
async function timed(press, done, arg = null) {
  const start = Date.now();
  await press();
  const ok = await page.waitForFunction(done, arg, { timeout: 5000, polling: 'raf' }).then(() => true, () => false);
  if (!ok) errors.push(`timed out waiting for: ${done.toString().slice(0, 120)} (${JSON.stringify(arg)})`);
  return Date.now() - start;
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return `median ${s[Math.floor(s.length / 2)]}ms, p95 ${s[Math.floor(s.length * 0.95)]}ms, max ${s.at(-1)}ms (n=${s.length})`;
};

// Two groups, three workspaces, 4 panes with 3 tabs each in the first one.
await page.click('#add-group');
await page.waitForSelector('.pane .xterm');
for (const key of ['Control+Shift+D', 'Control+Shift+E', 'Control+Shift+ArrowLeft', 'Control+Shift+E']) {
  await page.keyboard.press(key);
  await sleep(250);
}
let st = await state();
for (const pane of panesOf(active(st).root)) {
  await page.evaluate((id) => window.senju.send({ type: 'action', action: { type: 'createTab', paneId: id } }), pane.id);
  await page.evaluate((id) => window.senju.send({ type: 'action', action: { type: 'createTab', paneId: id } }), pane.id);
}
await sleep(800);
st = await state();
const terminalCount = Object.keys(st.terminals).length;
// Continuous output in every pane's active tab, like agents and dev servers.
for (const pane of panesOf(active(st).root)) {
  await page.evaluate(
    (id) => window.senju.send({ type: 'input', terminalId: id, data: 'for i in $(seq 1 100000); do echo "line $i $(date +%N) lorem ipsum dolor sit amet"; sleep 0.01; done\r' }),
    pane.activeTab,
  );
}
await page.keyboard.press('Control+Shift+N');
await sleep(300);
await page.keyboard.press('Control+Shift+G');
await sleep(500);
await page.keyboard.press('Control+Shift+Home');
await sleep(300);
await page.keyboard.press('Control+Shift+PageUp');
await sleep(800);
console.log(`terminals: ${terminalCount}, output running in 4 of them`);

// Switching tabs.
const tabTimes = [];
for (let i = 0; i < 60; i++) {
  await page.evaluate(() => (window.__prev = document.querySelector('.pane.focused .tab.active')));
  tabTimes.push(await timed(() => page.keyboard.press('Control+Tab'), () => document.querySelector('.pane.focused .tab.active') !== window.__prev));
}
console.log(`tab switch: ${stats(tabTimes)}`);

// Switching panes and workspaces.
const paneTimes = [];
for (let i = 0; i < 40; i++) {
  await page.evaluate(() => (window.__prev = document.querySelector('.pane.focused')));
  paneTimes.push(await timed(() => page.keyboard.press('Control+Shift+BracketRight'), () => document.querySelector('.pane.focused') !== window.__prev));
}
console.log(`pane switch: ${stats(paneTimes)}`);

const wsTimes = [];
for (let i = 0; i < 40; i++) {
  await page.evaluate(() => (window.__prev = document.querySelector('#workspace > *')));
  wsTimes.push(await timed(() => page.keyboard.press(i % 2 ? 'Control+Shift+PageUp' : 'Control+Shift+PageDown'), () => document.querySelector('#workspace > *') !== window.__prev));
}
console.log(`workspace switch: ${stats(wsTimes)}`);

// Changing settings.
const themeTimes = [];
await page.keyboard.press('Control+Shift+Comma');
await page.locator('.settings-nav-item', { hasText: 'Theme' }).click();
const names = ['Dracula', 'Nord', 'Tokyo Night', 'GitHub Light', 'Gruvbox Dark', 'Senju Dark'];
for (let i = 0; i < 30; i++) {
  const name = names[i % names.length];
  themeTimes.push(await timed(() => page.locator('.theme-card', { hasText: name }).first().click(), (n) => document.querySelector('.theme-card.active .theme-name')?.textContent?.startsWith(n), name));
}
console.log(`theme change: ${stats(themeTimes)}`);
await page.locator('button', { hasText: 'New theme from selected' }).click();
await sleep(300);
const picker = page.locator('.color-row', { hasText: 'Background' }).locator('.color-text');
const colorTimes = [];
for (let i = 0; i < 20; i++) {
  const hex = `#${(0x101010 + i * 0x020202).toString(16)}`;
  colorTimes.push(await timed(async () => { await picker.fill(hex); await picker.press('Enter'); }, (h) => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === h, hex));
}
console.log(`custom color edit: ${stats(colorTimes)}`);
const shortcutTimes = [];
await page.locator('.settings-nav-item', { hasText: 'Keyboard' }).click();
for (let i = 0; i < 10; i++) {
  const row = page.locator('.shortcut-row', { hasText: 'Rename tab' });
  shortcutTimes.push(
    await timed(async () => {
      await row.locator('.key-chip-text').first().click();
      await page.keyboard.press(i % 2 ? 'Control+Shift+KeyR' : 'Control+Alt+KeyR');
    }, (k) => document.querySelector('.settings-content')?.textContent?.includes(k), i % 2 ? 'Ctrl+Shift+R' : 'Ctrl+Alt+R'),
  );
}
console.log(`shortcut change: ${stats(shortcutTimes)}`);
await page.keyboard.press('Escape');

const long = await page.evaluate(() => window.__long);
console.log(`long tasks (>50ms): ${long.length}, total ${Math.round(long.reduce((a, b) => a + b, 0))}ms, worst ${Math.round(Math.max(0, ...long))}ms`);
const mem = await page.evaluate(() => performance.memory && Math.round(performance.memory.usedJSHeapSize / 1e6));
console.log(`renderer heap: ${mem} MB`);

const exited = new Promise((r) => app.process().once('exit', r));
await page.evaluate(() => window.senju.stopAll());
await exited;
const daemonLog = fs.readFileSync(path.join(home, 'daemon.log'), 'utf8');
for (const line of daemonLog.split('\n')) if (/error|exception|rejection|fail/i.test(line)) errors.push(`daemon: ${line}`);
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no errors in logs');
fs.rmSync(home, { recursive: true, force: true });
