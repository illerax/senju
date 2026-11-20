// Groups saved to disk: closed to free their processes, or exported to a file,
// and opened again later as they were, with agents resuming their sessions.

import fs from 'node:fs';
import path from 'node:path';
import type { AppState, ClosedGroupInfo, GroupState, LayoutNode, SavedGroup, TerminalState } from '../shared/types';
import { terminalIds } from '../shared/layout';
import { newId } from './workspace';

/** Everything about a group needed to open it again; `scrollback` by terminal id. */
export function snapshotGroup(state: AppState, groupId: string, scrollback: Record<string, string>, now: number): SavedGroup | null {
  const index = state.groups.findIndex((g) => g.id === groupId);
  const group = state.groups[index];
  if (!group) return null;
  const terminals: Record<string, TerminalState> = {};
  for (const workspace of group.workspaces) {
    for (const id of terminalIds(workspace.root)) {
      const terminal = state.terminals[id];
      // The agent's state describes the running process, which a restore replaces.
      if (terminal) terminals[id] = { ...structuredClone(terminal), agent: undefined, busy: undefined };
    }
  }
  const active = group.workspaces.some((w) => w.id === state.activeWorkspaceId) ? state.activeWorkspaceId : null;
  return {
    format: 'senju-group',
    version: 1,
    savedAt: now,
    index,
    activeWorkspaceId: active,
    group: structuredClone(group),
    terminals,
    scrollback: Object.fromEntries(Object.keys(terminals).flatMap((id) => (scrollback[id] ? [[id, scrollback[id]]] : []))),
  };
}

export interface RestoredGroup {
  group: GroupState;
  terminals: Record<string, TerminalState>;
  scrollback: Record<string, string>;
  activeWorkspaceId: string | null;
}

/** A saved group with fresh ids, so a copy can open next to the original. */
export function restoreGroup(saved: SavedGroup): RestoredGroup {
  const ids = new Map<string, string>();
  const fresh = (old: string) => {
    let id = ids.get(old);
    if (!id) ids.set(old, (id = newId()));
    return id;
  };
  const relink = (node: LayoutNode): LayoutNode =>
    node.type === 'pane'
      ? { ...node, id: fresh(node.id), tabs: node.tabs.map(fresh), activeTab: fresh(node.activeTab) }
      : { ...node, id: fresh(node.id), children: node.children.map(relink) };
  const group: GroupState = {
    ...saved.group,
    id: newId(),
    workspaces: saved.group.workspaces.map((w) => ({ ...w, id: fresh(w.id), root: relink(w.root), focusedPaneId: fresh(w.focusedPaneId) })),
  };
  const terminals: Record<string, TerminalState> = {};
  const scrollback: Record<string, string> = {};
  for (const workspace of saved.group.workspaces) {
    for (const old of terminalIds(workspace.root)) {
      const id = fresh(old);
      terminals[id] = { ...(saved.terminals[old] ?? { cwd: group.cwd, cols: 80, rows: 24, env: {} }), id };
      if (saved.scrollback[old]) scrollback[id] = saved.scrollback[old];
    }
  }
  const active = saved.activeWorkspaceId ? ids.get(saved.activeWorkspaceId) : undefined;
  return { group, terminals, scrollback, activeWorkspaceId: active ?? group.workspaces[0]?.id ?? null };
}

/** Puts a restored group at its old place among the groups and shows it. */
export function insertRestored(state: AppState, restored: RestoredGroup, index: number): void {
  state.groups.splice(Math.max(0, Math.min(index, state.groups.length)), 0, restored.group);
  Object.assign(state.terminals, restored.terminals);
  if (restored.activeWorkspaceId) state.activeWorkspaceId = restored.activeWorkspaceId;
}

/** Reads a saved group, checking its shape; throws with a readable message otherwise. */
export async function readSavedGroup(file: string): Promise<SavedGroup> {
  let parsed: SavedGroup;
  try {
    parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as SavedGroup;
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
  }
  if (parsed?.format !== 'senju-group' || parsed.version !== 1 || !Array.isArray(parsed.group?.workspaces) || typeof parsed.terminals !== 'object') {
    throw new Error(`${file} is not a group saved by Senju`);
  }
  parsed.scrollback ??= {};
  return parsed;
}

/** Writes a saved group atomically; it may be large, as it holds the scrollback. */
export async function writeSavedGroup(file: string, saved: SavedGroup): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(saved), { mode: 0o600 });
  await fs.promises.rename(tmp, file);
}

export function describeSaved(id: string, saved: SavedGroup): ClosedGroupInfo {
  return {
    id,
    name: saved.group.name,
    cwd: saved.group.cwd,
    workspaces: saved.group.workspaces.length,
    terminals: Object.keys(saved.terminals).length,
    closedAt: saved.savedAt,
  };
}

/** The groups closed into a directory, newest first; files that cannot be read are skipped. */
export async function listClosed(dir: string): Promise<ClosedGroupInfo[]> {
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const list = await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (name) => {
        try {
          return describeSaved(name.slice(0, -'.json'.length), await readSavedGroup(path.join(dir, name)));
        } catch {
          return null;
        }
      }),
  );
  return list.filter((g): g is ClosedGroupInfo => g !== null).sort((a, b) => b.closedAt - a.closedAt);
}
