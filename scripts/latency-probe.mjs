// Measures keystroke echo latency through the daemon while other terminals
// produce a lot of output and fill their scrollback.
// Usage: node scripts/latency-probe.mjs [seconds]  (after npm run build)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const seconds = Number(process.argv[2] ?? 45);
const electron = createRequire(import.meta.url)('electron');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-lat-'));
const env = { ...process.env, SENJU_HOME: home, XDG_RUNTIME_DIR: home, ELECTRON_RUN_AS_NODE: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
send({ type: 'hello', protocol: 3 });
send({ type: 'action', action: { type: 'createGroup', name: 'lat', cwd: home } });
while (!state?.groups.length) await sleep(50);
const root = () => state.groups[0].workspaces[0].root;
const paneId = root().id;
for (let i = 0; i < 6; i++) send({ type: 'action', action: { type: 'createTab', paneId } });
while (Object.keys(state.terminals).length < 7) await sleep(50);
const [probe, ...noisy] = Object.keys(state.terminals);
for (const id of [probe, ...noisy]) send({ type: 'attach', terminalId: id });
await sleep(1000);
// Fast, long output: fills 10k lines of scrollback quickly in every noisy terminal.
// Long colored lines, like an agent's output.
const line = `printf '\\033[1;34m%s\\033[0m \\033[32m%s\\033[0m %s\\n' "$i" "$(date +%T.%N)" "${'lorem ipsum dolor sit amet consectetur '.repeat(3)}"`;
for (const id of noisy) send({ type: 'input', terminalId: id, data: `i=0; while :; do i=$((i+1)); ${line}; [ $((i % 200)) -eq 0 ] && sleep 0.05; done\r` });
await sleep(2000);

const samples = [];
const end = Date.now() + seconds * 1000;
let n = 0;
while (Date.now() < end) {
  const marker = `k${n++}`;
  const start = process.hrtime.bigint();
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
  send({ type: 'input', terminalId: probe, data: marker });
  await echoed;
  samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  send({ type: 'input', terminalId: probe, data: '\x15' });
  // Switching tabs, like a user does, saves the state each time.
  if (n % 5 === 0) send({ type: 'action', action: { type: 'activateTab', terminalId: noisy[n % noisy.length] } });
  await sleep(100);
}
const sorted = [...samples].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1);
console.log(`echo latency over ${seconds}s: median ${pct(0.5)}ms, p95 ${pct(0.95)}ms, p99 ${pct(0.99)}ms, max ${sorted.at(-1).toFixed(1)}ms (n=${sorted.length})`);
console.log(`slow echoes (>100ms): ${samples.filter((x) => x > 100).length}`);
const stat = fs.statSync(path.join(home, 'state.json'));
console.log(`state file: ${(stat.size / 1e6).toFixed(1)} MB`);
send({ type: 'shutdown' });
await new Promise((r) => daemon.once('exit', r));
console.log(fs.readFileSync(path.join(home, 'daemon.log'), 'utf8').split('\n').filter((l) => l.includes('TRACE')).map((l) => l.split('TRACE ')[1]).join('\n'));
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
