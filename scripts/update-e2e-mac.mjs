// End-to-end test of a self-update on macOS: an "installed" Senju.app of one
// version updates itself from a local server to a disk image of the next
// version, while a program keeps running in one of its terminals.
// Usage: node scripts/update-e2e-mac.mjs <installed Senju.app> <new version .dmg>
// The installed app must be a copy in a writable folder: the test replaces it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';

const [installed, diskImage] = process.argv.slice(2).map((p) => path.resolve(p));
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
const version = (app) => execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
const command = (pid) => execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
/** Main processes of the installed app, found by executable path. */
const appProcesses = () => {
  const main = path.join(installed, 'Contents', 'MacOS', 'Senju');
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s(.*)$/.exec(line))
    .filter((m) => m && (m[2] === main || m[2].startsWith(`${main} `)))
    .map((m) => Number(m[1]));
};
async function until(label, predicate, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(500);
  }
}
/** Talks to the daemon directly: sends messages and returns the first state it broadcasts. */
function daemon(messages = []) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(home, 'daemon.sock'), () => {
      for (const msg of [{ type: 'hello', protocol: 2 }, ...messages]) socket.write(`${JSON.stringify(msg)}\n`);
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n').slice(0, -1)) {
        const msg = JSON.parse(line);
        if (msg.type === 'state') {
          socket.end();
          resolve(msg.state);
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });
    socket.on('error', reject);
  });
}
const jobs = (state) => Object.values(state.terminals).map((t) => t.job?.argv.join(' '));

const oldVersion = version(installed);
const newVersion = /Senju-(.+)-mac-/.exec(path.basename(diskImage))[1];
const server = http.createServer((req, res) => {
  const { port } = server.address();
  if (req.url === '/release.json') {
    const name = `Senju-${newVersion}-mac-${process.arch}.dmg`;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ tag_name: `v${newVersion}`, assets: [{ name, browser_download_url: `http://127.0.0.1:${port}/${name}` }] }));
  } else if (req.url === `/Senju-${newVersion}-mac-${process.arch}.dmg`) {
    res.setHeader('content-length', fs.statSync(diskImage).size);
    fs.createReadStream(diskImage).pipe(res);
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = { ...process.env, SENJU_HOME: home, SENJU_UPDATE_URL: `http://127.0.0.1:${server.address().port}` };
console.log(`updating ${installed} from ${oldVersion} to ${newVersion}`);

let daemonPid = 0;
try {
  const app = await _electron.launch({ executablePath: path.join(installed, 'Contents', 'MacOS', 'Senju'), env });
  const page = await app.firstWindow();
  await page.waitForSelector('.empty');
  await daemon([{ type: 'action', action: { type: 'createGroup', name: 'demo', cwd: os.tmpdir() } }]);
  await page.waitForSelector('.pane .xterm');
  await sleep(1000);
  await page.locator('.pane .xterm').first().click();
  await page.keyboard.type('sleep 600\n');
  await until('the job', async () => jobs(await daemon()).includes('sleep 600'), 15000);
  daemonPid = Number(/daemon (\d+) started/.exec(fs.readFileSync(path.join(home, 'daemon.log'), 'utf8'))[1]);
  check(command(daemonPid).startsWith(path.join(home, 'daemon-runtime')), 'the daemon runs from its own copy of the app');

  const status = () => page.evaluate(() => window.senju.updateStatus());
  await page.evaluate(() => window.senju.updateAction('check'));
  const offered = await until('the offer', async () => ((await status()).state === 'available' ? status() : null), 30000);
  check(offered.version === newVersion && offered.manual === false, `the update is offered to install, not as a page (${JSON.stringify(offered)})`);
  await page.evaluate(() => window.senju.updateAction('download'));
  const ready = await until('the download', async () => {
    const s = await status();
    if (s.state === 'error') return s;
    return s.state === 'ready' ? s : null;
  }, 300000);
  check(ready.state === 'ready', `the update is downloaded and staged (${JSON.stringify(ready)})`);
  check(version(installed) === oldVersion, 'the installed app is untouched until the user restarts');

  const exited = new Promise((r) => app.process().once('exit', r));
  await page.evaluate(() => window.senju.updateAction('install'));
  await exited;
  const relaunched = await until('the new version', () => appProcesses()[0], 30000).catch(() => 0);
  check(relaunched > 0, 'the new version starts');
  check(version(installed) === newVersion, `the installed app is ${newVersion}`);
  const dir = path.dirname(installed);
  const leftovers = () => fs.readdirSync(dir).filter((name) => name.startsWith('.Senju.app.'));
  await until('the old version to be removed', () => leftovers().length === 0, 30000).catch(() => {});
  check(leftovers().length === 0, `nothing of the update is left next to the app (${leftovers().join(', ') || 'none'})`);
  check(alive(daemonPid), 'the daemon kept running');
  check(jobs(await daemon()).includes('sleep 600'), 'the program in the terminal kept running');
  check(relaunched > 0 && alive(relaunched), 'the new version keeps running');
} catch (err) {
  console.log(`FAIL ${err.message}`);
  failures++;
} finally {
  for (const pid of appProcesses()) process.kill(pid, 'SIGTERM');
  if (daemonPid && alive(daemonPid)) {
    const socket = net.connect(path.join(home, 'daemon.sock'), () => socket.end(`${JSON.stringify({ type: 'hello', protocol: 2 })}\n${JSON.stringify({ type: 'shutdown' })}\n`));
    socket.on('error', () => {});
    await until('the daemon to stop', () => !alive(daemonPid), 20000).catch(() => process.kill(daemonPid, 'SIGKILL'));
  }
  server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
