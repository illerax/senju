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

// Every helper runs once per poll for all terminals and is killed when it hangs:
// a slow lsof on a loaded Mac must not pile up processes and load it further.
const DARWIN_TIMEOUT_MS = 5000;

async function darwinOutput(file: string, args: string[]): Promise<string> {
  try {
    return (await run(file, args, { timeout: DARWIN_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (err) {
    // lsof exits with 1 when one of the processes is gone but still lists the others.
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

export interface DarwinProcess {
  pgid: number;
  tpgid: number;
  argv: string[];
}

/** Parses `ps -o pid=,pgid=,tpgid=,args=`. */
export function parsePs(stdout: string): Map<number, DarwinProcess> {
  const processes = new Map<number, DarwinProcess>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(-?\d+)\s+(-?\d+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const argv = match[4].trim().split(/\s+/).filter(Boolean);
    processes.set(Number(match[1]), { pgid: Number(match[2]), tpgid: Number(match[3]), argv });
  }
  return processes;
}

/** Parses `lsof -d cwd -Fpn`: a `p<pid>` line followed by an `n<path>` line. */
export function parseLsofCwd(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid > 0 && !cwds.has(pid)) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

async function inspectDarwin(shellPids: number[]): Promise<Map<number, TerminalProcesses>> {
  const result = new Map<number, TerminalProcesses>();
  if (shellPids.length === 0) return result;
  const processes = parsePs(await darwinOutput('ps', ['-A', '-ww', '-o', 'pid=,pgid=,tpgid=,args=']));
  const jobs = new Map<number, number>();
  for (const pid of shellPids) {
    const shell = processes.get(pid);
    if (shell && shell.tpgid > 0 && shell.tpgid !== shell.pgid && processes.get(shell.tpgid)?.argv.length) jobs.set(pid, shell.tpgid);
  }
  // -b and -w keep lsof away from calls that block on unresponsive (network) mounts.
  const pids = [...new Set([...shellPids, ...jobs.values()])].filter((pid) => processes.has(pid));
  const cwds = pids.length > 0 ? parseLsofCwd(await darwinOutput('lsof', ['-b', '-w', '-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')])) : new Map<number, string>();
  for (const pid of shellPids) {
    if (!processes.has(pid)) {
      result.set(pid, none);
      continue;
    }
    const jobPid = jobs.get(pid);
    const job = jobPid === undefined ? null : { pid: jobPid, argv: processes.get(jobPid)!.argv, cwd: cwds.get(jobPid) ?? null, env: null };
    result.set(pid, { shellCwd: cwds.get(pid) ?? null, shellEnv: null, job, jobChildren: [] });
  }
  return result;
}

/** Parses `lsof -Fn`: the `n<path>` lines. */
export function parseLsofNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
}

/**
 * The paths of the files a process has open; null where that cannot be told,
 * or the process is gone. Reading the links does not touch the files, so a
 * dead share cannot block it.
 */
export async function openFiles(pid: number): Promise<string[] | null> {
  if (process.platform === 'linux') {
    const fds = await fs.readdir(`/proc/${pid}/fd`).catch(() => null);
    if (!fds) return null;
    const links = await Promise.all(fds.map((fd) => fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => null)));
    return links.filter((link): link is string => !!link && link.startsWith('/'));
  }
  if (process.platform === 'darwin') {
    const stdout = await darwinOutput('lsof', ['-b', '-w', '-Fn', '-p', String(pid)]);
    return stdout ? parseLsofNames(stdout) : null;
  }
  return null;
}

/** Whether a process has child processes; null where that cannot be told, or the process is gone. */
export async function hasChildren(pid: number): Promise<boolean | null> {
  if (process.platform === 'linux') {
    // Each thread lists the children it started.
    const threads = await fs.readdir(`/proc/${pid}/task`).catch(() => null);
    if (!threads) return null;
    for (const thread of threads) {
      const children = await fs.readFile(`/proc/${pid}/task/${thread}/children`, 'utf8').catch(() => null);
      // A thread may end while it is read.
      if (children?.trim()) return true;
    }
    return false;
  }
  if (process.platform === 'darwin') {
    try {
      await run('pgrep', ['-P', String(pid)], { timeout: DARWIN_TIMEOUT_MS, killSignal: 'SIGKILL' });
      return true;
    } catch (err) {
      // pgrep exits with 1 when nothing matches.
      return (err as { code?: unknown }).code === 1 ? false : null;
    }
  }
  return null;
}

/** Inspects the terminals with the given shell pids; the result has an entry for each pid. */
export async function inspectTerminals(shellPids: number[]): Promise<Map<number, TerminalProcesses>> {
  if (process.platform === 'darwin') return inspectDarwin(shellPids);
  // Windows (ConPTY) does not expose the foreground process; only the initial directory is tracked.
  const inspect = process.platform === 'linux' ? inspectLinux : async () => none;
  const infos = await Promise.all(shellPids.map(inspect));
  return new Map(shellPids.map((pid, i) => [pid, infos[i]]));
}
