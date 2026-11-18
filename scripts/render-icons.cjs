// Renders build/icon.svg into the PNG icons the app and its packages use.
// Usage: npm run icons
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

const root = path.join(__dirname, '..');
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'base64');
  const big = 1024;
  const win = new BrowserWindow({ width: big, height: big, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL(
    `data:text/html,${encodeURIComponent(`<style>html,body{margin:0;background:transparent;overflow:hidden}</style><img src="data:image/svg+xml;base64,${svg}" width="${big}" height="${big}">`)}`,
  );
  await new Promise((r) => setTimeout(r, 300));
  const captured = await win.webContents.capturePage({ x: 0, y: 0, width: big, height: big });
  const master = nativeImage.createFromBuffer(captured.resize({ width: big, height: big, quality: 'best' }).toPNG());
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), master.toPNG());
  fs.mkdirSync(path.join(root, 'build', 'icons'), { recursive: true });
  for (const size of sizes) {
    fs.writeFileSync(path.join(root, 'build', 'icons', `${size}x${size}.png`), master.resize({ width: size, height: size, quality: 'best' }).toPNG());
  }
  console.log(`wrote build/icon.png and ${sizes.length} sizes in build/icons`);
  app.quit();
});
