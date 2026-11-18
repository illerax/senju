// Crash-safe persistence: the workspace state in one small JSON file, written
// on every change, and each terminal's scrollback in a file of its own,
// written now and then. Keeping the large scrollback out of the state file
// keeps every save, such as one per tab switch, cheap.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emptyState, type AppState, type LayoutNode } from '../shared/types';

interface V1Layout {
  type: 'pane' | 'split';
  paneId?: string;
  id?: string;
  direction?: 'row' | 'column';
  children?: V1Layout[];
  sizes?: number[];
}

interface V1State {
  version: 1;
  projects: { id: string; name: string; cwd: string; windows: { id: string; name: string; root: V1Layout; focusedPaneId: string }[]; activeWindowId: string | null }[];
  activeProjectId: string | null;
  panes: AppState['terminals'];
  ui: AppState['ui'];
}

/** Version 1 had projects with windows of single-terminal panes; each pane becomes a pane with one tab. */
function migrateV1(old: V1State): AppState {
  const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const active = old.projects.find((p) => p.id === old.activeProjectId);
  return {
    version: 2,
    groups: old.projects.map((project) => ({
      id: project.id,
      name: project.name,
      cwd: project.cwd,
      collapsed: false,
      workspaces: project.windows.map((window) => {
        const leafIds = new Map<string, string>();
        const convert = (node: V1Layout): LayoutNode => {
          if (node.type === 'pane') {
            const leaf = id();
            leafIds.set(node.paneId!, leaf);
            return { type: 'pane', id: leaf, tabs: [node.paneId!], activeTab: node.paneId! };
          }
          return { type: 'split', id: node.id!, direction: node.direction!, sizes: node.sizes!, children: node.children!.map(convert) };
        };
        const root = convert(window.root);
        return { id: window.id, name: window.name, root, focusedPaneId: leafIds.get(window.focusedPaneId) ?? '' };
      }),
    })),
    activeWorkspaceId: active?.activeWindowId ?? null,
    terminals: old.panes ?? {},
    ui: old.ui ?? {},
  };
}

export function scrollbackDir(stateFile: string): string {
  return path.join(path.dirname(stateFile), 'scrollback');
}

const scrollbackFile = (stateFile: string, terminalId: string) => path.join(scrollbackDir(stateFile), `${terminalId.replace(/[^\w-]/g, '')}.ansi`);

export function loadState(file: string): AppState {
  for (const candidate of [file, `${file}.tmp`]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      let state: AppState | null = null;
      if (parsed?.version === 1 && Array.isArray(parsed.projects)) state = migrateV1(parsed);
      if (parsed?.version === 2 && Array.isArray(parsed.groups)) state = { ...emptyState(), ...parsed };
      if (!state) continue;
      // Older state files kept the scrollback inline; move it to its own files.
      for (const terminal of Object.values(state.terminals) as (AppState['terminals'][string] & { scrollback?: string })[]) {
        if (typeof terminal.scrollback === 'string') writeScrollbackSync(file, terminal.id, terminal.scrollback);
        delete terminal.scrollback;
      }
      return state;
    } catch {
      // Try the next candidate.
    }
  }
  return emptyState();
}

export function readScrollback(stateFile: string, terminalId: string): string | undefined {
  try {
    return fs.readFileSync(scrollbackFile(stateFile, terminalId), 'utf8');
  } catch {
    return undefined;
  }
}

/** Writes a terminal's scrollback atomically without blocking the event loop. */
export async function writeScrollback(stateFile: string, terminalId: string, data: string): Promise<void> {
  const target = scrollbackFile(stateFile, terminalId);
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp`;
  const handle = await fs.promises.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmp, target);
}

export function writeScrollbackSync(stateFile: string, terminalId: string, data: string): void {
  const target = scrollbackFile(stateFile, terminalId);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

export function deleteScrollback(stateFile: string, terminalId: string): void {
  fs.rm(scrollbackFile(stateFile, terminalId), { force: true }, () => {});
}

/** Removes scrollback files of terminals that no longer exist. */
export function pruneScrollback(stateFile: string, keep: Set<string>): void {
  let files: string[] = [];
  try {
    files = fs.readdirSync(scrollbackDir(stateFile));
  } catch {
    return;
  }
  for (const name of files) {
    const id = name.replace(/\.ansi(\.tmp)?$/, '');
    if (!keep.has(id) || name.endsWith('.tmp')) fs.rmSync(path.join(scrollbackDir(stateFile), name), { force: true });
  }
}

/**
 * Writes to a temporary file, flushes it to disk and renames it over the
 * target, so a crash or power loss leaves either the old or the new state.
 */
export function saveState(file: string, state: AppState): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(state));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') {
    try {
      const dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch {
      // Directory fsync is best effort.
    }
  }
}

/** Like saveState, but flushes to disk without blocking the event loop: fsync can take hundreds of milliseconds on a busy disk. */
export async function saveStateAsync(file: string, state: AppState): Promise<void> {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  // Its own temporary file, so it never interleaves with a blocking save.
  const tmp = `${file}.async.tmp`;
  const handle = await fs.promises.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmp, file);
  if (process.platform !== 'win32') {
    try {
      const dirHandle = await fs.promises.open(dir, 'r');
      await dirHandle.sync();
      await dirHandle.close();
    } catch {
      // Directory fsync is best effort.
    }
  }
}
