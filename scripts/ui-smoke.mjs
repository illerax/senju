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
let failures = 0;
/** Screenshots are for people to look at; failing to take one does not fail the test. */
async function shot(name) {
  try {
    await page.screenshot({ path: path.join(out, name) });
  } catch (err) {
    console.log(`warn could not save ${name}: ${err.message.split('\n')[0]}`);
  }
}
const report = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

function daemonSend(msg) {
  return new Promise((resolve, reject) => {
    const s = net.connect(path.join(home, 'daemon.sock'), () => {
      s.write(`${JSON.stringify({ type: 'hello', protocol: 3 })}\n${JSON.stringify(msg)}\n`);
      setTimeout(() => {
        s.end();
        resolve();
      }, 200);
    });
    s.on('error', reject);
  });
}

const executable = process.env.SENJU_EXECUTABLE;
// CI machines have no GPU; without this Chromium often cannot capture the window.
const flags = process.env.CI ? ['--no-sandbox', '--disable-gpu'] : ['--no-sandbox'];
const launch = () =>
  _electron.launch(executable ? { executablePath: executable, args: flags, env } : { args: [...flags, '.'], env });
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
await shot('1-empty.png');

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
await shot('2-splits.png');

const state = () => page.evaluate(() => window.senju.state());
const panesOf = (node) => (node.type === 'pane' ? [node] : node.children.flatMap(panesOf));
const active = (st) => st.groups.flatMap((g) => g.workspaces).find((w) => w.id === st.windows[0].activeWorkspaceId);


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
await shot('2b-tabs.png');
report('one active workspace in the sidebar', (await page.locator('.workspace.active').count()) === 1);

// An OSC 8 hyperlink: hovering shows its address, Ctrl+click opens it without a confirmation.
await app.evaluate(({ shell }) => {
  globalThis.opened = [];
  shell.openExternal = async (url) => void globalThis.opened.push(url);
});
let dialogs = 0;
page.on('dialog', (d) => {
  dialogs++;
  void d.dismiss();
});
// In a new tab: the focused pane shows htop where it is installed.
await page.locator('.pane.focused .xterm').click();
await page.keyboard.press('Control+Shift+T');
await sleep(800);
await page.keyboard.type(`printf '\\e]8;;https://example.com/osc8\\e\\\\%s-%s\\e]8;;\\e\\\\\\n' open link\n`);
const linkRow = await page.waitForFunction(
  () => [...document.querySelectorAll('.pane.focused .xterm-rows > div')].find((r) => r.textContent.startsWith('open-link')),
  null,
  { timeout: 10000 },
);
const linkBox = await linkRow.evaluate((row) => {
  const range = document.createRange();
  range.selectNodeContents(row);
  const r = range.getBoundingClientRect();
  return { x: r.left + 20, y: r.top + r.height / 2 };
});
await page.mouse.move(linkBox.x, linkBox.y);
await sleep(300);
report('hovering a hyperlink shows its address', (await page.locator('.pane.focused .terminal-host').getAttribute('title')) === 'https://example.com/osc8');
await page.keyboard.down('Control');
await page.mouse.click(linkBox.x, linkBox.y);
await page.keyboard.up('Control');
await sleep(300);
report('Ctrl+click opens a hyperlink without asking', dialogs === 0 && (await app.evaluate(() => globalThis.opened)).includes('https://example.com/osc8'));

// Copy mode selects and copies with the keyboard alone; no key reaches the shell.
await page.keyboard.type(`clear; printf 'copy-one two\\ncopy-three four\\n'\n`);
await page.waitForFunction(() => [...document.querySelectorAll('.pane.focused .xterm-rows > div')].some((r) => r.textContent.startsWith('copy-three')), null, { timeout: 10000 });
const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
const keys = async (...list) => {
  for (const k of list) await page.keyboard.press(k);
  await sleep(200);
};
const promptLine = () => page.evaluate(() => [...document.querySelectorAll('.pane.focused .xterm-rows > div')].map((r) => r.textContent).find((t) => t.includes('$')) ?? '');
const promptBefore = await promptLine();
await keys('Control+Shift+Space');
report('copy mode shows its keys', await page.locator('.pane.focused .copy-mode-bar:not([hidden])').filter({ hasText: 'Copy mode' }).isVisible());
await keys('k', 'k', '0', 'v', 'Shift+Digit4');
report('copy mode shows that it is selecting', await page.locator('.pane.focused .copy-mode-bar').filter({ hasText: 'Selecting' }).isVisible());
await shot('2f-copy-mode.png');
await keys('y');
report(`copy mode copies a selection (${JSON.stringify(await clipboard())})`, (await clipboard()) === 'copy-one two');
report('copy mode says it copied', await page.locator('.pane.focused .copy-mode-bar').filter({ hasText: 'Copied' }).isVisible());
await keys('Control+Shift+Space', 'k', 'k', 'Shift+V', 'j', 'Enter');
report(`copy mode copies whole lines (${JSON.stringify(await clipboard())})`, (await clipboard()) === 'copy-one two\ncopy-three four');
await keys('Control+Shift+Space', '/');
await page.keyboard.type('three');
await keys('Enter', 'Escape', 'v', 'End', 'y');
report(`copy mode starts a selection at a match (${JSON.stringify(await clipboard())})`, (await clipboard()) === 'three four');
await keys('Control+Shift+Space', 'k', 'y');
report(`copy mode copies the cursor's line without a selection (${JSON.stringify(await clipboard())})`, (await clipboard()) === 'copy-three four');
report(`copy mode keys never reach the shell (${JSON.stringify(await promptLine())})`, (await promptLine()) === promptBefore);
await keys('Control+Shift+Space', 'Escape');
report('copy mode exits', await page.locator('.pane.focused .copy-mode-bar').isHidden());

// Workspace shortcuts go across groups.
st = await state();
const moving = st.windows[0].activeWorkspaceId;
const senjuGroup = st.groups[0].id;
const where = (s) => {
  const g = s.groups.find((x) => x.workspaces.some((w) => w.id === moving));
  return `${g.id === senjuGroup ? 'senju' : 'scratch'}:${g.workspaces.findIndex((w) => w.id === moving)}`;
};
await page.keyboard.press('Control+Shift+PageUp');
await sleep(300);
st = await state();
report('previous workspace crosses into the previous group', st.windows[0].activeWorkspaceId === st.groups[0].workspaces[0].id);
await page.keyboard.press('Control+Shift+PageDown');
await sleep(300);
report('next workspace comes back', (await state()).windows[0].activeWorkspaceId === moving);
const moves = [];
for (const key of ['PageDown', 'PageDown', 'PageUp', 'PageUp', 'PageDown']) {
  await page.keyboard.press(`Control+Alt+Shift+${key}`);
  await sleep(300);
  moves.push(where(await state()));
}
report(`workspace moves down, stops at the end, moves up into the previous group and back (${moves.join(' ')})`, moves.join(' ') === 'scratch:1 scratch:1 scratch:0 senju:1 scratch:0');
report('the moved workspace stays active', (await state()).windows[0].activeWorkspaceId === moving);

// Notifications have their own settings page: off as a whole, or per reason.
await page.click('#open-settings');
await page.locator('.settings-nav-item', { hasText: 'Notifications' }).click();
const reason = page.locator('label.checkbox', { hasText: 'Finished its task' }).locator('input');
await reason.uncheck();
await sleep(300);
const savedSettings = () => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
report('a notification reason turned off is saved', savedSettings().notifyOn?.finished === false);
await page.locator('label.checkbox', { hasText: 'Notify me when' }).locator('input').uncheck();
await sleep(300);
await shot('2c-notifications.png');
report('notifications turned off disable the reasons', savedSettings().notifications === false && (await reason.isDisabled()));

// Shortcuts have a page per group, copy mode keys among them.
await page.locator('.settings-nav-item', { hasText: 'Keyboard Shortcuts' }).click();
await page.locator('.settings-nav-item.sub', { hasText: 'Copy mode' }).click();
await sleep(200);
const copyRows = await page.locator('.shortcut-row').count();
report(`shortcut groups have their own pages (${copyRows} copy mode keys)`, copyRows > 10 && (await page.locator('.settings-page h2').textContent()) === 'Keyboard Shortcuts: Copy mode');
await shot('2g-copy-mode-keys.png');

// About: the diagnostics log can be found from the settings, to send it with a report.
await page.locator('.settings-nav-item', { hasText: 'About' }).click();
await page.locator('button', { hasText: 'Show diagnostics.log' }).waitFor();
await app.evaluate(({ shell }) => {
  globalThis.__shown = [];
  shell.showItemInFolder = (file) => globalThis.__shown.push(file);
  shell.openPath = async (file) => (globalThis.__shown.push(file), '');
});
await shot('2d-about.png');
await page.locator('button', { hasText: 'Show diagnostics.log' }).click();
await sleep(300);
const shown = await app.evaluate(() => globalThis.__shown);
report(`about shows diagnostics.log (${shown.map((f) => path.basename(f)).join(', ')})`, shown.length === 1 && path.basename(shown[0]) === 'diagnostics.log');
await page.keyboard.press('Escape');
await sleep(300);

// A group moved to a new window shows there and leaves the first window.
const groupNames = (p) => p.locator('.group-name').allInnerTexts();
const movedGroup = (await state()).groups.find((g) => g.name === 'senju');
const opened = app.waitForEvent('window');
await page.evaluate((id) => window.senju.newWindow(id), movedGroup.id);
let page2 = await opened;
await page2.waitForSelector('.pane .xterm');
await sleep(1000);
st = await state();
report('a new window takes the group', st.windows.length === 2 && st.groups.find((g) => g.id === movedGroup.id).windowId === st.windows[1].id);
report('each window lists its own groups', (await groupNames(page)).join() === 'scratch' && (await groupNames(page2)).join() === 'senju');
await page2.locator('.pane.focused .xterm').click();
await page2.keyboard.type('echo from-the-second-window\n');
await sleep(800);
report('the second window runs its terminal', (await page2.locator('#workspace').innerText()).includes('from-the-second-window'));
report('the first window keeps its workspace', (await page.locator('#workspace').innerText()).includes('git log'));
try {
  await page2.screenshot({ path: path.join(out, '2e-second-window.png') });
} catch {}

// Closing the UI keeps the daemon; a new UI gets everything back, every window.
await quit(app);
await sleep(500);
app = await launch();
page = await app.firstWindow();
await page.waitForSelector('.pane .xterm');
await sleep(1500);
await shot('3-reopened.png');
const text = await page.locator('#workspace').innerText();
report('screen kept after reopen', text.includes('sleep 600') && text.includes('git log'));
for (let until = Date.now() + 5000; app.windows().length < 2 && Date.now() < until; ) await sleep(100);
page2 = app.windows().find((w) => w !== page);
report('both windows reopen', app.windows().length === 2 && !!page2);
if (page2) {
  await page2.waitForSelector('.pane .xterm');
  await sleep(800);
  report('the second window reopens with its group', (await groupNames(page2)).join() === 'senju' && (await page2.locator('#workspace').innerText()).includes('from-the-second-window'));
}

// Closing a window that is not the last moves its groups to the other one.
const secondId = (await state()).windows[1].id;
await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(`window=${id}`))?.close(), secondId);
await sleep(1000);
st = await state();
report('closing a window hands its groups on', st.windows.length === 1 && app.windows().length === 1 && (await groupNames(page)).join() === 'scratch,senju');

// Stop everything, as a reboot would, and start again.
await stopAll(app, page);
app = await launch();
page = await app.firstWindow();
await page.waitForSelector('.pane .xterm');
await sleep(2500);
await shot('4-restored.png');
const restored = await page.locator('#workspace').innerText();
report('scrollback restored', restored.includes('restored'));
report('run again offered', (await page.locator('.terminal-overlay.visible').count()) === 1);

// A program left mouse tracking on and the mouse moves while the daemon
// restarts: its reports must not reach the new shell and spoil the restored command.
await page.locator('.pane.focused .xterm').click();
await page.keyboard.press('Control+Shift+T');
await sleep(800);
await page.keyboard.type("printf '\\e[?1003h\\e[?1006h'; tail -f /dev/null\n");
await sleep(2500);
const tailRunning = (s) => Object.values(s.terminals).some((t) => t.job?.argv.join(' ') === 'tail -f /dev/null');
const mouseBox = await page.locator('.pane.focused .xterm').boundingBox();
await page.evaluate(() => window.senju.restartDaemon());
for (let i = 0, until = Date.now() + 6000; Date.now() < until; i++) {
  await page.mouse.move(mouseBox.x + 100 + (i % 40) * 5, mouseBox.y + 100 + (i % 7) * 10);
  await sleep(15);
}
await sleep(2500);
report('restored command survives mouse reports during a daemon restart', tailRunning(await state()));
await stopAll(app, page);
fs.rmSync(home, { recursive: true, force: true });
console.log(`screenshots in ${out}`);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
