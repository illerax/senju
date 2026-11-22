// Agent recipes: declarative descriptions of how to recognise an agent, find
// its session id and resume it. Built-in recipes live in /recipes; users add
// or override them with JSON files in the config directory.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { quoteArgs } from './shellquote';
import type { UsageSpec } from './usage';

import claudeCode from '../../recipes/claude-code.json';
import codex from '../../recipes/codex.json';
import gemini from '../../recipes/gemini.json';
import opencode from '../../recipes/opencode.json';
import aider from '../../recipes/aider.json';
import nvim from '../../recipes/nvim.json';

export interface SessionFiles {
  /** Directory template holding one file per session. */
  dir: string;
  /** Regular expression for file names; group 1 is the session id. */
  pattern: string;
  recursive?: boolean;
  /** When recursive, only descend into the N last subdirectories by name (e.g. date folders). */
  newestDirs?: number;
  /** Template of a string that must appear in the first 4 KiB of the file. */
  contains?: string;
}

export interface Recipe {
  name: string;
  /** Regular expression matched against the program name and path. */
  match: string;
  session?: {
    /** Regular expressions over the joined arguments; group 1 is the session id. */
    args?: string[];
    /** A file written by the agent per process that names its session. */
    pidFile?: { file: string; field: string };
    files?: SessionFiles;
  };
  /** Which original options ${flags} carries over; positional arguments are never carried over. */
  flags?: {
    drop?: string[];
    /** Options followed by a separate value. */
    withValue?: string[];
  };
  /** Command that reopens a known session. */
  resume?: string;
  /** Command used when the session id is unknown. */
  fallback?: string;
  /** File relative to the working directory that must exist for the recipe to apply. */
  requires?: string;
  /** How to read the context and token usage from the session files. */
  usage?: UsageSpec;
}

export const builtinRecipes = [claudeCode, codex, gemini, opencode, aider, nvim] as Recipe[];

function isRecipe(value: unknown): value is Recipe {
  const r = value as Recipe;
  return !!r && typeof r.name === 'string' && typeof r.match === 'string';
}

export function loadRecipes(dir: string): Recipe[] {
  const byName = new Map(builtinRecipes.map((r) => [r.name, r]));
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    // No user recipes.
  }
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const recipe of Array.isArray(parsed) ? parsed : [parsed]) {
        if (isRecipe(recipe)) byName.set(recipe.name, recipe);
      }
    } catch {
      // Skip invalid files.
    }
  }
  return [...byName.values()];
}

const interpreters = /^(node|nodejs|bun|deno|python[\d.]*|ruby|perl)$/;

/** The program a command line runs, looking through interpreters such as node. */
export function programOf(argv: string[]): { program: string; args: string[] } {
  const first = argv[0] ?? '';
  if (interpreters.test(path.basename(first))) {
    const scriptIndex = argv.findIndex((a, i) => i > 0 && !a.startsWith('-'));
    if (scriptIndex > 0) return { program: argv[scriptIndex], args: argv.slice(scriptIndex + 1) };
  }
  return { program: first, args: argv.slice(1) };
}

/** Checks of paths that have not answered yet, shared so a stalled path occupies one thread of the pool. */
const checking = new Map<string, Promise<boolean>>();

/**
 * Whether a path exists, or false if its file system does not answer in time.
 * A folder on a network share that lost its connection blocks every call on
 * it, so a synchronous check would freeze the daemon with all its terminals.
 */
export function pathExists(file: string, timeoutMs = 1000): Promise<boolean> {
  let check = checking.get(file);
  if (!check) {
    check = fsp.access(file).then(
      () => true,
      () => false,
    );
    checking.set(file, check);
    void check.then(() => checking.delete(file));
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(resolve, timeoutMs, false)));
  return Promise.race([check, timeout]).finally(() => clearTimeout(timer));
}

/** The files that recipes require in a working directory and that exist, for matchRecipe. */
export async function requiredFiles(recipes: Recipe[], cwds: string[]): Promise<Set<string>> {
  const files = [...new Set(cwds.flatMap((cwd) => recipes.filter((r) => r.requires).map((r) => path.resolve(cwd, r.requires!))))];
  const found = await Promise.all(files.map((file) => pathExists(file)));
  return new Set(files.filter((_, i) => found[i]));
}

/** The recipe for a command line; `present` holds the required files that exist (see requiredFiles). */
export function matchRecipe(recipes: Recipe[], argv: string[], cwd: string, present: ReadonlySet<string> = new Set()): Recipe | null {
  const { program } = programOf(argv);
  for (const recipe of recipes) {
    const re = new RegExp(recipe.match);
    if (!re.test(path.basename(program)) && !re.test(program)) continue;
    if (recipe.requires && !present.has(path.resolve(cwd, recipe.requires))) continue;
    return recipe;
  }
  return null;
}

export interface TemplateContext {
  cwd: string;
  env: Record<string, string | undefined>;
  argv?: string[];
  sessionId?: string;
  pid?: number;
  recipe?: Recipe;
}

/** The options of a command line, without positional arguments and without the recipe's dropped options. */
export function keptFlags(args: string[], flags: Recipe['flags']): string[] {
  const drop = new Set(flags?.drop ?? []);
  const withValue = new Set(flags?.withValue ?? []);
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-' || arg === '--') continue;
    const name = arg.split('=')[0];
    const takesValue = withValue.has(name) && !arg.includes('=') && i + 1 < args.length && !args[i + 1].startsWith('-');
    const value = takesValue ? args[++i] : undefined;
    if (drop.has(name)) continue;
    kept.push(arg);
    if (value !== undefined) kept.push(value);
  }
  return kept;
}

/** Expands ${name}, ${env:NAME} and ${env:NAME:-default} placeholders and a leading ~. */
export function expand(template: string, ctx: TemplateContext): string {
  const { program, args } = programOf(ctx.argv ?? []);
  const home = os.homedir();
  const vars: Record<string, string> = {
    cwd: ctx.cwd,
    cwdSlug: ctx.cwd.replace(/[^a-zA-Z0-9]/g, '-'),
    cwdJson: JSON.stringify(ctx.cwd),
    home,
    sessionId: ctx.sessionId ?? '',
    program: path.basename(program),
    args: quoteArgs(args),
    flags: quoteArgs(keptFlags(args, ctx.recipe?.flags)),
    pid: String(ctx.pid ?? ''),
  };
  const result = template.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    if (expr.startsWith('env:')) {
      const [name, fallback] = expr.slice(4).split(':-');
      return ctx.env[name] || fallback || '';
    }
    return vars[expr] ?? '';
  });
  return result.replace(/^~(?=\/|$)/, home);
}

export function sessionFromArgs(recipe: Recipe, argv: string[]): string | null {
  const joined = programOf(argv).args.join(' ');
  for (const pattern of recipe.session?.args ?? []) {
    const m = new RegExp(pattern).exec(joined);
    if (m?.[1]) return m[1];
  }
  return null;
}

export interface SessionFile {
  id: string;
  mtime: number;
}

async function walk(dir: string, spec: SessionFiles, depth: number, out: { file: string; name: string }[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const re = new RegExp(spec.pattern);
  for (const entry of entries) {
    if (entry.isFile() && re.test(entry.name)) out.push({ file: path.join(dir, entry.name), name: entry.name });
  }
  if (spec.recursive && depth < 6) {
    let dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    if (spec.newestDirs) dirs = dirs.slice(-spec.newestDirs);
    for (const sub of dirs) await walk(path.join(dir, sub), spec, depth + 1, out);
  }
}

async function head(file: string): Promise<string> {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Session files of a recipe for a working directory, modified at or after `since`. */
export async function listSessions(recipe: Recipe, ctx: TemplateContext, since: number): Promise<SessionFile[]> {
  const spec = recipe.session?.files;
  if (!spec) return [];
  const found: { file: string; name: string }[] = [];
  await walk(expand(spec.dir, ctx), spec, 0, found);
  const needle = spec.contains ? expand(spec.contains, ctx) : null;
  const re = new RegExp(spec.pattern);
  const sessions: SessionFile[] = [];
  for (const { file, name } of found) {
    try {
      const stat = await fsp.stat(file);
      if (stat.mtimeMs < since) continue;
      if (needle && !(await head(file)).includes(needle)) continue;
      const id = re.exec(name)?.[1];
      if (id) sessions.push({ id, mtime: stat.mtimeMs });
    } catch {
      // File vanished.
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

/** The file of a session, found as listSessions finds them. */
export async function findSessionFile(recipe: Recipe, ctx: TemplateContext, sessionId: string): Promise<string | null> {
  const spec = recipe.session?.files;
  if (!spec) return null;
  const found: { file: string; name: string }[] = [];
  await walk(expand(spec.dir, ctx), spec, 0, found);
  const re = new RegExp(spec.pattern);
  return found.find(({ name }) => re.exec(name)?.[1] === sessionId)?.file ?? null;
}

/** Command that brings an agent back after a reboot, or null if the recipe cannot. */
export function resumeCommand(recipe: Recipe, argv: string[], cwd: string, env: Record<string, string | undefined>, sessionId?: string): string | null {
  const template = sessionId && recipe.resume ? recipe.resume : recipe.fallback;
  if (!template) return null;
  const ctx = { cwd, env, argv, sessionId, recipe };
  // Expand word by word so placeholders that expand to nothing leave no gaps.
  return template
    .split(/\s+/)
    .map((word) => expand(word, ctx))
    .filter(Boolean)
    .join(' ');
}

/** Session id from the agent's per-process file, if the recipe has one and the file exists. */
export async function sessionFromPidFile(recipe: Recipe, ctx: TemplateContext): Promise<string | null> {
  const spec = recipe.session?.pidFile;
  if (!spec || !ctx.pid) return null;
  try {
    const data = JSON.parse(await fsp.readFile(expand(spec.file, ctx), 'utf8'));
    const value = data?.[spec.field];
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}
