// Launches the app against a throwaway state directory, drives it through
// the daemon socket and the keyboard, and saves screenshots.
// Usage: node scripts/ui-smoke.mjs [outDir]  (after npm run build)
// Set SENJU_EXECUTABLE to test a packaged build instead of the sources.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';

const out = path.resolve(process.argv[2] ?? 'ui-smoke');
fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-ui-'));
const env = { ...process.env, SENJU_HOME: home, XDG_RUNTIME_DIR: home };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function daemonSend(msg) {
  return new Promise((resolve, reject) => {
    const s = net.connect(path.join(home, 'daemon.sock'), () => {
      s.write(`${JSON.stringify({ type: 'hello', protocol: 2 })}\n${JSON.stringify(msg)}\n`);
      setTimeout(() => {
        s.end();
        resolve();
      }, 200);
    });
    s.on('error', reject);
  });
}

const executable = process.env.SENJU_EXECUTABLE;
const launch = () =>
  _electron.launch(executable ? { executablePath: executable, args: ['--no-sandbox'], env } : { args: ['--no-sandbox', '.'], env });
// Closes the app like a user would. The daemon stays alive, which keeps
// Playwright's own close() waiting, so wait for the process instead.
async function quit(app) {
  const exited = new Promise((r) => app.process().once('exit', r));
  await app.evaluate(({ app }) => app.quit());
  await exited;
}
async function stopAll(app, page) {
  const exited = new Promise((r) => app.process().once('exit', r));
  await page.evaluate(() => window.senju.stopAll());
  await exited;
}
let app = await launch();
let page = await app.firstWindow();
await page.waitForSelector('.empty');
await page.screenshot({ path: path.join(out, '1-empty.png') });

await daemonSend({ type: 'action', action: { type: 'createGroup', name: 'senju', cwd: process.cwd() } });
await daemonSend({ type: 'action', action: { type: 'createGroup', name: 'scratch', cwd: os.tmpdir() } });
await page.waitForSelector('.pane .xterm');
await sleep(800);
await page.keyboard.type('echo "hello from senju" && ls\n');
await page.keyboard.press('Control+Shift+D');
await sleep(600);
await page.keyboard.type('git log --oneline | head -5\n');
await page.keyboard.press('Control+Shift+E');
await sleep(600);
await page.keyboard.type('sleep 600\n');
await page.keyboard.press('Control+Shift+T');
await sleep(600);
await page.keyboard.type('htop\n');
await page.keyboard.press('Control+Shift+N');
await sleep(600);
await page.keyboard.press('Control+Shift+PageUp');
await sleep(1500);
await page.screenshot({ path: path.join(out, '2-splits.png') });

const state = () => page.evaluate(() => window.senju.state());
const panesOf = (node) => (node.type === 'pane' ? [node] : node.children.flatMap(panesOf));
const active = (st) => st.groups.flatMap((g) => g.workspaces).find((w) => w.id === st.activeWorkspaceId);
const report = (label, ok) => console.log(`${label}: ${ok}`);

let st = await state();
report('sidebar groups', (await page.locator('.group').count()) === 2);
report('workspaces in group', (await page.locator('.group').nth(1).locator('.workspace').count()) === 2);
report('panes in workspace', panesOf(active(st).root).length === 3);
report('tabs in pane', (await page.locator('.pane.focused .tab').count()) === 2);

// Double-click a workspace that is not active to rename it.
const other = page.locator('.group').nth(1).locator('.workspace').nth(1);
await other.dblclick();
await page.keyboard.press('Control+A');
await page.keyboard.type('servers\n');
await sleep(400);
st = await state();
report('workspace renamed by double click', st.groups[1].workspaces[1].name === 'servers');
await page.locator('.group').nth(1).locator('.workspace').nth(0).click();
await sleep(300);

// Rename the active tab from the keyboard.
await page.keyboard.press('Control+Shift+R');
await page.keyboard.press('Control+A');
await page.keyboard.type('monitor\n');
await sleep(400);
report('tab renamed', (await page.locator('.pane.focused .tab.active .tab-label').innerText()) === 'monitor');

// Collapse and expand a group.
await page.locator('.group-header').first().click();
await sleep(300);
report('group collapses', (await state()).groups[0].collapsed === true);
await page.locator('.group-header').first().click();
await sleep(300);

const before = active(await state()).root.sizes;
const divider = await page.locator('.split-row > .divider').first().boundingBox();
await page.mouse.move(divider.x + 1, divider.y + 200);
await page.mouse.down();
await page.mouse.move(divider.x - 200, divider.y + 200, { steps: 5 });
await page.mouse.up();
await sleep(400);
const after = active(await state()).root.sizes;
report('divider resizes panes', after[0] < before[0] - 0.1);

const focusedBefore = active(await state()).focusedPaneId;
await page.keyboard.press('Control+Shift+ArrowLeft');
await sleep(300);
report('arrow moves focus', active(await state()).focusedPaneId !== focusedBefore);

// Drag the "monitor" tab into the left pane.
const tab = page.locator('.tab', { hasText: 'monitor' });
const target = page.locator('.pane').first().locator('.pane-tab-list');
await tab.dragTo(target);
await sleep(500);
st = await state();
const left = panesOf(active(st).root)[0];
report('tab dragged to another pane', left.tabs.some((id) => st.terminals[id].name === 'monitor'));
await page.screenshot({ path: path.join(out, '2b-tabs.png') });
report('one active workspace in the sidebar', (await page.locator('.workspace.active').count()) === 1);

// Closing the UI keeps the daemon; a new UI gets everything back.
await quit(app);
await sleep(500);
app = await launch();
page = await app.firstWindow();
await page.waitForSelector('.pane .xterm');
await sleep(1500);
await page.screenshot({ path: path.join(out, '3-reopened.png') });
const text = await page.locator('#workspace').innerText();
console.log(`screen kept after reopen: ${text.includes('sleep 600') && text.includes('git log')}`);

// Stop everything, as a reboot would, and start again.
await stopAll(app, page);
app = await launch();
page = await app.firstWindow();
await page.waitForSelector('.pane .xterm');
await sleep(2500);
await page.screenshot({ path: path.join(out, '4-restored.png') });
const restored = await page.locator('#workspace').innerText();
console.log(`scrollback restored: ${restored.includes('restored')}`);
console.log(`run again offered: ${await page.locator('.terminal-overlay.visible').count()}`);
await stopAll(app, page);
fs.rmSync(home, { recursive: true, force: true });
console.log(`screenshots in ${out}`);
