// Applies UI actions to the workspace structure. Process side effects are
// reported back to the caller as lists of created and removed terminals.

import crypto from 'node:crypto';
import type { Action } from '../shared/protocol';
import type { AppState, GroupState, PaneNode, TerminalState, WorkspaceState } from '../shared/types';
import { findPaneNode, paneIds, paneOfTerminal, panes, removePane, setSplitSizes, splitPane, terminalIds, updatePane } from '../shared/layout';

export interface Effects {
  created: string[];
  removed: string[];
}

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

function newTerminal(state: AppState, cwd: string, effects: Effects): TerminalState {
  const terminal: TerminalState = { id: newId(), cwd, cols: 80, rows: 24, env: {} };
  state.terminals[terminal.id] = terminal;
  effects.created.push(terminal.id);
  return terminal;
}

function newPane(state: AppState, cwd: string, effects: Effects): PaneNode {
  const terminal = newTerminal(state, cwd, effects);
  return { type: 'pane', id: newId(), tabs: [terminal.id], activeTab: terminal.id };
}

/** `${prefix} N` with the lowest N not taken yet. */
function nextName(taken: string[], prefix: string): string {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

function newWorkspace(state: AppState, group: GroupState, cwd: string, effects: Effects): WorkspaceState {
  const pane = newPane(state, cwd, effects);
  return { id: newId(), name: nextName(group.workspaces.map((w) => w.name), 'Workspace'), root: pane, focusedPaneId: pane.id };
}

/** Moves an item so it lands before the item now at `toIndex` (or last, past the end). */
function moveWithin<T>(list: T[], from: number, toIndex: number): void {
  const [item] = list.splice(from, 1);
  const to = from < toIndex ? toIndex - 1 : toIndex;
  list.splice(Math.max(0, Math.min(to, list.length)), 0, item);
}

function allWorkspaces(state: AppState): WorkspaceState[] {
  return state.groups.flatMap((g) => g.workspaces);
}

export function findWorkspace(state: AppState, workspaceId: string): { group: GroupState; workspace: WorkspaceState } | null {
  for (const group of state.groups) {
    const workspace = group.workspaces.find((w) => w.id === workspaceId);
    if (workspace) return { group, workspace };
  }
  return null;
}

export function findPane(state: AppState, paneId: string): { group: GroupState; workspace: WorkspaceState; pane: PaneNode } | null {
  for (const group of state.groups) {
    for (const workspace of group.workspaces) {
      const pane = findPaneNode(workspace.root, paneId);
      if (pane) return { group, workspace, pane };
    }
  }
  return null;
}

export function findTerminal(state: AppState, terminalId: string): { group: GroupState; workspace: WorkspaceState; pane: PaneNode } | null {
  for (const group of state.groups) {
    for (const workspace of group.workspaces) {
      const pane = paneOfTerminal(workspace.root, terminalId);
      if (pane) return { group, workspace, pane };
    }
  }
  return null;
}

/** Working directory for a new terminal next to the given pane. */
function cwdOf(state: AppState, pane: PaneNode | null | undefined, fallback: string): string {
  return (pane && state.terminals[pane.activeTab]?.cwd) || fallback;
}

function dropTerminals(state: AppState, ids: string[], effects: Effects): void {
  for (const id of ids) {
    delete state.terminals[id];
    effects.removed.push(id);
  }
}

/** Picks another active workspace when the active one is gone, preferring its neighbors. */
function repairActive(state: AppState, previousOrder: string[]): void {
  const all = allWorkspaces(state);
  if (all.some((w) => w.id === state.activeWorkspaceId)) return;
  const index = previousOrder.indexOf(state.activeWorkspaceId ?? '');
  const survivors = previousOrder.filter((id) => all.some((w) => w.id === id));
  const before = previousOrder.slice(0, Math.max(0, index)).filter((id) => survivors.includes(id));
  const after = previousOrder.slice(index + 1).filter((id) => survivors.includes(id));
  state.activeWorkspaceId = after[0] ?? before.at(-1) ?? null;
}

/** Removes a workspace from its group without touching its terminals. */
function detachWorkspace(state: AppState, group: GroupState, workspace: WorkspaceState): void {
  const order = allWorkspaces(state).map((w) => w.id);
  group.workspaces.splice(group.workspaces.indexOf(workspace), 1);
  repairActive(state, order);
}

function removeWorkspace(state: AppState, group: GroupState, workspace: WorkspaceState, effects: Effects): void {
  detachWorkspace(state, group, workspace);
  dropTerminals(state, terminalIds(workspace.root), effects);
}

/** Takes a pane out of its workspace, closing the workspace when it was the last pane. Its terminals are kept. */
function takePane(state: AppState, group: GroupState, workspace: WorkspaceState, paneId: string): void {
  const order = paneIds(workspace.root);
  const root = removePane(workspace.root, paneId);
  if (!root) {
    detachWorkspace(state, group, workspace);
    return;
  }
  workspace.root = root;
  if (workspace.focusedPaneId === paneId) {
    const remaining = paneIds(root);
    workspace.focusedPaneId = remaining[Math.max(0, order.indexOf(paneId) - 1)] ?? remaining[0];
  }
}

/** Takes a tab out of its pane, closing the pane when it was the last tab. The terminal is kept. */
function takeTab(state: AppState, terminalId: string): void {
  const found = findTerminal(state, terminalId);
  if (!found) return;
  const { group, workspace, pane } = found;
  if (pane.tabs.length === 1) {
    takePane(state, group, workspace, pane.id);
    return;
  }
  const index = pane.tabs.indexOf(terminalId);
  const tabs = pane.tabs.filter((id) => id !== terminalId);
  const activeTab = pane.activeTab === terminalId ? tabs[Math.min(index, tabs.length - 1)] : pane.activeTab;
  workspace.root = updatePane(workspace.root, pane.id, (p) => ({ ...p, tabs, activeTab }));
}

/** Closes a terminal's tab and forgets the terminal. */
export function closeTerminal(state: AppState, terminalId: string, effects: Effects): void {
  takeTab(state, terminalId);
  if (state.terminals[terminalId]) dropTerminals(state, [terminalId], effects);
}

function focus(state: AppState, workspace: WorkspaceState, paneId: string): void {
  workspace.focusedPaneId = paneId;
  state.activeWorkspaceId = workspace.id;
}

export function applyAction(state: AppState, action: Action, home: string): Effects {
  const effects: Effects = { created: [], removed: [] };
  const group = (id: string) => state.groups.find((g) => g.id === id);

  switch (action.type) {
    case 'createGroup': {
      const cwd = action.cwd || home;
      const g: GroupState = { id: newId(), name: action.name || nextName(state.groups.map((x) => x.name), 'Group'), cwd, workspaces: [], collapsed: false };
      const w = newWorkspace(state, g, cwd, effects);
      g.workspaces.push(w);
      state.groups.push(g);
      state.activeWorkspaceId = w.id;
      break;
    }
    case 'renameGroup': {
      const g = group(action.groupId);
      if (g && action.name.trim()) g.name = action.name.trim();
      break;
    }
    case 'setGroupCwd': {
      const g = group(action.groupId);
      if (g && action.cwd) g.cwd = action.cwd;
      break;
    }
    case 'deleteGroup': {
      const g = group(action.groupId);
      if (!g) break;
      const order = allWorkspaces(state).map((w) => w.id);
      for (const w of g.workspaces) dropTerminals(state, terminalIds(w.root), effects);
      state.groups.splice(state.groups.indexOf(g), 1);
      repairActive(state, order);
      break;
    }
    case 'moveGroup': {
      const index = state.groups.findIndex((g) => g.id === action.groupId);
      if (index >= 0) moveWithin(state.groups, index, action.toIndex);
      break;
    }
    case 'setGroupCollapsed': {
      const g = group(action.groupId);
      if (g) g.collapsed = action.collapsed;
      break;
    }
    case 'createWorkspace': {
      const g = group(action.groupId);
      if (!g) break;
      const current = g.workspaces.find((w) => w.id === state.activeWorkspaceId);
      const w = newWorkspace(state, g, g.cwd || home, effects);
      g.workspaces.splice(current ? g.workspaces.indexOf(current) + 1 : g.workspaces.length, 0, w);
      g.collapsed = false;
      state.activeWorkspaceId = w.id;
      break;
    }
    case 'renameWorkspace': {
      const found = findWorkspace(state, action.workspaceId);
      if (found && action.name.trim()) found.workspace.name = action.name.trim();
      break;
    }
    case 'setWorkspaceColor': {
      const found = findWorkspace(state, action.workspaceId);
      if (found) found.workspace.color = action.color && /^#[0-9a-f]{6}$/i.test(action.color) ? action.color : undefined;
      break;
    }
    case 'closeWorkspace': {
      const found = findWorkspace(state, action.workspaceId);
      if (found) removeWorkspace(state, found.group, found.workspace, effects);
      break;
    }
    case 'moveWorkspace': {
      const found = findWorkspace(state, action.workspaceId);
      const target = group(action.groupId);
      if (!found || !target) break;
      const from = found.group.workspaces.indexOf(found.workspace);
      if (found.group === target) {
        moveWithin(target.workspaces, from, action.toIndex);
      } else {
        found.group.workspaces.splice(from, 1);
        target.workspaces.splice(Math.max(0, Math.min(action.toIndex, target.workspaces.length)), 0, found.workspace);
        target.collapsed = false;
      }
      break;
    }
    case 'activateWorkspace': {
      if (findWorkspace(state, action.workspaceId)) state.activeWorkspaceId = action.workspaceId;
      break;
    }
    case 'splitPane': {
      const found = findPane(state, action.paneId);
      if (!found) break;
      const pane = newPane(state, cwdOf(state, found.pane, found.group.cwd || home), effects);
      found.workspace.root = splitPane(found.workspace.root, action.paneId, pane, action.side, newId);
      focus(state, found.workspace, pane.id);
      break;
    }
    case 'closePane': {
      const found = findPane(state, action.paneId);
      if (!found) break;
      takePane(state, found.group, found.workspace, found.pane.id);
      dropTerminals(state, found.pane.tabs.filter((id) => state.terminals[id]), effects);
      break;
    }
    case 'focusPane': {
      const found = findPane(state, action.paneId);
      if (found) focus(state, found.workspace, action.paneId);
      break;
    }
    case 'resizeSplit': {
      for (const w of allWorkspaces(state)) w.root = setSplitSizes(w.root, action.splitId, action.sizes);
      break;
    }
    case 'createTab': {
      const found = findPane(state, action.paneId);
      if (!found) break;
      const terminal = newTerminal(state, cwdOf(state, found.pane, found.group.cwd || home), effects);
      found.workspace.root = updatePane(found.workspace.root, action.paneId, (p) => {
        const tabs = [...p.tabs];
        tabs.splice(tabs.indexOf(p.activeTab) + 1, 0, terminal.id);
        return { ...p, tabs, activeTab: terminal.id };
      });
      focus(state, found.workspace, action.paneId);
      break;
    }
    case 'closeTab': {
      closeTerminal(state, action.terminalId, effects);
      break;
    }
    case 'activateTab': {
      const found = findTerminal(state, action.terminalId);
      if (!found) break;
      found.workspace.root = updatePane(found.workspace.root, found.pane.id, (p) => ({ ...p, activeTab: action.terminalId }));
      focus(state, found.workspace, found.pane.id);
      break;
    }
    case 'renameTab': {
      const terminal = state.terminals[action.terminalId];
      if (terminal) terminal.name = action.name.trim() || undefined;
      break;
    }
    case 'zoomTab': {
      const terminal = state.terminals[action.terminalId];
      if (terminal) terminal.zoom = Number.isFinite(action.zoom) && Math.round(action.zoom) ? Math.round(action.zoom) : undefined;
      break;
    }
    case 'moveTab': {
      const source = findTerminal(state, action.terminalId);
      const target = findPane(state, action.paneId);
      if (!source || !target) break;
      if (source.pane.id === target.pane.id) {
        const tabs = [...source.pane.tabs];
        moveWithin(tabs, tabs.indexOf(action.terminalId), action.toIndex);
        source.workspace.root = updatePane(source.workspace.root, source.pane.id, (p) => ({ ...p, tabs, activeTab: action.terminalId }));
        break;
      }
      takeTab(state, action.terminalId);
      // Taking the last tab may have closed the source pane or workspace; find the target again.
      const again = findPane(state, action.paneId);
      if (!again) break;
      again.workspace.root = updatePane(again.workspace.root, action.paneId, (p) => {
        const tabs = [...p.tabs];
        tabs.splice(Math.max(0, Math.min(action.toIndex, tabs.length)), 0, action.terminalId);
        return { ...p, tabs, activeTab: action.terminalId };
      });
      focus(state, again.workspace, action.paneId);
      break;
    }
    case 'setUi': {
      state.ui = { ...state.ui, ...action.ui };
      break;
    }
    case 'runPending':
    case 'dismissPending':
      // Handled by the daemon, which owns the processes.
      break;
  }
  return effects;
}

/** Every pane in every workspace, for repairs after loading. */
export function allPanes(state: AppState): PaneNode[] {
  return allWorkspaces(state).flatMap((w) => panes(w.root));
}
