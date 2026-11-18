import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';

/** Hash of the sources, so a UI can tell that the running daemon was built from other code. */
function buildId() {
  const hash = crypto.createHash('sha256');
  for (const dir of ['src', 'recipes']) {
    for (const file of fs.readdirSync(dir, { recursive: true }).sort()) {
      const full = `${dir}/${file}`;
      if (fs.statSync(full).isFile()) hash.update(full).update(fs.readFileSync(full));
    }
  }
  return hash.digest('hex').slice(0, 12);
}

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2023', define: { __SENJU_BUILD__: JSON.stringify(buildId()) } };

fs.rmSync('dist', { recursive: true, force: true });

await Promise.all([
  build({ ...common, entryPoints: { main: 'src/main/main.ts' }, outdir: 'dist', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: { preload: 'src/preload/preload.ts' }, outdir: 'dist', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: { daemon: 'src/daemon/main.ts' }, outdir: 'dist', platform: 'node', format: 'cjs', external: ['node-pty'] }),
  build({
    ...common,
    entryPoints: { app: 'src/renderer/app.ts' },
    outdir: 'dist/renderer',
    platform: 'browser',
    format: 'iife',
    loader: { '.woff2': 'file', '.woff': 'file' },
    assetNames: 'fonts/[name]-[hash]',
  }),
]);
fs.copyFileSync('src/renderer/index.html', 'dist/renderer/index.html');
fs.copyFileSync('build/icon.svg', 'dist/renderer/icon.svg');
fs.copyFileSync('build/icons/256x256.png', 'dist/icon.png');
