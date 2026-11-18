// End-to-end test of a self-update on Linux: an "installed" AppImage of one
// version updates itself from a local server to the next version, while a
// program keeps running in one of its terminals.
// Usage: node scripts/update-e2e.mjs <old.AppImage> <server dir with the new AppImage and latest-linux.yml>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';

const [installed, serverDir] = process.argv.slice(2).map((p) => path.resolve(p));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-update-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The app's AppImage runtime processes for this test. Found by executable and
 * environment, never by a name pattern; the Electron processes themselves
 * cannot be told apart this way, as Chromium overwrites their environment area.
 */
const appProcesses = () =>
  fs
    .readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((pid) => {
      try {
        return fs.readlinkSync(`/proc/${pid}/exe`) === installed && fs.readFileSync(`/proc/${pid}/environ`, 'utf8').includes(`SENJU_HOME=${home}`);
      } catch {
        return false;
      }
    });
/** All processes of the app started after the update, the runtime and its Electron children. */
const descendants = (pids) => {
  const all = new Set(pids.map(Number));
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
      try {
        const ppid = Number(fs.readFileSync(`/proc/${name}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
        if (all.has(ppid) && !all.has(Number(name))) {
          all.add(Number(name));
          grew = true;
        }
      } catch {
        // Gone.
      }
    }
  }
  return [...all];
};

const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: serverDir, stdio: 'ignore' });
await sleep(800);
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ theme: 'Nord', fontSize: 15 }));
const settingsBefore = fs.readFileSync(path.join(home, 'settings.json'), 'utf8');
const sizeBefore = fs.statSync(installed).size;

const env = { ...process.env, SENJU_HOME: home, XDG_RUNTIME_DIR: home, SENJU_UPDATE_URL: 'http://127.0.0.1:8765/' };
const app = await _electron.launch({ executablePath: installed, args: ['--no-sandbox'], env });
const page = await app.firstWindow();
await page.waitForSelector('.empty');
await page.evaluate(() => window.senju.send({ type: 'action', action: { type: 'createGroup', name: 'work', cwd: '/tmp' } }));
await page.waitForSelector('.pane .xterm');
await sleep(800);
const state = await page.evaluate(() => window.senju.state());
const terminalId = Object.keys(state.terminals)[0];
await page.evaluate((id) => window.senju.send({ type: 'input', terminalId: id, data: 'sleep 1000\r' }), terminalId);
await sleep(2500);

const daemonPid = Number(fs.readFileSync(path.join(home, 'daemon.log'), 'utf8').match(/daemon (\d+) started/)[1]);
const daemonExe = fs.readlinkSync(`/proc/${daemonPid}/exe`);
check(daemonExe.startsWith(path.join(home, 'daemon-runtime')), `daemon runs from its own copy (${path.relative(home, daemonExe)})`);
const environ = fs.readFileSync(`/proc/${daemonPid}/environ`, 'utf8');
check(!/(^|\0)(APPDIR|APPIMAGE)=/.test(environ) && !/\.mount_/.test(environ), 'daemon environment has no AppImage paths');
const sleepPid = Number((await import('node:child_process')).execSync('pgrep -n -x sleep').toString());

console.log('waiting for the update check…');
await page.waitForSelector('.banner-row[data-banner="update"]', { timeout: 30000 });
check((await page.locator('.banner-row[data-banner="update"]').innerText()).includes('0.1.1 is available'), 'banner offers the new version');
await page.locator('.banner-row[data-banner="update"] .button', { hasText: 'Download and install' }).click();
await page.waitForFunction(() => document.querySelector('.banner-row[data-banner="update"]')?.textContent?.includes('is ready'), null, { timeout: 120000 });
check(true, 'update downloaded after approval');
const exited = new Promise((r) => app.process().once('exit', r));
await page.locator('.banner-row[data-banner="update"] .button', { hasText: 'Restart and install' }).click();
await exited;

// Wait for the new version to come up and reconnect.
let relaunched = [];
const installStarted = Date.now();
for (let i = 0; i < 180 && relaunched.length === 0; i++) {
  await sleep(1000);
  relaunched = appProcesses();
}
console.log(`new version up after ${Math.round((Date.now() - installStarted) / 1000)} s`);
await sleep(8000);

check(fs.statSync(installed).size !== sizeBefore, 'the AppImage was replaced by the new version');
check(relaunched.length > 0, 'the new version started');
check(alive(daemonPid), 'the daemon kept running through the update');
check(alive(sleepPid), 'the program in the terminal kept running');
const starts = fs.readFileSync(path.join(home, 'daemon.log'), 'utf8').match(/daemon \d+ started/g) ?? [];
check(starts.length === 1, 'the new version reconnected to the same daemon instead of starting another');
check(fs.readFileSync(path.join(home, 'settings.json'), 'utf8') === settingsBefore, 'settings are unchanged');
const usesMount = (pid) => {
  try {
    const links = [fs.readlinkSync(`/proc/${pid}/cwd`), ...fs.readdirSync(`/proc/${pid}/fd`).map((fd) => fs.readlinkSync(`/proc/${pid}/fd/${fd}`))];
    return links.some((l) => l.includes('/.mount_'));
  } catch {
    return false;
  }
};
check(!usesMount(daemonPid) && !usesMount(sleepPid), 'neither the daemon nor its programs hold an AppImage mount');

// Clean up: stop the relaunched UI and the daemon.
for (const pid of descendants(relaunched).reverse()) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}
process.kill(daemonPid, 'SIGTERM');
server.kill();
await sleep(1500);
fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
