// Inspection of the processes running in a terminal: the shell's working
// directory and the foreground job.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  argv: string[];
  cwd: string | null;
  /** Null when the platform does not expose another process's environment. */
  env: Record<string, string> | null;
}

export interface TerminalProcesses {
  shellCwd: string | null;
  shellEnv: Record<string, string> | null;
  /** Leader of the foreground process group, when it is not the shell. */
  job: ProcessInfo | null;
  /** Children of the job leader, used to recognise agents started through wrappers like npx. */
  jobChildren: ProcessInfo[];
}

const none: TerminalProcesses = { shellCwd: null, shellEnv: null, job: null, jobChildren: [] };

export function parseEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

async function readLinux(pid: number): Promise<ProcessInfo | null> {
  try {
    const [cmdline, cwd, environ] = await Promise.all([
      fs.readFile(`/proc/${pid}/cmdline`, 'utf8'),
      fs.readlink(`/proc/${pid}/cwd`).catch(() => null),
      fs.readFile(`/proc/${pid}/environ`, 'utf8').catch(() => null),
    ]);
    let argv = cmdline.split('\0').filter((a, i, all) => a !== '' || i < all.length - 1);
    // Programs that set process.title (npm, for one) leave a single space-separated string.
    if (argv.length === 1 && /\s/.test(argv[0])) argv = argv[0].split(/\s+/).filter(Boolean);
    if (argv.length === 0) return null;
    return { pid, argv, cwd, env: environ === null ? null : parseEnviron(environ) };
  } catch {
    return null;
  }
}

async function linuxChildren(pid: number): Promise<number[]> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return raw.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function inspectLinux(shellPid: number): Promise<TerminalProcesses> {
  let stat: string;
  try {
    stat = await fs.readFile(`/proc/${shellPid}/stat`, 'utf8');
  } catch {
    return none;
  }
  // Fields after the parenthesised command name: state ppid pgrp session tty_nr tpgid ...
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const pgrp = Number(fields[2]);
  const tpgid = Number(fields[5]);
  const shell = await readLinux(shellPid);
  let job: ProcessInfo | null = null;
  let jobChildren: ProcessInfo[] = [];
  if (tpgid > 0 && tpgid !== pgrp) {
    job = await readLinux(tpgid);
    if (job) {
      const kids = await linuxChildren(tpgid);
      jobChildren = (await Promise.all(kids.slice(0, 8).map(readLinux))).filter((p): p is ProcessInfo => p !== null);
    }
  }
  return { shellCwd: shell?.cwd ?? null, shellEnv: shell?.env ?? null, job, jobChildren };
}

async function darwinCwd(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const line = stdout.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

async function inspectDarwin(shellPid: number): Promise<TerminalProcesses> {
  try {
    const { stdout } = await run('ps', ['-o', 'pgid=,tpgid=', '-p', String(shellPid)]);
    const [pgrp, tpgid] = stdout.trim().split(/\s+/).map(Number);
    const shellCwd = await darwinCwd(shellPid);
    let job: ProcessInfo | null = null;
    if (tpgid > 0 && tpgid !== pgrp) {
      const { stdout: args } = await run('ps', ['-ww', '-o', 'args=', '-p', String(tpgid)]).catch(() => ({ stdout: '' }));
      const argv = args.trim().split(/\s+/).filter(Boolean);
      if (argv.length > 0) job = { pid: tpgid, argv, cwd: await darwinCwd(tpgid), env: null };
    }
    return { shellCwd, shellEnv: null, job, jobChildren: [] };
  } catch {
    return none;
  }
}

export async function inspectTerminal(shellPid: number): Promise<TerminalProcesses> {
  if (process.platform === 'linux') return inspectLinux(shellPid);
  if (process.platform === 'darwin') return inspectDarwin(shellPid);
  // Windows (ConPTY) does not expose the foreground process; only the initial directory is tracked.
  return none;
}
