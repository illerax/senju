// Measures keystroke echo latency through the daemon while another terminal
// works in a folder on a network share that turns slow and then unreachable.
// The share is flakyfs.py, a FUSE file system (Linux, needs fusermount3).
// Usage: node scripts/flaky-share.mjs  (after npm run build)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-share-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mnt = path.join(home, 'share');
const modeFile = path.join(home, 'share-mode');
const setMode = (m) => fs.writeFileSync(modeFile, m);
fs.mkdirSync(mnt);
setMode('online');
const share = spawn('python3', [path.join(import.meta.dirname, 'flakyfs.py'), mnt, modeFile], { stdio: 'inherit' });
for (let i = 0; i < 50 && !fs.existsSync(path.join(mnt, 'project')); i++) await sleep(100);
const project = path.join(mnt, 'project');

// A program the nvim recipe matches; detecting it checks for Session.vim in its folder.
fs.mkdirSync(path.join(home, 'bin'));
const fakeNvim = path.join(home, 'bin', 'nvim');
fs.copyFileSync('/bin/sleep', fakeNvim);
fs.chmodSync(fakeNvim, 0o755);

const env = { ...process.env, SENJU_HOME: home, XDG_RUNTIME_DIR: home, ELECTRON_RUN_AS_NODE: '1' };
const logFd = fs.openSync(path.join(home, 'daemon.log'), 'a');
const daemon = spawn(electron, ['dist/daemon.js'], { env, stdio: ['ignore', logFd, logFd] });

let socket;
for (let i = 0; i < 100 && !socket; i++) {
  await sleep(100);
  socket = await new Promise((resolve) => {
    const s = net.connect(path.join(home, 'daemon.sock'), () => resolve(s));
    s.on('error', () => resolve(null));
  });
}
let state = null;
const listeners = new Set();
let buf = '';
socket.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.type === 'state') state = msg.state;
    for (const l of listeners) l(msg);
  }
});
const send = (msg) => socket.write(`${JSON.stringify(msg)}\n`);
send({ type: 'hello', protocol: 2 });
send({ type: 'action', action: { type: 'createGroup', name: 'share', cwd: home } });
while (!state?.groups.length) await sleep(50);
const rootPane = state.groups[0].workspaces[0].root;
send({ type: 'action', action: { type: 'splitPane', paneId: rootPane.id, side: 'right' } });
while (Object.keys(state.terminals).length < 2) await sleep(50);
const panes = state.groups[0].workspaces[0].root.children;
const probe = panes[0].activeTab;
const sharePane = panes[1].id;
const onShare = panes[1].activeTab;
for (const id of [probe, onShare]) send({ type: 'attach', terminalId: id });
await sleep(1000);
send({ type: 'input', terminalId: onShare, data: `cd ${project}\r` });
await sleep(2500);
console.log(`terminal cwd seen by the daemon: ${state.terminals[onShare].cwd === project ? 'on the share' : state.terminals[onShare].cwd}`);

// Types into the probe terminal continuously and records how long each echo takes.
let phase = 'online';
const samples = [];
let probing = true;
const prober = (async () => {
  let n = 0;
  while (probing) {
    const marker = `k${n++}`;
    const start = Date.now();
    const echoed = new Promise((resolve) => {
      let seen = '';
      const l = (msg) => {
        if (msg.terminalId !== probe || msg.type !== 'data') return;
        seen += msg.data;
        if (seen.includes(marker)) {
          listeners.delete(l);
          resolve();
        }
      };
      listeners.add(l);
    });
    const label = phase;
    send({ type: 'input', terminalId: probe, data: marker });
    await echoed;
    samples.push({ phase: label, ms: Date.now() - start });
    send({ type: 'input', terminalId: probe, data: '\x15' });
    await sleep(50);
  }
})();

/** What a user does in the terminal on the share: opens a tab there and starts a program. */
const work = () => {
  send({ type: 'action', action: { type: 'createTab', paneId: sharePane } });
  send({ type: 'input', terminalId: onShare, data: `\x03${fakeNvim} 1000\r` });
};

await sleep(3000);
phase = 'slow share (1.5 s per request)';
setMode('slow 1500');
work();
await sleep(8000);
send({ type: 'input', terminalId: onShare, data: '\x03' });
await sleep(1000);
phase = 'unreachable share (10 s)';
setMode('offline');
work();
await sleep(10000);
setMode('online');
phase = 'share back online';
await sleep(4000);
probing = false;
await prober;

const phases = [...new Set(samples.map((s) => s.phase))];
for (const p of phases) {
  const ms = samples.filter((s) => s.phase === p).map((s) => s.ms).sort((a, b) => a - b);
  const pct = (q) => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))];
  console.log(`${p}: echo median ${pct(0.5)}ms, p95 ${pct(0.95)}ms, max ${ms.at(-1)}ms (n=${ms.length})`);
}
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
const slowest = Math.max(...samples.map((s) => s.ms));
check(slowest < 200, `typing never stalled (slowest echo ${slowest}ms)`);
const tabs = state.groups[0].workspaces[0].root.children[1].tabs;
check(tabs.slice(1).every((id) => state.terminals[id].cwd === project), 'tabs opened while the share was slow or down start in its folder');

// A folder that is gone: the new tab starts in the home folder.
const gone = path.join(home, 'gone');
fs.mkdirSync(gone);
send({ type: 'input', terminalId: onShare, data: `\x03cd ${gone}\r` });
await sleep(2500);
fs.rmdirSync(gone);
const before = new Set(Object.keys(state.terminals));
send({ type: 'action', action: { type: 'activateTab', terminalId: onShare } });
send({ type: 'action', action: { type: 'createTab', paneId: sharePane } });
await sleep(2500);
const goneTab = Object.keys(state.terminals).find((id) => !before.has(id));
check(state.terminals[goneTab].cwd === os.homedir(), 'a tab in a deleted folder starts in the home folder');

// A recipe that requires a file still applies when the file is there.
const withSession = path.join(home, 'nvim-project');
fs.mkdirSync(withSession);
fs.writeFileSync(path.join(withSession, 'Session.vim'), '');
send({ type: 'input', terminalId: probe, data: `cd ${withSession} && ${fakeNvim} 1000\r` });
await sleep(2500);
check(state.terminals[probe].job?.recipe === 'nvim', 'nvim with Session.vim is detected');

send({ type: 'shutdown' });
await new Promise((r) => daemon.once('exit', r));
spawn('fusermount3', ['-u', '-z', mnt], { stdio: 'inherit' }).once('exit', () => {
  share.kill();
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
});
