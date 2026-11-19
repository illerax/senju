// Checks for and downloads updates from a server on a bad connection, one
// that never answers, drops connections or sends a byte at a time, and
// measures how long a typed key takes to appear on screen meanwhile.
// Usage: node scripts/flaky-updates.mjs  (after npm run build)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-updates-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

const yml = `version: 99.0.0
files:
  - url: Senju-99.0.0.AppImage
    sha512: ${'A'.repeat(86)}==
    size: 50000000
path: Senju-99.0.0.AppImage
sha512: ${'A'.repeat(86)}==
releaseDate: '2026-01-01T00:00:00.000Z'
`;
let mode = 'online';
const sockets = new Set();
const server = http.createServer((req, res) => {
  if (mode === 'hang') return;
  if (mode === 'drop') return req.socket.destroy();
  if (new URL(req.url, url).pathname.endsWith('.yml')) {
    res.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': Buffer.byteLength(yml) });
    if (mode !== 'trickle') return res.end(yml);
    let i = 0;
    const timer = setInterval(() => {
      if (i >= yml.length) {
        clearInterval(timer);
        return res.end();
      }
      res.write(yml.slice(i, (i += 20)));
    }, 200);
    return;
  }
  // The download: a fast start, then the connection breaks off or goes silent.
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 50_000_000 });
  res.write(Buffer.alloc(2_000_000));
  if (mode === 'download-drop') setTimeout(() => req.socket.destroy(), 1500);
});
server.on('connection', (s) => {
  sockets.add(s);
  s.on('close', () => sockets.delete(s));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

// Run from source, electron-updater downloads only with this file next to the app.
const devConfig = path.resolve('dev-app-update.yml');
fs.writeFileSync(devConfig, `provider: generic\nurl: ${url}\n`);
const stallMs = 5000;
// The Linux updater downloads only for an AppImage; it is replaced only on install, which this test never does.
const appImage = path.join(home, 'Senju.AppImage');
fs.writeFileSync(appImage, '');
const app = await _electron.launch({
  args: ['--no-sandbox', '.'],
  env: { ...process.env, SENJU_HOME: home, XDG_RUNTIME_DIR: home, SENJU_UPDATE_URL: url, SENJU_UPDATE_STALL_MS: String(stallMs), APPIMAGE: appImage },
});
const page = await app.firstWindow();
await page.waitForSelector('.empty');
await page.click('#add-group');
await page.waitForSelector('.pane .xterm');
await page.locator('.pane .xterm').first().click();
await page.evaluate(() => {
  window.__updates = [];
  window.senju.onUpdate((s) => window.__updates.push(s.state === 'error' ? `error: ${s.message}` : s.state));
  window.__long = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask' });
});
await sleep(1000);

/** Types for a while and returns the time from key press to screen for each key. */
const typeFor = async (ms) => {
  const samples = [];
  const end = Date.now() + ms;
  let n = 0;
  while (Date.now() < end) {
    const marker = `q${(n++ % 9) + 1}`;
    const start = Date.now();
    await page.keyboard.type(marker);
    await page.waitForFunction((m) => document.querySelector('.pane .xterm-rows')?.textContent?.includes(m), marker, { polling: 'raf', timeout: 10000 }).catch(() => null);
    samples.push(Date.now() - start);
    await page.keyboard.press('Control+U');
    await sleep(100);
  }
  return samples;
};
const statuses = async () => page.evaluate(() => window.__updates.splice(0));
const summary = (samples) => {
  const s = [...samples].sort((a, b) => a - b);
  return `median ${s[Math.floor(s.length / 2)]}ms, max ${s.at(-1)}ms (n=${s.length})`;
};

for (const [label, m] of [
  ['server never answers', 'hang'],
  ['connection dropped', 'drop'],
  ['a byte at a time', 'trickle'],
]) {
  mode = m;
  await page.evaluate(() => window.senju.updateAction('check'));
  const samples = await typeFor(stallMs + 3000);
  const seen = await statuses();
  console.log(`${label}: key to screen ${summary(samples)}; update status: ${[...new Set(seen)].join(' → ') || 'none'}`);
  check(Math.max(...samples) < 200, `${label}: typing never stalled`);
  check(seen.length && seen.at(-1) !== 'checking', `${label}: the check ends`);
  for (const s of sockets) s.destroy();
}

for (const [label, m] of [
  ['download broken off', 'download-drop'],
  ['download goes silent', 'download-stall'],
]) {
  mode = 'online';
  await page.evaluate(() => window.senju.updateAction('check'));
  await sleep(1000);
  mode = m;
  await page.evaluate(() => window.senju.updateAction('download'));
  const samples = await typeFor(stallMs + 4000);
  const seen = await statuses();
  console.log(`${label}: key to screen ${summary(samples)}; update status: ${[...new Set(seen.map((s) => s.replace(/^downloading.*/, 'downloading')))].join(' → ')}`);
  check(Math.max(...samples) < 200, `${label}: typing never stalled`);
  check(seen.at(-1)?.startsWith('error'), `${label}: the failure is shown`);
  for (const s of sockets) s.destroy();
}

const long = await page.evaluate(() => window.__long);
console.log(`renderer long tasks: ${long.length}, worst ${Math.round(Math.max(0, ...long))}ms`);
const exited = new Promise((r) => app.process().once('exit', r));
await page.evaluate(() => window.senju.stopAll());
await exited;
server.closeAllConnections();
server.close();
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(devConfig, { force: true });
process.exit(failures ? 1 : 0);
