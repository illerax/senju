// Applies UI actions to the workspace structure. Process side effects are
// reported back to the caller as lists of created terminals and removed tabs.

import crypto from 'node:crypto';
import type { Action } from '../shared/protocol';
import type { AppState, GroupState, PaneNode, TerminalState, ViewerState, WindowState, WorkspaceState } from '../shared/types';
import { findPaneNode, paneIds, paneOfTab, panes, removePane, setSplitSizes, splitPane, tabIds, updatePane } from '../shared/layout';

export interface Effects {
  /** Terminals to start. */
  created: string[];
  /** Terminals and viewers that are gone. */
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

/** Where a terminal's or a viewer's tab is. */
export function findTab(state: AppState, tabId: string): { group: GroupState; workspace: WorkspaceState; pane: PaneNode } | null {
  for (const group of state.groups) {
    for (const workspace of group.workspaces) {
      const pane = paneOfTab(workspace.root, tabId);
      if (pane) return { group, workspace, pane };
    }
  }
  return null;
}

/** Working directory for a new terminal next to the given pane: its active terminal's, or another of its terminals'. */
function cwdOf(state: AppState, pane: PaneNode | null | undefined, fallback: string): string {
  if (!pane) return fallback;
  return [pane.activeTab, ...pane.tabs].map((id) => state.terminals[id]?.cwd).find(Boolean) || fallback;
}

const isTab = (state: AppState, id: string) => !!state.terminals[id] || !!state.viewers[id];

/** Forgets terminals and viewers. */
function dropTabs(state: AppState, ids: string[], effects: Effects): void {
  for (const id of ids) {
    delete state.terminals[id];
    delete state.viewers[id];
    effects.removed.push(id);
  }
}

/** The window that shows a group; a group naming no window belongs to the first. */
export function windowOf(state: AppState, group: GroupState): WindowState {
  return state.windows.find((w) => w.id === group.windowId) ?? state.windows[0];
}

/** Keeps at least one window and gives every group one that exists. */
export function repairWindows(state: AppState): void {
  if (!state.windows.length) state.windows.push({ id: newId(), activeWorkspaceId: null, ui: {} });
  for (const group of state.groups) group.windowId = windowOf(state, group).id;
}

/**
 * Picks another active workspace in each window whose active one is gone or
 * moved away, preferring its neighbors in `previousOrder`.
 */
function repairActive(state: AppState, previousOrder: string[]): void {
  for (const window of state.windows) {
    const own = state.groups.filter((g) => g.windowId === window.id).flatMap((g) => g.workspaces.map((w) => w.id));
    if (window.activeWorkspaceId && own.includes(window.activeWorkspaceId)) continue;
    const index = previousOrder.indexOf(window.activeWorkspaceId ?? '');
    const before = previousOrder.slice(0, Math.max(0, index)).filter((id) => own.includes(id));
    const after = (index < 0 ? [] : previousOrder.slice(index + 1)).filter((id) => own.includes(id));
    window.activeWorkspaceId = after[0] ?? before.at(-1) ?? own[0] ?? null;
  }
}

/** Shows a workspace in its window. */
function activate(state: AppState, group: GroupState, workspaceId: string): void {
  windowOf(state, group).activeWorkspaceId = workspaceId;
}

/** Moves groups to the end of the sidebar of a window. */
function moveGroupsTo(state: AppState, groups: GroupState[], window: WindowState): void {
  for (const group of groups) {
    state.groups.splice(state.groups.indexOf(group), 1);
    state.groups.push(group);
    group.windowId = window.id;
  }
}

/** Removes a workspace from its group without touching its terminals. */
function detachWorkspace(group: GroupState, workspace: WorkspaceState): void {
  group.workspaces.splice(group.workspaces.indexOf(workspace), 1);
}

function removeWorkspace(state: AppState, group: GroupState, workspace: WorkspaceState, effects: Effects): void {
  detachWorkspace(group, workspace);
  dropTabs(state, tabIds(workspace.root), effects);
}

/** Takes a pane out of its workspace, closing the workspace when it was the last pane. Its terminals are kept. */
function takePane(group: GroupState, workspace: WorkspaceState, paneId: string): void {
  const order = paneIds(workspace.root);
  const root = removePane(workspace.root, paneId);
  if (!root) {
    detachWorkspace(group, workspace);
    return;
  }
  workspace.root = root;
  if (workspace.focusedPaneId === paneId) {
    const remaining = paneIds(root);
    workspace.focusedPaneId = remaining[Math.max(0, order.indexOf(paneId) - 1)] ?? remaining[0];
  }
}

/** Takes a tab out of its pane, closing the pane when it was the last tab. Its terminal or viewer is kept. */
function takeTab(state: AppState, terminalId: string): void {
  const found = findTab(state, terminalId);
  if (!found) return;
  const { group, workspace, pane } = found;
  if (pane.tabs.length === 1) {
    takePane(group, workspace, pane.id);
    return;
  }
  const index = pane.tabs.indexOf(terminalId);
  const tabs = pane.tabs.filter((id) => id !== terminalId);
  const activeTab = pane.activeTab === terminalId ? tabs[Math.min(index, tabs.length - 1)] : pane.activeTab;
  workspace.root = updatePane(workspace.root, pane.id, (p) => ({ ...p, tabs, activeTab }));
}

/** Closes a tab and forgets its terminal or viewer. */
export function closeTab(state: AppState, tabId: string, effects: Effects): void {
  const order = allWorkspaces(state).map((w) => w.id);
  takeTab(state, tabId);
  if (isTab(state, tabId)) dropTabs(state, [tabId], effects);
  repairActive(state, order);
}

/**
 * The viewer a show request means, if it is open: the one named by `id`, else
 * one of the same file, else content the same terminal sent under the same
 * name. It may be anywhere, as the user moves viewers between panes and
 * windows; the request then updates it where it is.
 */
export function shownBefore(state: AppState, terminalId: string, asked: ViewerState, id?: string): ViewerState | undefined {
  const named = id ? state.viewers[id] : undefined;
  if (named && !!named.owned === !!asked.owned) return named;
  return Object.values(state.viewers).find((v) =>
    asked.owned ? v.owned && !!asked.name && v.source === terminalId && v.name === asked.name : !v.owned && v.file === asked.file,
  );
}

/**
 * Shows a viewer for a terminal. A viewer open before (`open`, from
 * shownBefore) stays where it is and comes to the front of its pane;
 * otherwise the viewer opens as a tab of another pane that shows a viewer, or
 * in a new pane next to the terminal. The focus stays where it is, so typing
 * still goes to the terminal. Returns the id of the viewer shown, or null when
 * the terminal has no tab.
 */
export function showViewer(state: AppState, terminalId: string, viewer: ViewerState, open?: ViewerState): string | null {
  if (open) {
    refreshViewer(open, viewer);
    if (!open.owned) open.file = viewer.file;
    const found = findTab(state, open.id);
    if (found) found.workspace.root = updatePane(found.workspace.root, found.pane.id, (p) => ({ ...p, activeTab: open.id }));
    return open.id;
  }
  if (!viewer.window && !findTab(state, terminalId)) return null;
  viewer.source = terminalId;
  state.viewers[viewer.id] = viewer;
  if (!viewer.window) placeNear(state, terminalId, viewer.id);
  return viewer.id;
}

/**
 * Puts a viewer's tab next to a terminal: into another pane of its workspace
 * that shows a viewer, or into a new pane beside the terminal's.
 */
function placeNear(state: AppState, terminalId: string, viewerId: string): boolean {
  const found = findTab(state, terminalId);
  if (!found) return false;
  const { workspace } = found;
  const target = panes(workspace.root).find((p) => p.id !== found.pane.id && state.viewers[p.activeTab]);
  if (target) {
    addTab(workspace, target.id, viewerId);
  } else {
    const pane: PaneNode = { type: 'pane', id: newId(), tabs: [viewerId], activeTab: viewerId };
    workspace.root = splitPane(workspace.root, found.pane.id, pane, splitSide(state.terminals[terminalId]), newId);
  }
  return true;
}

/** Adds a tab after the active one of a pane and makes it active. */
function addTab(workspace: WorkspaceState, paneId: string, tabId: string): void {
  workspace.root = updatePane(workspace.root, paneId, (p) => {
    const tabs = [...p.tabs];
    tabs.splice(tabs.indexOf(p.activeTab) + 1, 0, tabId);
    return { ...p, tabs, activeTab: tabId };
  });
}

/** Makes a tab active in its pane, its pane focused and its workspace shown. */
function reveal(state: AppState, tabId: string): void {
  const found = findTab(state, tabId);
  if (!found) return;
  found.workspace.root = updatePane(found.workspace.root, found.pane.id, (p) => ({ ...p, activeTab: tabId }));
  focus(state, found.group, found.workspace, found.pane.id);
}

/**
 * Moves a tab, or a viewer shown in a window of its own, to the focused pane
 * of a window. A window showing no workspace gets a group for it, named
 * after the group the tab comes from.
 */
function moveTabToWindow(state: AppState, tabId: string, window: WindowState, home: string): void {
  const source = findTab(state, tabId);
  const viewer = state.viewers[tabId];
  if (source ? windowOf(state, source.group) === window : !viewer?.window) return;
  if (source) takeTab(state, tabId);
  if (viewer) {
    viewer.window = undefined;
    viewer.pane = undefined;
  }
  const shown = window.activeWorkspaceId ? findWorkspace(state, window.activeWorkspaceId) : null;
  if (shown && shown.group.windowId === window.id) {
    addTab(shown.workspace, shown.workspace.focusedPaneId, tabId);
    return;
  }
  const pane: PaneNode = { type: 'pane', id: newId(), tabs: [tabId], activeTab: tabId };
  const cwd = source?.group.cwd || state.terminals[tabId]?.cwd || home;
  const group: GroupState = {
    id: newId(),
    name: source?.group.name ?? nextName(state.groups.map((g) => g.name), 'Group'),
    cwd,
    workspaces: [{ id: newId(), name: 'Workspace 1', root: pane, focusedPaneId: pane.id }],
    collapsed: false,
    windowId: window.id,
  };
  state.groups.push(group);
  window.activeWorkspaceId = group.workspaces[0].id;
}

/**
 * Where a viewer's new pane goes: right of a terminal that is wide on the
 * screen, below one that is tall. A cell is about twice as tall as it is wide.
 */
export function splitSide(terminal: TerminalState | undefined): 'right' | 'down' {
  if (!terminal?.cols || !terminal.rows) return 'right';
  return terminal.cols / (terminal.rows * 2) >= 1 ? 'right' : 'down';
}

/** An open viewer shown again: it takes the name and format asked for this time. */
function refreshViewer(open: ViewerState, asked: ViewerState): void {
  if (asked.name) open.name = asked.name;
  if (asked.format) open.format = asked.format;
}

function focus(state: AppState, group: GroupState, workspace: WorkspaceState, paneId: string): void {
  workspace.focusedPaneId = paneId;
  activate(state, group, workspace.id);
}

export function applyAction(state: AppState, action: Action, home: string): Effects {
  state.viewers ??= {};
  repairWindows(state);
  const order = allWorkspaces(state).map((w) => w.id);
  const effects = apply(state, action, home);
  repairActive(state, order);
  return effects;
}

function apply(state: AppState, action: Action, home: string): Effects {
  const effects: Effects = { created: [], removed: [] };
  const group = (id: string) => state.groups.find((g) => g.id === id);
  const windowById = (id: string) => state.windows.find((w) => w.id === id);

  switch (action.type) {
    case 'createGroup': {
      const cwd = action.cwd || home;
      const window = windowById(action.windowId) ?? state.windows[0];
      const g: GroupState = { id: newId(), name: action.name || nextName(state.groups.map((x) => x.name), 'Group'), cwd, workspaces: [], collapsed: false, windowId: window.id };
      const w = newWorkspace(state, g, cwd, effects);
      g.workspaces.push(w);
      state.groups.push(g);
      window.activeWorkspaceId = w.id;
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
      for (const w of g.workspaces) dropTabs(state, tabIds(w.root), effects);
      state.groups.splice(state.groups.indexOf(g), 1);
      break;
    }
    case 'moveGroup': {
      const index = state.groups.findIndex((g) => g.id === action.groupId);
      if (index >= 0) moveWithin(state.groups, index, action.toIndex);
      break;
    }
    case 'moveGroupToWindow': {
      const g = group(action.groupId);
      const target = windowById(action.windowId);
      if (!g || !target || g.windowId === target.id) break;
      const shown = g.workspaces.find((w) => w.id === windowOf(state, g).activeWorkspaceId) ?? g.workspaces[0];
      moveGroupsTo(state, [g], target);
      if (shown) target.activeWorkspaceId = shown.id;
      break;
    }
    case 'createWindow': {
      if (windowById(action.windowId)) break;
      const window: WindowState = { id: action.windowId, activeWorkspaceId: null, ui: {} };
      state.windows.push(window);
      if (action.groupId) apply(state, { type: 'moveGroupToWindow', groupId: action.groupId, windowId: window.id }, home);
      else if (action.tabId) moveTabToWindow(state, action.tabId, window, home);
      break;
    }
    case 'closeWindow': {
      const window = windowById(action.windowId);
      const into = windowById(action.into) ?? state.windows.find((w) => w !== window);
      if (!window || !into || into === window) break;
      const groups = state.groups.filter((g) => g.windowId === window.id);
      moveGroupsTo(state, groups, into);
      state.windows.splice(state.windows.indexOf(window), 1);
      if (!into.activeWorkspaceId && groups[0]?.workspaces[0]) into.activeWorkspaceId = groups[0].workspaces[0].id;
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
      const current = g.workspaces.find((w) => w.id === windowOf(state, g).activeWorkspaceId);
      const w = newWorkspace(state, g, g.cwd || home, effects);
      g.workspaces.splice(current ? g.workspaces.indexOf(current) + 1 : g.workspaces.length, 0, w);
      g.collapsed = false;
      activate(state, g, w.id);
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
      const found = findWorkspace(state, action.workspaceId);
      if (found) activate(state, found.group, action.workspaceId);
      break;
    }
    case 'splitPane': {
      const found = findPane(state, action.paneId);
      if (!found) break;
      const pane = newPane(state, cwdOf(state, found.pane, found.group.cwd || home), effects);
      found.workspace.root = splitPane(found.workspace.root, action.paneId, pane, action.side, newId);
      focus(state, found.group, found.workspace, pane.id);
      break;
    }
    case 'closePane': {
      const found = findPane(state, action.paneId);
      if (!found) break;
      takePane(found.group, found.workspace, found.pane.id);
      dropTabs(state, found.pane.tabs.filter((id) => isTab(state, id)), effects);
      break;
    }
    case 'focusPane': {
      const found = findPane(state, action.paneId);
      if (found) focus(state, found.group, found.workspace, action.paneId);
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
      focus(state, found.group, found.workspace, action.paneId);
      break;
    }
    case 'closeTab': {
      closeTab(state, action.terminalId, effects);
      break;
    }
    case 'activateTab': {
      const found = findTab(state, action.terminalId);
      if (!found) break;
      found.workspace.root = updatePane(found.workspace.root, found.pane.id, (p) => ({ ...p, activeTab: action.terminalId }));
      focus(state, found.group, found.workspace, found.pane.id);
      break;
    }
    case 'renameTab': {
      const tab = state.terminals[action.terminalId] ?? state.viewers[action.terminalId];
      if (tab) tab.name = action.name.trim() || undefined;
      break;
    }
    case 'zoomTab': {
      const tab = state.terminals[action.terminalId] ?? state.viewers[action.terminalId];
      if (tab) tab.zoom = Number.isFinite(action.zoom) && Math.round(action.zoom) ? Math.round(action.zoom) : undefined;
      break;
    }
    case 'openViewer': {
      const found = findPane(state, action.paneId);
      if (!found || !action.file) break;
      const id = newId();
      state.viewers[id] = { id, file: action.file };
      addTab(found.workspace, action.paneId, id);
      focus(state, found.group, found.workspace, action.paneId);
      break;
    }
    case 'popOutViewer': {
      const viewer = state.viewers[action.viewerId];
      if (!viewer || viewer.window) break;
      viewer.pane = findTab(state, viewer.id)?.pane.id;
      takeTab(state, viewer.id);
      viewer.window = true;
      break;
    }
    case 'dockViewer': {
      const viewer = state.viewers[action.viewerId];
      if (!viewer?.window) break;
      const from = viewer.pane ? findPane(state, viewer.pane) : null;
      if (from) addTab(from.workspace, from.pane.id, viewer.id);
      else if (!viewer.source || !placeNear(state, viewer.source, viewer.id)) {
        // Neither is left: the first window showing a workspace takes it.
        const window = state.windows.find((w) => w.activeWorkspaceId && findWorkspace(state, w.activeWorkspaceId));
        if (!window) break;
        moveTabToWindow(state, viewer.id, window, home);
      }
      viewer.window = undefined;
      viewer.pane = undefined;
      reveal(state, viewer.id);
      break;
    }
    case 'moveTabToWindow': {
      const window = windowById(action.windowId);
      if (window && isTab(state, action.terminalId)) moveTabToWindow(state, action.terminalId, window, home);
      break;
    }
    case 'closeViewer': {
      if (state.viewers[action.viewerId]?.window) dropTabs(state, [action.viewerId], effects);
      break;
    }
    case 'moveTab': {
      const source = findTab(state, action.terminalId);
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
      focus(state, again.group, again.workspace, action.paneId);
      break;
    }
    case 'setUi': {
      const window = windowById(action.windowId);
      if (window) window.ui = { ...window.ui, ...action.ui };
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
