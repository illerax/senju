// Measures how long a typed key takes to appear on screen while other visible
// panes print a lot of output.
// Usage: node scripts/ui-latency.mjs [seconds]  (after npm run build)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';

const seconds = Number(process.argv[2] ?? 30);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-uilat-'));
const app = await _electron.launch({ args: ['--no-sandbox', '.'], env: { ...process.env, SENJU_HOME: home, XDG_RUNTIME_DIR: home } });
const page = await app.firstWindow();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.waitForSelector('.empty');
await page.click('#add-group');
await page.waitForSelector('.pane .xterm');
await page.keyboard.press('Control+Shift+D');
await sleep(300);
await page.keyboard.press('Control+Shift+E');
await sleep(500);
const st = await page.evaluate(() => window.senju.state());
const panesOf = (node) => (node.type === 'pane' ? [node] : node.children.flatMap(panesOf));
const [typing, ...noisy] = panesOf(st.groups[0].workspaces[0].root);
const line = `printf '\\033[1;34m%s\\033[0m \\033[32m%s\\033[0m %s\\n' "$i" "$(date +%T.%N)" "${'lorem ipsum dolor sit amet '.repeat(4)}"`;
for (const pane of noisy) {
  await page.evaluate(([id, data]) => window.senju.send({ type: 'input', terminalId: id, data }), [pane.activeTab, `i=0; while :; do i=$((i+1)); ${line}; done\r`]);
}
await page.locator('.pane').first().locator('.xterm').click();
await page.evaluate(() => {
  window.__long = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask' });
});
await sleep(1500);

const samples = [];
const end = Date.now() + seconds * 1000;
let n = 0;
while (Date.now() < end) {
  const marker = `q${(n++ % 9) + 1}`;
  const start = Date.now();
  await page.keyboard.type(marker);
  await page.waitForFunction((m) => document.querySelector('.pane .xterm-rows')?.textContent?.includes(m), marker, { polling: 'raf', timeout: 5000 }).catch(() => null);
  samples.push(Date.now() - start);
  await page.keyboard.press('Control+U');
  await sleep(150);
}
const sorted = [...samples].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
console.log(`typed key to screen with ${noisy.length} flooding panes: median ${pct(0.5)}ms, p95 ${pct(0.95)}ms, max ${sorted.at(-1)}ms (n=${sorted.length})`);
const long = await page.evaluate(() => window.__long);
console.log(`renderer long tasks: ${long.length}, worst ${Math.round(Math.max(0, ...long))}ms`);
const exited = new Promise((r) => app.process().once('exit', r));
await page.evaluate(() => window.senju.stopAll());
await exited;
fs.rmSync(home, { recursive: true, force: true });
