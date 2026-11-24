// The `senju` command in every terminal, and the MCP server Claude Code gets
// through the plugin of agent-hooks.ts. Both run the CLI (src/cli) with the
// daemon's own Electron as Node, so they work on every platform without Node
// installed, and talk to the daemon over its socket.

import fs from 'node:fs';
import path from 'node:path';

/** The CLI script next to the daemon's bundle. */
export const cliScript = () => path.join(__dirname, 'cli.js');

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Writes the `senju` command into `binDir`: a sh script, and a cmd script on Windows. */
export async function writeCommand(binDir: string, executable = process.execPath, script = cliScript()): Promise<void> {
  await fs.promises.mkdir(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const cmd = ['@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `"${executable}" "${script}" %*`, ''].join('\r\n');
    await fs.promises.writeFile(path.join(binDir, 'senju.cmd'), cmd);
    return;
  }
  const sh = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(executable)} ${shQuote(script)} "$@"\n`;
  const file = path.join(binDir, 'senju');
  await fs.promises.writeFile(`${file}.tmp`, sh, { mode: 0o755 });
  await fs.promises.rename(`${file}.tmp`, file);
}

/** The MCP server's entry in a Claude Code `.mcp.json`. */
export function mcpServer(executable = process.execPath, script = cliScript()): { command: string; args: string[]; env: Record<string, string> } {
  return { command: executable, args: [script, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * Variables that give a terminal the `senju` command: its folder first in
 * PATH, once, and the daemon's socket. `env` is the terminal's environment,
 * whose PATH may already hold the folder from before a restart.
 */
export function commandEnv(binDir: string, socket: string, env: Record<string, string>): Record<string, string> {
  // Windows spells it Path.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const rest = (env[key] ?? '').split(path.delimiter).filter((d) => d && d !== binDir);
  return { [key]: [binDir, ...rest].join(path.delimiter), SENJU_SOCKET: socket };
}
