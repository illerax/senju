// Load test with agents: terminal UIs that redraw a status block many times a
// second, print bursts of text and switch between working and waiting, spread
// over several groups and workspaces as when a user runs many agents at once.
// Measures typing latency in a shell next to them, workspace switching, how
// long the renderer and main process threads are blocked, the CPU time of the
// daemon, main and renderer processes, and what the UI receives per second.
// Usage: node scripts/agents-perf.mjs [seconds]  (after npm run build)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';

const seconds = Number(process.argv[2] ?? 20);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-agents-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const agent = path.resolve('scripts/fake-agent.mjs');
fs.mkdirSync(path.join(home, 'recipes'));
fs.writeFileSync(path.join(home, 'recipes', 'fake-agent.json'), JSON.stringify({ name: 'fake-agent', match: 'fake-agent' }));

const app = await _electron.launch({ args: ['--no-sandbox', '.'], env: { ...process.env, SENJU_HOME: home, XDG_RUNTIME_DIR: home } });
const page = await app.firstWindow();
await page.waitForSelector('.empty');
const send = (msg) => page.evaluate((m) => window.senju.send(m), msg);
const state = () => page.evaluate(() => window.senju.state());
const panesOf = (node) => (node.type === 'pane' ? [node] : node.children.flatMap(panesOf));
const workspaces = (st) => st.groups.flatMap((g) => g.workspaces);

// 4 groups and 5 workspaces; 8 agents, and a shell to type in next to two of them.
for (let i = 1; i <= 4; i++) {
  await send({ type: 'action', action: { type: 'createGroup', name: `project ${i}`, cwd: os.tmpdir() } });
  await sleep(300);
}
let st = await state();
await send({ type: 'action', action: { type: 'createWorkspace', groupId: st.groups[0].id } });
await sleep(300);
st = await state();
const agentTerminals = [];
for (const [index, workspace] of workspaces(st).entries()) {
  if (index === 4) continue;
  const first = panesOf(workspace.root)[0];
  await send({ type: 'action', action: { type: 'splitPane', paneId: first.id, side: 'right' } });
  await sleep(300);
  if (index === 0) {
    await send({ type: 'action', action: { type: 'splitPane', paneId: first.id, side: 'down' } });
    await sleep(300);
  }
}
st = await state();
let typingTerminal = null;
for (const [index, workspace] of workspaces(st).entries()) {
  const ids = panesOf(workspace.root).map((p) => p.activeTab);
  if (index === 0) {
    typingTerminal = ids[0];
    agentTerminals.push(...ids.slice(1));
  } else if (index < 4) {
    agentTerminals.push(...ids);
  }
}
await page.waitForTimeout(1000);
for (const id of agentTerminals) await send({ type: 'input', terminalId: id, data: `node ${agent}\r` });
// Show the workspace with the shell.
await send({ type: 'action', action: { type: 'activateWorkspace', workspaceId: workspaces(st)[0].id } });
await sleep(3000);
st = await state();
const recognised = Object.values(st.terminals).filter((t) => t.job?.recipe === 'fake-agent').length;
console.log(`agents: ${agentTerminals.length} started, ${recognised} recognised; ${Object.keys(st.terminals).length} terminals in ${workspaces(st).length} workspaces`);

// Instruments: blocked time of the renderer and main threads, and the messages the UI receives.
await page.evaluate(() => {
  window.__perf = { long: [], lag: [], msgs: {}, bytes: {}, streams: {} };
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__perf.long.push(e.duration))).observe({ type: 'longtask' });
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    window.__perf.lag.push(now - last - 20);
    last = now;
  }, 20);
  window.senju.onMessage((m) => {
    window.__perf.msgs[m.type] = (window.__perf.msgs[m.type] ?? 0) + 1;
    window.__perf.bytes[m.type] = (window.__perf.bytes[m.type] ?? 0) + (m.type === 'data' ? m.data.length : JSON.stringify(m).length);
    if (m.type === 'data') window.__perf.streams[m.terminalId] = (window.__perf.streams[m.terminalId] ?? 0) + m.data.length;
  });
});
await app.evaluate(() => {
  globalThis.__lag = [];
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    globalThis.__lag.push(now - last - 20);
    last = now;
  }, 20);
});
const daemonPid = Number(/daemon (\d+) started/.exec(fs.readFileSync(path.join(home, 'daemon.log'), 'utf8'))[1]);
const mainPid = app.process().pid;
const rendererPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
const ticks = (pid) => {
  const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return Number(fields[11]) + Number(fields[12]);
};
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 'no samples';
  const pct = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]);
  return `median ${pct(0.5)}ms, p95 ${pct(0.95)}ms, p99 ${pct(0.99)}ms, max ${Math.round(s.at(-1))}ms (n=${s.length})`;
};

/** Runs `work` and reports what it cost: CPU, blocked threads and what the UI received. */
async function phase(label, work) {
  await page.evaluate(() => Object.assign(window.__perf, { long: [], lag: [], msgs: {}, bytes: {}, streams: {} }));
  await app.evaluate(() => (globalThis.__lag = []));
  const start = { daemon: ticks(daemonPid), main: ticks(mainPid), renderer: ticks(rendererPid), at: Date.now() };
  const lines = await work();
  const elapsed = (Date.now() - start.at) / 1000;
  const cpu = (name, pid) => `${name} ${Math.round(((ticks(pid) - start[name]) / 100 / elapsed) * 100)}%`;
  const perf = await page.evaluate(() => window.__perf);
  const rate = (type) => `${type} ${Math.round((perf.msgs[type] ?? 0) / elapsed)}/s ${Math.round((perf.bytes[type] ?? 0) / elapsed / 1024)} KB/s`;
  console.log(`\n${label} (${Math.round(elapsed)}s)`);
  for (const line of lines) console.log(`  ${line}`);
  console.log(`  CPU: ${cpu('daemon', daemonPid)}, ${cpu('main', mainPid)}, ${cpu('renderer', rendererPid)}`);
  console.log(`  renderer long tasks: ${perf.long.length}, total ${Math.round(perf.long.reduce((a, b) => a + b, 0))}ms, worst ${Math.round(Math.max(0, ...perf.long))}ms`);
  console.log(`  renderer timer lag: ${stats(perf.lag)}`);
  console.log(`  main timer lag: ${stats(await app.evaluate(() => globalThis.__lag))}`);
  console.log(`  UI receives: ${rate('state')}, ${rate('data')}, ${rate('snapshot')}; output of ${Object.keys(perf.streams).length} terminals`);
}

/** Typing in the shell next to two agents. */
async function typing() {
  await page.locator(`.terminal[data-terminal-id="${typingTerminal}"]`).click();
  const samples = [];
  const end = Date.now() + seconds * 1000;
  for (let n = 0; Date.now() < end; n++) {
    const marker = `q${(n % 9) + 1}`;
    const start = Date.now();
    await page.keyboard.type(marker);
    await page.waitForFunction(([id, m]) => document.querySelector(`.terminal[data-terminal-id="${id}"] .xterm-rows`)?.textContent?.includes(m), [typingTerminal, marker], { polling: 'raf', timeout: 5000 }).catch(() => null);
    samples.push(Date.now() - start);
    await page.keyboard.press('Control+U');
    await sleep(150);
  }
  return [`typed key to screen: ${stats(samples)}`];
}

await phase('Typing, only this workspace shown so far', typing);

const switching = [];
await phase('Switching workspaces, first visits included', async () => {
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => (window.__prev = document.querySelector('#workspace > *')));
    const start = Date.now();
    await page.keyboard.press('Control+Shift+PageDown');
    await page.waitForFunction(() => document.querySelector('#workspace > *') !== window.__prev, null, { polling: 'raf', timeout: 5000 }).catch(() => null);
    switching.push(Date.now() - start);
    await sleep(300);
  }
  return [`workspace switch: ${stats(switching)}`, `first five (first visits): ${switching.slice(0, 5).join(', ')}ms`];
});
// Back to the workspace with the shell.
await send({ type: 'action', action: { type: 'activateWorkspace', workspaceId: workspaces(st)[0].id } });
await sleep(1000);

await phase('Typing, every workspace shown before', typing);

await phase('Resizing the window: visible agents print their conversation again', async () => {
  const sizes = [];
  for (let i = 0; i < 6; i++) {
    const start = Date.now();
    await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 800), i % 2 ? 1280 : 1100);
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => r(true))));
    sizes.push(Date.now() - start);
    await sleep(1500);
  }
  return [`resize to next frame: ${stats(sizes)}`];
});

const exited = new Promise((r) => app.process().once('exit', r));
await page.evaluate(() => window.senju.stopAll());
await exited;
// What the app itself logged.
const logFile = path.join(home, 'diagnostics.log');
const logged = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
const entries = logged.filter((e) => e.event !== 'start');
const byEvent = Object.entries(Object.groupBy(entries, (e) => `${e.source}: ${e.event}`)).map(([k, v]) => `${k} ×${v.length}`);
console.log(`\ndiagnostics.log: ${entries.length ? byEvent.join(', ') : 'nothing slow, no errors'}`);
if (process.env.SHOW_DIAGNOSTICS) for (const e of entries) console.log(JSON.stringify(e));
fs.rmSync(home, { recursive: true, force: true });
