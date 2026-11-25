// The `senju` command in Senju's terminals (src/daemon/senju-command.ts):
// shows files and content in a viewer next to the terminal it runs in, and
// serves the same as an MCP server for agents. The app itself runs it too
// (src/main/main.ts), as the installed `senju` may come first in a PATH.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { PROTOCOL_VERSION, type ClientMessage, type DaemonMessage } from '../shared/protocol';
import { handleMcp, type Shown, type ShowRequest } from './mcp';

declare const __SENJU_VERSION__: string;

const usage = `Usage:
  senju open FILE...            show files in a tab next to this terminal
  senju show [FILE]             show what is piped in (or a file)
  senju mcp                     run the MCP server with the same tools

Options:
  --format, -f FORMAT   markdown, json, yaml, html, csv, image, text, or a language
                        such as python; by default the file's extension tells
  --name, -n NAME       the tab's name
  --window, -w          open in a window of its own

The tab reloads whenever the file changes. Content shown again under the same
name replaces the tab's, wherever it was moved.
`;

/** Sends one show request to the daemon; resolves to the viewer shown. */
function show(request: ShowRequest): Promise<Shown> {
  const socket = process.env.SENJU_SOCKET;
  const terminalId = process.env.SENJU_TERMINAL_ID;
  if (!socket || !terminalId) return Promise.reject(new Error('senju works in terminals of Senju only.'));
  let file = request.file;
  if (file !== undefined) {
    file = path.resolve(file);
    if (!fs.existsSync(file)) return Promise.reject(new Error(`${file} does not exist.`));
    if (!fs.statSync(file).isFile()) return Promise.reject(new Error(`${file} is not a file.`));
  }
  const msg: ClientMessage = { type: 'show', protocol: PROTOCOL_VERSION, terminalId, ...request, file };
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket);
    const timer = setTimeout(() => finish(new Error('Senju did not answer.')), 10_000);
    let buffer = '';
    const finish = (result: Error | Shown) => {
      clearTimeout(timer);
      connection.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    connection.setEncoding('utf8');
    connection.on('connect', () => connection.write(`${JSON.stringify(msg)}\n`));
    connection.on('error', (err) => finish(new Error(`Cannot reach Senju: ${err.message}`)));
    connection.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let reply: DaemonMessage;
        try {
          reply = JSON.parse(line);
        } catch {
          continue;
        }
        if (reply.type === 'shown') finish({ viewerId: reply.viewerId, updated: reply.updated });
        if (reply.type === 'error') finish(new Error(reply.message));
      }
    });
  });
}

function parse(args: string[]): { options: Omit<ShowRequest, 'file' | 'content'>; files: string[] } {
  const options: Omit<ShowRequest, 'file' | 'content'> = {};
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      const next = args[++i];
      if (next === undefined) throw new Error(`${arg} needs a value.`);
      return next;
    };
    if (arg === '--') {
      files.push(...args.slice(i + 1));
      break;
    }
    if (arg === '--format' || arg === '-f') options.format = value();
    else if (arg === '--name' || arg === '-n') options.name = value();
    else if (arg === '--window' || arg === '-w') options.window = true;
    else if (arg.startsWith('--format=')) options.format = arg.slice(9);
    else if (arg.startsWith('--name=')) options.name = arg.slice(7);
    else if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option ${arg}.`);
    else files.push(arg);
  }
  return { options, files };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function serveMcp(): void {
  const lines = readline.createInterface({ input: process.stdin });
  const reply = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const shown = (request: ShowRequest) => show({ ...request, file: request.file && path.resolve(request.file) });
    void handleMcp(message, shown, __SENJU_VERSION__).then((answer) => answer && reply(answer));
  });
  lines.on('close', () => process.exit(0));
}

/**
 * Whether the app was started as the `senju` command rather than to open its
 * windows: in a terminal of Senju, or as an MCP server, which an agent may
 * start anywhere and which then says that it works in Senju only.
 */
export function isCommand(args: string[]): boolean {
  if (args[0] === 'mcp') return true;
  return !!process.env.SENJU_TERMINAL_ID && ['open', 'show', 'help', '--help', '-h'].includes(args[0]);
}

/** Runs the command; resolves to its exit code, or never for `mcp`, which exits when its input ends. */
export async function run(args: string[]): Promise<number> {
  try {
    await command(args);
    return 0;
  } catch (err) {
    process.stderr.write(`senju: ${(err as Error).message}\n`);
    return 1;
  }
}

async function command(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (name === 'mcp') {
    serveMcp();
    return new Promise(() => {});
  }
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    process.stdout.write(usage);
    return;
  }
  if (name !== 'open' && name !== 'show') throw new Error(`Unknown command ${name}.\n\n${usage}`);
  const { options, files } = parse(rest);
  if (name === 'show' && (files.length === 0 || files[0] === '-')) {
    if (process.stdin.isTTY) throw new Error('Pipe something into senju show, e.g. cat report.md | senju show -f markdown');
    await show({ ...options, content: await readStdin() });
    return;
  }
  if (files.length === 0) throw new Error(`Name a file to open.\n\n${usage}`);
  for (const file of files) await show({ ...options, file });
}
