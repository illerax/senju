// The renderer: a sidebar of groups with their workspaces, and the active
// workspace split into panes, each with its own tabs of terminals. All
// changes go to the daemon as actions; the UI re-renders from the state the
// daemon sends back.

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import type { Action, DaemonMessage, SplitSide } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import type { UpdateStatus } from '../shared/update';
import { clampZoom, isLight, resolveTheme, zoomPercent } from '../shared/themes';
import { windowView, type AppState, type GroupState, type LayoutNode, type PaneNode, type SplitNode, type TerminalState, type WindowView, type WorkspaceState } from '../shared/types';
import { findPaneNode, panes, terminalIds } from '../shared/layout';
import { agentStatus, Attention, formatWait, nextInQueue, type AgentKind, type AgentStatus, type Wait } from '../shared/agent-status';
import { senju } from './api';
import { confirmDialog } from './dialog';
import { iconButton, iconSvg, logoSvg } from './icons';
import { Keymap, type Command } from './keymap';
import { showMenu, type MenuItem } from './menu';
import { SettingsView } from './settings-view';
import { TerminalView } from './terminal-view';
import { Overview, OVERVIEW_LINES, type OverviewCard } from './overview';
import { contextLevel, UsageView } from './usage-view';
import { contextPercent, formatTokens, profileText } from '../shared/usage';
import { measureSwitch, nameTerminals, note, report, startPerfMonitor, terminalName } from './perf-monitor';

const SLOW_RENDER_MS = 100;

type UiMessage = DaemonMessage | { type: 'connected'; outdated: boolean };

/** This window's share of the state; `shared` is the state of all windows. */
let state: WindowView;
let shared: AppState;
const windowId = new URLSearchParams(location.search).get('window') ?? '';
let settings: Settings;
let platform: string;
let home: string;
let keymap: Keymap;
const terminals = new Map<string, TerminalView>();
const paneViews = new Map<string, PaneView>();
/** Split containers of the rendered layout, for applying sizes without rebuilding. */
const splitElements = new Map<string, { node: SplitNode; children: HTMLElement[] }>();
let layoutSignature = '';
let editing = false;
let dragging = false;

/** The workspace last shown in each group, for switching between groups. */
const lastWorkspace = new Map<string, string>();
let settingsView: SettingsView;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

/** Tooltips that name a shortcut; refreshed when shortcuts change. */
const tips = new Map<HTMLElement, { label: string; command: Command }>();

function tip(element: HTMLElement, label: string, command: Command): void {
  tips.set(element, { label, command });
  const key = keymap.accelerator(command);
  element.title = key ? `${label} (${key})` : label;
}

function refreshTips(): void {
  for (const [element, { label, command }] of tips) tip(element, label, command);
}

function act(action: Action): void {
  trackSwitch(action);
  senju.send({ type: 'action', action });
}

/** A switch sent to the daemon, timed until the window shows it (perf-monitor.ts). */
let pendingSwitch: { what: string; at: number; shown: () => boolean } | null = null;

function trackSwitch(action: Action): void {
  const at = performance.now();
  if (action.type === 'activateWorkspace') {
    const name = state.groups.flatMap((g) => g.workspaces).find((w) => w.id === action.workspaceId)?.name;
    pendingSwitch = { what: `switch to workspace ${name}`, at, shown: () => state.activeWorkspaceId === action.workspaceId };
  } else if (action.type === 'activateTab') {
    pendingSwitch = { what: `switch to tab ${terminalName(action.terminalId)}`, at, shown: () => focusedPane()?.activeTab === action.terminalId };
  } else if (action.type === 'focusPane') {
    pendingSwitch = { what: 'switch pane', at, shown: () => activeContext()?.workspace.focusedPaneId === action.paneId };
  }
}

// --- state helpers ---

function activeContext(): { group: GroupState; workspace: WorkspaceState } | null {
  for (const group of state.groups) {
    const workspace = group.workspaces.find((w) => w.id === state.activeWorkspaceId);
    if (workspace) return { group, workspace };
  }
  return null;
}

function focusedPane(): PaneNode | null {
  const workspace = activeContext()?.workspace;
  return workspace ? findPaneNode(workspace.root, workspace.focusedPaneId) : null;
}

function focusedTerminal(): TerminalView | undefined {
  const pane = focusedPane();
  return pane ? terminals.get(pane.activeTab) : undefined;
}

function shortPath(p: string): string {
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

/** The end of a long path, which is the part that tells folders apart. */
function tailPath(p: string, max: number): string {
  return p.length <= max ? p : `…${p.slice(p.length - max + 1)}`;
}

const interpreters = /^(node|nodejs|bun|deno|python[\d.]*|ruby|perl)$/;

function programName(argv: string[]): string {
  const base = (a: string) => a.split('/').pop() ?? a;
  if (interpreters.test(base(argv[0] ?? ''))) {
    const script = argv.slice(1).find((a) => !a.startsWith('-'));
    if (script) return base(script).replace(/(-cli)?\.(c|m)?js$/, '');
  }
  return base(argv[0] ?? '');
}

function tabLabel(terminal: TerminalState | undefined): string {
  if (!terminal) return '';
  if (terminal.name) return terminal.name;
  if (terminal.job?.argv.length) return programName(terminal.job.argv);
  return terminal.cwd.split(/[\\/]/).filter(Boolean).pop() ?? terminal.cwd;
}

function jobLabel(terminal: TerminalState | undefined): string | null {
  const argv = terminal?.job?.argv;
  return argv?.length ? [programName(argv), ...argv.slice(1)].join(' ') : null;
}

function runningJobs(ids: string[]): string[] {
  return ids.map((id) => jobLabel(state.terminals[id])).filter((l): l is string => l !== null);
}

function workspaceAgents(workspace: WorkspaceState): Record<AgentKind, number> {
  const counts = { working: 0, waiting: 0, done: 0, background: 0 };
  for (const id of terminalIds(workspace.root)) {
    const status = agentStatus(state.terminals[id]);
    if (status) counts[status.kind]++;
  }
  return counts;
}

const contextMenu = (items: MenuItem[], e: MouseEvent) => showMenu(items, { x: e.clientX, y: e.clientY });
const confirmClose = (title: string, detail: string) => confirmDialog({ title, detail, confirmLabel: 'Close' });

// --- inline rename ---

function startRename(element: HTMLElement, current: string, commit: (name: string) => void): void {
  editing = true;
  const input = el('input', 'rename');
  input.value = current;
  element.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    editing = false;
    const value = input.value.trim();
    element.textContent = save && value ? value : current;
    if (save && value !== current) commit(value);
    render(true);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
}

// --- drag and drop ---

const dragTypes = { group: 'application/x-senju-group', workspace: 'application/x-senju-workspace', tab: 'application/x-senju-tab' };
type DragKind = keyof typeof dragTypes;

function draggable(item: HTMLElement, kind: DragKind, id: string): void {
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    e.dataTransfer?.setData(dragTypes[kind], id);
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => item.classList.remove('dragging'));
}

/** Makes `target` accept drops of the given kinds; `onDrop` receives the kind and the dragged id. */
function dropZone(target: HTMLElement, kinds: DragKind[], onDrop: (kind: DragKind, id: string) => void): void {
  const accepted = (e: DragEvent) => kinds.find((k) => e.dataTransfer?.types.includes(dragTypes[k]));
  target.addEventListener('dragover', (e) => {
    if (!accepted(e)) return;
    e.preventDefault();
    e.stopPropagation();
    target.classList.add('drop-target');
  });
  target.addEventListener('dragleave', () => target.classList.remove('drop-target'));
  target.addEventListener('drop', (e) => {
    target.classList.remove('drop-target');
    const kind = accepted(e);
    const id = kind && e.dataTransfer?.getData(dragTypes[kind]);
    if (!kind || !id) return;
    e.preventDefault();
    e.stopPropagation();
    onDrop(kind, id);
  });
}

// --- sidebar ---
// Elements are kept per id and updated in place, so a double click survives
// the re-render that its first click causes.

interface GroupElements {
  item: HTMLElement;
  chevron: HTMLElement;
  name: HTMLElement;
  path: HTMLElement;
  header: HTMLElement;
  list: HTMLElement;
}

const groupElements = new Map<string, GroupElements>();
const workspaceElements = new Map<string, { item: HTMLElement; name: HTMLElement; meta: HTMLElement }>();

const groupById = (id: string) => state.groups.find((g) => g.id === id);

const workspaceColors = [
  { name: 'Red', hex: '#e06c75' },
  { name: 'Orange', hex: '#e8955c' },
  { name: 'Yellow', hex: '#e5c07b' },
  { name: 'Green', hex: '#98c379' },
  { name: 'Teal', hex: '#56b6c2' },
  { name: 'Blue', hex: '#61afef' },
  { name: 'Purple', hex: '#c678dd' },
  { name: 'Pink', hex: '#f17fb4' },
  { name: 'Gray', hex: '#8b95a7' },
];

/** Puts `children` into `container` in order, moving only what is out of place. */
function placeChildren(container: HTMLElement, children: HTMLElement[]): void {
  children.forEach((child, i) => {
    if (container.children[i] !== child) container.insertBefore(child, container.children[i] ?? null);
  });
  while (container.children.length > children.length) container.lastElementChild!.remove();
}

function groupElementsFor(groupId: string): GroupElements {
  let g = groupElements.get(groupId);
  if (g) return g;
  const item = el('div', 'group');
  const header = el('div', 'group-header');
  const chevron = el('span', 'chevron');
  chevron.innerHTML = iconSvg('chevronDown', 14);
  const name = el('span', 'group-name');
  const path = el('span', 'group-path');
  const add = iconButton('plus', 'New workspace', 'group-add');
  tip(add, 'New workspace', 'newWorkspace');
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    act({ type: 'createWorkspace', groupId });
  });
  header.append(chevron, name, path, add);
  const list = el('ul', 'workspaces');
  item.append(header, list);

  const rename = () => {
    const group = groupById(groupId);
    if (group) startRename(name, group.name, (n) => n && act({ type: 'renameGroup', groupId, name: n }));
  };
  header.addEventListener('click', (e) => {
    const group = groupById(groupId);
    if (group && e.detail === 1) act({ type: 'setGroupCollapsed', groupId, collapsed: !group.collapsed });
  });
  header.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    // The first click of the double click toggled the group; undo that.
    const group = groupById(groupId);
    if (group) act({ type: 'setGroupCollapsed', groupId, collapsed: !group.collapsed });
    rename();
  });
  header.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const choice = await contextMenu([
      { id: 'workspace', label: 'New Workspace', accelerator: keymap.accelerator('newWorkspace') },
      { id: 'rename', label: 'Rename Group' },
      { id: 'cwd', label: 'Change Default Path…' },
      { id: '-', label: '' },
      { id: 'window', label: 'Move to Window', submenu: windowChoices() },
      { id: 'close', label: 'Close Group' },
      { id: 'export', label: 'Save Group As…' },
      { id: 'delete', label: 'Delete Group' },
    ], e);
    const group = groupById(groupId);
    if (!group) return;
    if (choice === 'workspace') act({ type: 'createWorkspace', groupId });
    if (choice === 'rename') rename();
    if (choice === 'cwd') void changeGroupCwd(group);
    if (choice === 'window:new') senju.newWindow(groupId);
    else if (choice?.startsWith('window:')) act({ type: 'moveGroupToWindow', groupId, windowId: choice.slice('window:'.length) });
    if (choice === 'delete') void deleteGroup(group);
    if (choice === 'close') void closeGroup(group);
    if (choice === 'export') void exportGroup(group);
  });
  draggable(header, 'group', groupId);
  dropZone(header, ['group', 'workspace'], (kind, id) => {
    const group = groupById(groupId);
    if (!group) return;
    if (kind === 'group') act({ type: 'moveGroup', groupId: id, toIndex: shared.groups.indexOf(group) });
    else act({ type: 'moveWorkspace', workspaceId: id, groupId, toIndex: group.workspaces.length });
  });
  g = { item, chevron, name, path, header, list };
  groupElements.set(groupId, g);
  return g;
}

function workspaceElementsFor(workspaceId: string) {
  let w = workspaceElements.get(workspaceId);
  if (w) return w;
  const item = el('li', 'workspace');
  const swatch = el('span', 'workspace-swatch');
  const name = el('span', 'workspace-name');
  const meta = el('span', 'workspace-meta');
  item.append(swatch, name, meta);
  const current = () => {
    for (const group of state.groups) {
      const index = group.workspaces.findIndex((x) => x.id === workspaceId);
      if (index >= 0) return { group, workspace: group.workspaces[index], index };
    }
    return null;
  };
  const rename = () => {
    const found = current();
    if (found) startRename(name, found.workspace.name, (n) => n && act({ type: 'renameWorkspace', workspaceId, name: n }));
  };
  item.addEventListener('click', () => act({ type: 'activateWorkspace', workspaceId }));
  item.addEventListener('dblclick', rename);
  item.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const color = current()?.workspace.color;
    const choice = await contextMenu([
      { id: 'rename', label: 'Rename Workspace' },
      {
        id: 'color',
        label: 'Color',
        submenu: [
          { id: 'color:', label: 'None', checked: !color },
          { id: '-', label: '' },
          ...workspaceColors.map((c) => ({ id: `color:${c.hex}`, label: c.name, color: c.hex, checked: color === c.hex })),
        ],
      },
      { id: '-', label: '' },
      { id: 'close', label: 'Close Workspace', accelerator: keymap.accelerator('closeWorkspace') },
    ], e);
    const found = current();
    if (choice === 'rename') rename();
    if (choice?.startsWith('color:')) act({ type: 'setWorkspaceColor', workspaceId, color: choice.slice('color:'.length) || null });
    if (choice === 'close' && found) void closeWorkspace(found.workspace);
  });
  draggable(item, 'workspace', workspaceId);
  dropZone(item, ['workspace'], (_kind, id) => {
    const found = current();
    if (found) act({ type: 'moveWorkspace', workspaceId: id, groupId: found.group.id, toIndex: found.index });
  });
  w = { item, name, meta };
  workspaceElements.set(workspaceId, w);
  return w;
}

function renderSidebar(): void {
  const groupItems = state.groups.map((group) => {
    const g = groupElementsFor(group.id);
    g.header.title = `New workspaces start in ${group.cwd}`;
    g.chevron.classList.toggle('collapsed', group.collapsed);
    if (!g.name.querySelector('input')) g.name.textContent = group.name;
    g.path.textContent = tailPath(shortPath(group.cwd), 24);
    g.path.title = group.cwd;
    g.list.hidden = group.collapsed;
    g.item.classList.toggle('has-active', group.workspaces.some((w) => w.id === state.activeWorkspaceId));
    placeChildren(
      g.list,
      group.workspaces.map((workspace) => {
        const w = workspaceElementsFor(workspace.id);
        const ids = terminalIds(workspace.root);
        const agents = workspaceAgents(workspace);
        w.item.classList.toggle('active', workspace.id === state.activeWorkspaceId);
        w.item.classList.toggle('colored', !!workspace.color);
        if (workspace.color) w.item.style.setProperty('--ws-color', workspace.color);
        else w.item.style.removeProperty('--ws-color');
        if (!w.name.querySelector('input')) w.name.textContent = workspace.name;
        // Working agents first: they are what the sidebar is glanced at for.
        const status = agents.working ? 'working' : agents.waiting ? 'waiting' : agents.done ? 'done' : agents.background ? 'background' : '';
        w.meta.className = `workspace-meta ${status}`.trim();
        w.meta.textContent = status === 'working' ? `${agents.working} working` : status || (ids.length > 1 ? String(ids.length) : '');
        w.item.title = [
          `${ids.length} terminal${ids.length === 1 ? '' : 's'}`,
          agents.working && `${agents.working} agent${agents.working > 1 ? 's' : ''} working`,
          agents.waiting && `${agents.waiting} waiting for you`,
          agents.done && `${agents.done} finished`,
          agents.background && `${agents.background} in background`,
        ]
          .filter(Boolean)
          .join(' · ');
        return w.item;
      }),
    );
    return g.item;
  });
  placeChildren($('groups'), groupItems);
  const groupIds = new Set(state.groups.map((g) => g.id));
  for (const id of groupElements.keys()) if (!groupIds.has(id)) groupElements.delete(id);
  const workspaceIds = new Set(state.groups.flatMap((g) => g.workspaces.map((w) => w.id)));
  for (const id of workspaceElements.keys()) if (!workspaceIds.has(id)) workspaceElements.delete(id);
}

/** Where a group can move: a new window, or another window, named by its groups. */
function windowChoices(): MenuItem[] {
  const others = shared.windows.filter((w) => w.id !== state.windowId);
  return [
    { id: 'window:new', label: 'New Window' },
    ...(others.length ? [{ id: '-', label: '' }] : []),
    ...others.map((w, i) => {
      const names = shared.groups.filter((g) => g.windowId === w.id).map((g) => g.name);
      return { id: `window:${w.id}`, label: names.length ? truncate(names.join(', '), 48) : `Empty window ${i + 1}` };
    }),
  ];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function changeGroupCwd(group: GroupState): Promise<void> {
  const folder = await senju.pickFolder(group.cwd);
  if (folder) act({ type: 'setGroupCwd', groupId: group.id, cwd: folder });
}

async function deleteGroup(group: GroupState): Promise<void> {
  const ids = group.workspaces.flatMap((w) => terminalIds(w.root));
  const ok = await confirmDialog({
    title: `Delete group “${group.name}”?`,
    detail: `${group.workspaces.length} workspace(s) with ${ids.length} terminal(s) will be closed.`,
    confirmLabel: 'Delete',
  });
  if (ok) act({ type: 'deleteGroup', groupId: group.id });
}

/** Saves the group to disk and closes it; it can be reopened as it was. */
async function closeGroup(group: GroupState): Promise<void> {
  const jobs = runningJobs(group.workspaces.flatMap((w) => terminalIds(w.root)));
  if (jobs.length) {
    const ok = await confirmDialog({
      title: `Close group “${group.name}”?`,
      detail: `Running programs stop: ${jobs.join(', ')}. When you reopen the group, agents resume their sessions, and dev servers and logs start again.`,
      confirmLabel: 'Close',
    });
    if (!ok) return;
  }
  act({ type: 'closeGroup', groupId: group.id });
}

async function exportGroup(group: GroupState): Promise<void> {
  const file = await senju.saveGroupFile(group.name);
  if (file) act({ type: 'exportGroup', groupId: group.id, file });
}

async function importGroup(): Promise<void> {
  const file = await senju.openGroupFile();
  if (file) act({ type: 'importGroup', file, windowId: state.windowId });
}

/** Closed groups to reopen, newest first, and opening a group from a file. */
async function closedGroupsMenu(at: HTMLElement): Promise<void> {
  const closed = state.closedGroups ?? [];
  // The name, and on the right where the shortcut goes, when it was closed.
  const date = (time: number) => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const choice = await showMenu(
    [
      ...(closed.length
        ? closed.map((g) => ({ id: `reopen:${g.id}`, label: g.name, accelerator: date(g.closedAt) }))
        : [{ id: 'none', label: 'No closed groups', enabled: false }]),
      { id: '-', label: '' },
      { id: 'import', label: 'Open Group from File…' },
      ...(closed.length ? [{ id: 'forget', label: 'Forget Closed Group', submenu: closed.map((g) => ({ id: `forget:${g.id}`, label: g.name })) }] : []),
    ],
    at,
  );
  if (choice?.startsWith('reopen:')) act({ type: 'reopenGroup', closedId: choice.slice('reopen:'.length), windowId: state.windowId });
  if (choice?.startsWith('forget:')) act({ type: 'forgetClosedGroup', closedId: choice.slice('forget:'.length) });
  if (choice === 'import') void importGroup();
}

async function closeWorkspace(workspace: WorkspaceState): Promise<void> {
  const jobs = runningJobs(terminalIds(workspace.root));
  if (jobs.length && !(await confirmClose(`Close “${workspace.name}”?`, `Running: ${jobs.join(', ')}`))) return;
  act({ type: 'closeWorkspace', workspaceId: workspace.id });
}

// --- terminals ---

function terminalView(terminalId: string): TerminalView {
  let view = terminals.get(terminalId);
  if (!view) {
    view = new TerminalView(terminalId, settings, platform, {
      onKey: handleKey,
      onFocus: (id) => {
        const workspace = activeContext()?.workspace;
        const pane = workspace && panes(workspace.root).find((p) => p.tabs.includes(id));
        if (pane && workspace.focusedPaneId !== pane.id) act({ type: 'focusPane', paneId: pane.id });
        if (pane) markFocus(pane.id);
      },
      onContextMenu: (id, e) => void terminalMenu(id, e),
      onZoom: (id, steps) => setTabZoom(id, tabZoom(id) + steps),
      keymap: () => keymap,
    });
    terminals.set(terminalId, view);
  }
  return view;
}

async function terminalMenu(terminalId: string, e: MouseEvent): Promise<void> {
  const view = terminals.get(terminalId);
  const workspace = activeContext()?.workspace;
  const pane = workspace && panes(workspace.root).find((p) => p.tabs.includes(terminalId));
  if (!pane) return;
  const choice = await contextMenu([
    { id: 'copy', label: 'Copy', accelerator: keymap.accelerator('copy'), enabled: !!view?.term.hasSelection() },
    { id: 'paste', label: 'Paste', accelerator: keymap.accelerator('paste') },
    { id: 'find', label: 'Find…', accelerator: keymap.accelerator('find') },
    { id: 'copyMode', label: 'Copy Mode', accelerator: keymap.accelerator('copyMode') },
    { id: '-', label: '' },
    { id: 'tab', label: 'New Tab', accelerator: keymap.accelerator('newTab') },
    { id: 'right', label: 'Split Right', accelerator: keymap.accelerator('splitRight') },
    { id: 'down', label: 'Split Down', accelerator: keymap.accelerator('splitDown') },
    { id: '-', label: '' },
    { id: 'closeTab', label: 'Close Tab', accelerator: keymap.accelerator('closeTab') },
    { id: 'closePane', label: 'Close Pane', accelerator: keymap.accelerator('closePane') },
    ...(panes(workspace.root).length > 1
      ? [{ id: 'maximize', label: maximized.get(workspace.id)?.paneId === pane.id ? 'Restore Pane' : 'Maximize Pane', accelerator: keymap.accelerator('toggleMaximize') }]
      : []),
    ...(state.usage?.[terminalId] ? [{ id: '-', label: '' }, { id: 'usage', label: 'Context and Tokens…', accelerator: keymap.accelerator('showUsage') }] : []),
    ...(tabZoom(terminalId) || settings.zoom ? [{ id: '-', label: '' }] : []),
    ...(tabZoom(terminalId) ? [{ id: 'resetZoom', label: 'Reset Tab Zoom', accelerator: keymap.accelerator('resetZoom') }] : []),
    ...(settings.zoom || anyTabZoomed() ? [{ id: 'resetZoomAll', label: 'Reset Zoom of All Terminals', accelerator: keymap.accelerator('resetZoomAll') }] : []),
  ], e);
  if (choice === 'copy') void view?.copy();
  if (choice === 'paste') void view?.paste();
  if (choice === 'find') view?.find();
  if (choice === 'copyMode') view?.toggleCopyMode();
  if (choice === 'tab') act({ type: 'createTab', paneId: pane.id });
  if (choice === 'right' || choice === 'down') act({ type: 'splitPane', paneId: pane.id, side: choice });
  if (choice === 'closeTab') void closeTab(terminalId);
  if (choice === 'closePane') void closePane(pane);
  if (choice === 'maximize') toggleMaximize(pane.id);
  if (choice === 'resetZoom') setTabZoom(terminalId, 0);
  if (choice === 'usage') usageView.open(terminalId);
  if (choice === 'resetZoomAll') resetAllZoom();
}

let zoomSave: ReturnType<typeof setTimeout> | null = null;

/** Zooms every terminal; saved once the zooming pauses, as a mouse wheel zooms in quick steps. */
function setZoom(zoom: number): void {
  const next = clampZoom(settings, zoom);
  if (next === settings.zoom) return;
  settings = { ...settings, zoom: next };
  for (const view of terminals.values()) view.applySettings(settings);
  renderStatus();
  if (zoomSave) clearTimeout(zoomSave);
  zoomSave = setTimeout(() => {
    zoomSave = null;
    void senju.saveSettings({ zoom: settings.zoom });
  }, 500);
}

/** Tab zooms not sent to the daemon yet, which are newer than the ones in the state. */
const tabZoomSends = new Map<string, { zoom: number; timer: ReturnType<typeof setTimeout> }>();

/** Pixels a terminal is zoomed by, on top of the zoom of all terminals. */
function tabZoom(terminalId: string): number {
  return tabZoomSends.get(terminalId)?.zoom ?? state.terminals[terminalId]?.zoom ?? 0;
}

function anyTabZoomed(): boolean {
  return Object.keys(state.terminals).some((id) => tabZoom(id));
}

/** Zooms one terminal; sent to the daemon once the zooming pauses, as a mouse wheel zooms in quick steps. */
function setTabZoom(terminalId: string, zoom: number): void {
  const next = clampZoom(settings, settings.zoom + zoom) - settings.zoom;
  if (next === tabZoom(terminalId)) return;
  const sending = tabZoomSends.get(terminalId);
  if (sending) clearTimeout(sending.timer);
  const timer = setTimeout(() => {
    tabZoomSends.delete(terminalId);
    act({ type: 'zoomTab', terminalId, zoom: next });
  }, 300);
  tabZoomSends.set(terminalId, { zoom: next, timer });
  terminals.get(terminalId)?.setZoom(next);
  renderStatus();
}

/** Returns every terminal to the font's own size. */
function resetAllZoom(): void {
  for (const id of Object.keys(state.terminals)) setTabZoom(id, 0);
  setZoom(0);
}

async function closeTab(terminalId: string): Promise<void> {
  const jobs = runningJobs([terminalId]);
  if (jobs.length && !(await confirmClose('Close this tab?', `Running: ${jobs[0]}`))) return;
  act({ type: 'closeTab', terminalId });
}

async function closePane(pane: PaneNode): Promise<void> {
  const jobs = runningJobs(pane.tabs);
  if (jobs.length && !(await confirmClose('Close this pane and all its tabs?', `Running: ${jobs.join(', ')}`))) return;
  act({ type: 'closePane', paneId: pane.id });
}

function renderPending(view: TerminalView): void {
  const pending = state.terminals[view.terminalId]?.pending;
  view.overlay.replaceChildren();
  view.overlay.classList.toggle('visible', !!pending);
  if (!pending) return;
  const text = el('span', 'pending-text', 'Was running before restart: ');
  text.append(el('code', '', pending.command));
  const run = el('button', 'button primary', 'Run again');
  run.addEventListener('click', () => {
    act({ type: 'runPending', terminalId: view.terminalId });
    view.focus();
  });
  const dismiss = el('button', 'button', 'Dismiss');
  dismiss.addEventListener('click', () => {
    act({ type: 'dismissPending', terminalId: view.terminalId });
    view.focus();
  });
  view.overlay.append(text, run, dismiss);
}

// --- panes ---

/** A pane of the layout: a tab bar and the active tab's terminal. */
class PaneView {
  readonly element = el('div', 'pane');
  private readonly tabBar = el('div', 'pane-tabs');
  private readonly tabList = el('div', 'pane-tab-list');
  private readonly actions = el('div', 'pane-actions');
  private readonly body = el('div', 'pane-body');
  private readonly maximizeButton: HTMLButtonElement;
  private readonly tabs = new Map<string, { tab: HTMLElement; label: HTMLElement; mark: HTMLElement; usage: HTMLElement }>();
  private node!: PaneNode;

  constructor(readonly id: string) {
    const button = (icon: Parameters<typeof iconButton>[0], label: string, command: Command, run: () => void) => {
      const b = iconButton(icon, label);
      tip(b, label, command);
      b.addEventListener('click', run);
      return b;
    };
    this.maximizeButton = button('maximize', 'Maximize pane', 'toggleMaximize', () => toggleMaximize(this.id));
    this.actions.append(
      button('plus', 'New tab', 'newTab', () => act({ type: 'createTab', paneId: this.id })),
      button('splitRight', 'Split right', 'splitRight', () => act({ type: 'splitPane', paneId: this.id, side: 'right' })),
      button('splitDown', 'Split down', 'splitDown', () => act({ type: 'splitPane', paneId: this.id, side: 'down' })),
      this.maximizeButton,
      button('close', 'Close pane with all its tabs', 'closePane', () => void closePane(this.node)),
    );
    this.tabBar.append(this.tabList, this.actions);
    this.element.append(this.tabBar, this.body);
    this.tabBar.addEventListener('dblclick', (e) => {
      if (e.target === this.tabBar || e.target === this.tabList) act({ type: 'createTab', paneId: this.id });
    });
    dropZone(this.tabList, ['tab'], (_kind, id) => act({ type: 'moveTab', terminalId: id, paneId: this.id, toIndex: this.node.tabs.length }));
  }

  update(node: PaneNode): void {
    this.node = node;
    placeChildren(
      this.tabList,
      node.tabs.map((terminalId) => {
        const terminal = state.terminals[terminalId];
        const { tab, label, mark, usage } = this.tabElements(terminalId);
        tab.classList.toggle('active', terminalId === node.activeTab);
        const status = agentStatus(terminal);
        mark.className = `tab-mark ${status?.kind ?? (terminal?.job ? 'running' : '')}`.trim();
        mark.title = status ? `Agent ${statusText(terminalId, status)}` : '';
        if (!label.querySelector('input')) label.textContent = tabLabel(terminal);
        renderTabUsage(usage, terminalId);
        const doing = status?.tasks ? status.tasks.map((t) => `  ${t}`).join('\n') : status?.activity;
        tab.title = [
          status && `Agent ${statusText(terminalId, status)}${doing ? (status.tasks ? `, waits for:\n${doing}` : `: ${doing}`) : ''}`,
          profileText(state.profiles?.[terminalId]),
          jobLabel(terminal),
          terminal && shortPath(terminal.cwd),
        ]
          .filter(Boolean)
          .join('\n');
        return tab;
      }),
    );
    for (const id of this.tabs.keys()) if (!node.tabs.includes(id)) this.tabs.delete(id);

    const view = terminalView(node.activeTab);
    view.setZoom(tabZoom(node.activeTab));
    view.attach();
    if (this.body.firstChild !== view.element) this.body.replaceChildren(view.element);
    renderPending(view);
  }

  private tabElements(terminalId: string): { tab: HTMLElement; label: HTMLElement; mark: HTMLElement; usage: HTMLElement } {
    let entry = this.tabs.get(terminalId);
    if (entry) return entry;
    const tab = el('div', 'tab');
    const mark = el('span', 'tab-mark');
    const label = el('span', 'tab-label');
    // How full the agent's context is; a click shows what fills it.
    const usage = el('span', 'tab-usage');
    usage.hidden = true;
    usage.addEventListener('mousedown', (e) => e.stopPropagation());
    usage.addEventListener('click', (e) => {
      e.stopPropagation();
      usageView.open(terminalId);
    });
    const close = iconButton('close', 'Close tab', 'tab-close');
    tip(close, 'Close tab', 'closeTab');
    close.addEventListener('mousedown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void closeTab(terminalId);
    });
    tab.append(mark, label, usage, close);
    tab.addEventListener('mousedown', (e) => {
      if (e.button === 0) act({ type: 'activateTab', terminalId });
    });
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) void closeTab(terminalId);
    });
    tab.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameTab(terminalId, label);
    });
    draggable(tab, 'tab', terminalId);
    dropZone(tab, ['tab'], (_kind, id) => act({ type: 'moveTab', terminalId: id, paneId: this.id, toIndex: this.node.tabs.indexOf(terminalId) }));
    entry = { tab, label, mark, usage };
    this.tabs.set(terminalId, entry);
    return entry;
  }

  /** Shows the pane over the whole workspace, or back in its place in the layout. */
  setMaximized(maximized: boolean, alone: boolean): void {
    this.element.classList.toggle('maximized', maximized);
    // A pane alone in its workspace already fills it.
    this.maximizeButton.hidden = alone;
    this.maximizeButton.classList.toggle('active', maximized);
    const icon = maximized ? 'restore' : 'maximize';
    if (this.maximizeButton.dataset.icon !== icon) {
      const label = maximized ? 'Restore pane' : 'Maximize pane';
      this.maximizeButton.dataset.icon = icon;
      this.maximizeButton.innerHTML = iconSvg(icon);
      this.maximizeButton.setAttribute('aria-label', label);
      tip(this.maximizeButton, label, 'toggleMaximize');
    }
  }

  get activeView(): TerminalView | undefined {
    return terminals.get(this.node.activeTab);
  }

  tabLabelElement(terminalId: string): HTMLElement | null {
    return this.tabs.get(terminalId)?.label ?? null;
  }
}

/** "context 42%", or "context 45k" when the model's window is unknown. */
function contextLabel(terminalId: string): string | undefined {
  const usage = state.usage?.[terminalId];
  if (!usage) return undefined;
  const percent = contextPercent(usage);
  return `context ${percent === null ? formatTokens(usage.context) : `${percent}%`}`;
}

/** The context fill of an agent's tab: "42%", or its tokens when the window is unknown. */
function renderTabUsage(element: HTMLElement, terminalId: string): void {
  const usage = state.usage?.[terminalId];
  element.hidden = !usage;
  if (!usage) return;
  const percent = contextPercent(usage);
  const text = percent === null ? formatTokens(usage.context) : `${percent}%`;
  if (element.textContent !== text) element.textContent = text;
  element.className = `tab-usage ${percent === null ? '' : contextLevel(percent)}`.trim();
  const window = usage.window ? ` of ${usage.window.exact ? '' : '≈'}${formatTokens(usage.window.tokens)}` : '';
  const key = keymap.accelerator('showUsage');
  element.title = `Context: ${formatTokens(usage.context)} tokens${window}\nThis session: ${formatTokens(usage.session.output)} output tokens\nClick for what fills it${key ? ` (${key})` : ''}`;
}

function renameTab(terminalId: string, label: HTMLElement): void {
  const terminal = state.terminals[terminalId];
  startRename(label, terminal?.name ?? tabLabel(terminal), (n) => act({ type: 'renameTab', terminalId, name: n }));
}

function paneView(node: PaneNode): PaneView {
  let view = paneViews.get(node.id);
  if (!view) {
    view = new PaneView(node.id);
    view.element.addEventListener('mousedown', () => {
      if (activeContext()?.workspace.focusedPaneId !== node.id) act({ type: 'focusPane', paneId: node.id });
    });
    paneViews.set(node.id, view);
  }
  view.update(node);
  return view;
}

function buildLayout(node: LayoutNode): HTMLElement {
  if (node.type === 'pane') return paneView(node).element;
  const container = el('div', `split split-${node.direction}`);
  const children: HTMLElement[] = [];
  node.children.forEach((child, i) => {
    if (i > 0) container.append(divider(node, i - 1, container));
    const wrapper = el('div', 'split-child');
    wrapper.append(buildLayout(child));
    container.append(wrapper);
    children.push(wrapper);
  });
  splitElements.set(node.id, { node, children });
  return container;
}

function divider(node: SplitNode, index: number, container: HTMLElement): HTMLElement {
  const line = el('div', 'divider');
  line.addEventListener('mousedown', (down) => {
    down.preventDefault();
    down.stopPropagation();
    const entry = splitElements.get(node.id);
    if (!entry) return;
    dragging = true;
    const row = node.direction === 'row';
    const rect = container.getBoundingClientRect();
    const total = row ? rect.width : rect.height;
    const start = row ? down.clientX : down.clientY;
    const sizes = [...entry.node.sizes];
    const pair = sizes[index] + sizes[index + 1];
    const min = Math.min(pair / 2, 80 / total);
    document.body.classList.add(row ? 'resizing-row' : 'resizing-column');
    const move = (e: MouseEvent) => {
      const delta = ((row ? e.clientX : e.clientY) - start) / total;
      const a = Math.max(min, Math.min(pair - min, entry.node.sizes[index] + delta));
      sizes[index] = a;
      sizes[index + 1] = pair - a;
      applySizes(entry.children, sizes);
    };
    const up = () => {
      dragging = false;
      document.body.classList.remove('resizing-row', 'resizing-column');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      entry.node = { ...entry.node, sizes };
      act({ type: 'resizeSplit', splitId: node.id, sizes });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  return line;
}

function applySizes(children: HTMLElement[], sizes: number[]): void {
  children.forEach((child, i) => (child.style.flex = `${sizes[i]} 1 0`));
}

/** Layout identity without sizes and tabs, so resizing or switching tabs does not rebuild the DOM. */
function structure(node: LayoutNode): unknown {
  return node.type === 'pane' ? node.id : [node.id, node.direction, node.children.map(structure)];
}

function syncLayout(node: LayoutNode): void {
  if (node.type === 'pane') {
    paneViews.get(node.id)?.update(node);
    return;
  }
  const entry = splitElements.get(node.id);
  if (entry) {
    entry.node = node;
    if (!dragging) applySizes(entry.children, node.sizes);
  }
  node.children.forEach(syncLayout);
}

function renderEmpty(container: HTMLElement): void {
  const box = el('div', 'empty');
  const group = state.groups[0];
  const button = el('button', 'button primary');
  const hint = el('div', 'empty-hint');
  const mark = el('div', 'empty-mark');
  mark.innerHTML = logoSvg(56);
  box.append(mark);
  if (!group) {
    box.append(el('div', 'empty-title', state.closedGroups?.length ? 'All groups are closed' : 'No groups yet'));
    button.textContent = 'New Group';
    button.addEventListener('click', () => void runCommand('newGroup'));
    hint.textContent = keymap.accelerator('newGroup') ?? '';
    if (state.closedGroups?.length) {
      const reopen = el('button', 'button', 'Reopen a Closed Group…');
      reopen.addEventListener('click', () => void closedGroupsMenu(reopen));
      box.append(button, reopen, hint);
      container.replaceChildren(box);
      return;
    }
  } else {
    box.append(el('div', 'empty-title', 'No workspace open'));
    button.textContent = `New Workspace in “${group.name}”`;
    button.addEventListener('click', () => act({ type: 'createWorkspace', groupId: group.id }));
    hint.textContent = keymap.accelerator('newWorkspace') ?? '';
  }
  box.append(button, hint);
  container.replaceChildren(box);
}

/**
 * The maximized pane of each workspace, shown over the whole workspace until
 * restored. Moving the focus to another pane restores it. A view setting of
 * this window only, not kept across restarts.
 */
const maximized = new Map<string, { paneId: string; focused: boolean }>();

function toggleMaximize(paneId: string): void {
  const workspace = activeContext()?.workspace;
  if (!workspace) return;
  if (maximized.get(workspace.id)?.paneId === paneId) maximized.delete(workspace.id);
  else if (panes(workspace.root).length > 1) {
    // Maximizing a pane focuses it; until the daemon confirms, the old focus does not restore it.
    maximized.set(workspace.id, { paneId, focused: false });
    if (workspace.focusedPaneId !== paneId) act({ type: 'focusPane', paneId });
  }
  showMaximized(workspace);
  paneViews.get(paneId)?.activeView?.focus();
  refreshAttention();
}

function showMaximized(workspace: WorkspaceState): void {
  const list = panes(workspace.root);
  const entry = maximized.get(workspace.id);
  if (entry && workspace.focusedPaneId === entry.paneId) entry.focused = true;
  // The maximized pane closed, or another pane took the focus.
  if (entry && ((entry.focused && workspace.focusedPaneId !== entry.paneId) || list.length < 2 || !list.some((p) => p.id === entry.paneId))) {
    maximized.delete(workspace.id);
  }
  const shown = maximized.get(workspace.id)?.paneId;
  $('workspace').classList.toggle('maximized', !!shown);
  for (const { id } of list) paneViews.get(id)?.setMaximized(id === shown, list.length < 2);
}

function markFocus(paneId: string): void {
  for (const [id, view] of paneViews) view.element.classList.toggle('focused', id === paneId);
}

function renderWorkspace(force = false): void {
  const container = $('workspace');
  const workspace = activeContext()?.workspace;
  if (!workspace) {
    layoutSignature = '';
    splitElements.clear();
    container.classList.remove('maximized');
    renderEmpty(container);
    return;
  }
  const signature = JSON.stringify([workspace.id, structure(workspace.root)]);
  if (force || signature !== layoutSignature) {
    layoutSignature = signature;
    splitElements.clear();
    container.replaceChildren(buildLayout(workspace.root));
  } else {
    syncLayout(workspace.root);
  }
  const ids = new Set(panes(workspace.root).map((p) => p.id));
  for (const [id, view] of paneViews) if (!ids.has(id) && !view.element.isConnected) paneViews.delete(id);
  markFocus(workspace.focusedPaneId);
  showMaximized(workspace);
  const focused = focusedTerminal();
  if (focused && !editing && !document.activeElement?.closest('.terminal-overlay')) {
    if (!focused.element.contains(document.activeElement)) focused.focus();
  }
  requestAnimationFrame(() => {
    for (const pane of panes(workspace.root)) terminals.get(pane.activeTab)?.fit();
  });
}

/** The collapsed sidebar: one marker per workspace, in its color. */
function renderRail(): void {
  const rail = $('rail');
  rail.replaceChildren();
  state.groups.forEach((group, i) => {
    if (i > 0) rail.append(el('div', 'rail-gap'));
    for (const workspace of group.workspaces) {
      const marker = el('button', `rail-item${workspace.id === state.activeWorkspaceId ? ' active' : ''}`, workspace.name.slice(0, 1).toUpperCase());
      if (workspace.color) marker.style.setProperty('--ws-color', workspace.color);
      marker.classList.toggle('colored', !!workspace.color);
      marker.title = `${group.name} / ${workspace.name}`;
      marker.addEventListener('click', () => act({ type: 'activateWorkspace', workspaceId: workspace.id }));
      rail.append(marker);
    }
  });
}

/**
 * The status bar: where you are, the agents of this workspace, and agents
 * elsewhere that wait for input.
 */
function renderStatus(): void {
  const bar = $('statusbar');
  const ctx = activeContext();
  const parts: HTMLElement[] = [];
  const item = (className: string, text: string, title = '') => {
    const span = el('span', `status-item ${className}`.trim(), text);
    if (title) span.title = title;
    return span;
  };
  if (ctx) {
    const where = item('status-where', `${ctx.group.name} / ${ctx.workspace.name}`);
    const swatch = el('span', 'status-swatch');
    if (ctx.workspace.color) swatch.style.background = ctx.workspace.color;
    else swatch.classList.add('empty');
    where.prepend(swatch);
    parts.push(where);
    for (const id of terminalIds(ctx.workspace.root)) {
      const terminal = state.terminals[id];
      const status = agentStatus(terminal);
      if (status) {
        const context = contextLabel(id);
        const text = `${tabLabel(terminal)} ${statusText(id, status)}${context ? ` · ${context}` : ''}`;
        const title = [status.tasks?.join('\n') ?? status.activity, profileText(state.profiles?.[id])].filter(Boolean).join('\n');
        parts.push(item(status.kind, status.activity ? `${text} · ${status.activity}` : text, title));
      }
    }
  }
  parts.push(el('span', 'status-spacer'));
  let agents = 0;
  for (const group of state.groups) {
    for (const workspace of group.workspaces) {
      const counts = workspaceAgents(workspace);
      agents += counts.working + counts.waiting + counts.done + counts.background;
      const kind = counts.waiting ? 'waiting' : counts.done ? 'done' : null;
      if (workspace.id !== ctx?.workspace.id && kind) {
        // The longest wait of the workspace, as the queue is sorted.
        const ids = terminalIds(workspace.root);
        const first = waitingAgents.find((w) => ids.includes(w.terminalId));
        const waited = first ? ` ${formatWait(Date.now() - first.since)}` : '';
        const elsewhere = item(`${kind} link`, `${group.name}/${workspace.name} ${kind === 'done' ? 'finished' : 'waiting'}${waited}`, 'Show this workspace');
        elsewhere.addEventListener('click', () => act({ type: 'activateWorkspace', workspaceId: workspace.id }));
        parts.push(elsewhere);
      }
    }
  }
  if (waitingAgents.length) {
    // The queue of agents waiting for you, and how long the first one has waited.
    const key = keymap.accelerator('nextAttention');
    const longest = formatWait(Date.now() - waitingAgents[0].since);
    const label = `${waitingAgents.length} waiting · longest ${longest}`;
    const title = `Go to the agent waiting longest${key ? ` (${key})` : ''}`;
    const count = item(`${unseenAgents.length ? 'waiting' : 'muted'} link`, label, title);
    count.addEventListener('click', () => nextAttention());
    parts.push(count);
  }
  if (agents) {
    const key = keymap.accelerator('toggleOverview');
    const all = item('muted link', `${agents} agent${agents === 1 ? '' : 's'}`, key ? `Show all agents (${key})` : 'Show all agents');
    all.addEventListener('click', () => overview.toggle());
    parts.push(all);
  }
  const focused = focusedPane()?.activeTab;
  const zoomed = focused ? tabZoom(focused) : 0;
  if (settings.zoom || zoomed) {
    // The zoom of the focused tab; clicking returns it to the font's own size.
    const key = keymap.accelerator(zoomed && !settings.zoom ? 'resetZoom' : 'resetZoomAll');
    const zoom = item('link status-zoom', `Zoom ${zoomPercent(settings, zoomed)}%`, key ? `Reset zoom (${key})` : 'Reset zoom');
    zoom.insertAdjacentHTML('beforeend', iconSvg('close', 12));
    zoom.addEventListener('click', () => {
      if (focused) setTabZoom(focused, 0);
      setZoom(0);
    });
    parts.push(zoom);
  }
  bar.replaceChildren(...parts);
}

function setSidebarHidden(hidden: boolean): void {
  act({ type: 'setUi', windowId: state.windowId, ui: { sidebarHidden: hidden } });
}

function render(force = false): void {
  if (editing) return;
  const hidden = !!state.ui.sidebarHidden;
  $('sidebar').classList.toggle('collapsed', hidden);
  tip($('toggle-sidebar'), hidden ? 'Show sidebar' : 'Hide sidebar', 'toggleSidebar');
  if (hidden) renderRail();
  else renderSidebar();
  renderWorkspace(force);
  checkAttention();
  if (overview.isOpen && state.activeWorkspaceId !== overviewWorkspace) overview.close();
  overview.update();
  renderStatus();
  renderTitle();
}

function renderTitle(): void {
  const ctx = activeContext();
  const count = unseenAgents.length ? `(${unseenAgents.length}) ` : '';
  document.title = count + (ctx ? `${ctx.workspace.name} — ${ctx.group.name} — Senju` : 'Senju');
}

// --- agents that need you ---

const attention = new Attention();
/** Agents that need the user and that the user has not looked at since. */
let unseenAgents: string[] = [];
/** Every agent that waits for the user, longest wait first: the queue Ctrl+Shift+J walks. */
let waitingAgents: Wait[] = [];
let attentionTimer: ReturnType<typeof setTimeout> | null = null;

/** The terminals on screen: the active tab of each pane in the active workspace, except under a maximized pane. */
function visibleTerminals(): Set<string> {
  const workspace = activeContext()?.workspace;
  if (!workspace || overview.isOpen) return new Set();
  const shown = maximized.get(workspace.id)?.paneId;
  return new Set(panes(workspace.root).filter((p) => !shown || p.id === shown).map((p) => p.activeTab));
}

function terminalPlace(terminalId: string): { group: GroupState; workspace: WorkspaceState } | null {
  for (const group of state.groups) {
    for (const workspace of group.workspaces) if (terminalIds(workspace.root).includes(terminalId)) return { group, workspace };
  }
  return null;
}

/**
 * Notes which agents need the user and which of them are on screen, sends
 * notifications for new waits off screen, and keeps the counter on the app
 * icon. Returns whether the unseen agents changed.
 */
function checkAttention(): boolean {
  if (!state) return false;
  const looking = document.hasFocus() && !document.hidden;
  const visible = visibleTerminals();
  const views = Object.keys(state.terminals).map((terminalId) => ({
    terminalId,
    status: agentStatus(state.terminals[terminalId]),
    seenNow: looking && visible.has(terminalId),
  }));
  const { notify, unseen, waiting, recheckIn } = attention.update(views, Date.now());
  for (const id of unseenAgents) if (!unseen.includes(id)) senju.clearNotification(id);
  if (settings.notifications) {
    for (const id of notify) {
      const terminal = state.terminals[id];
      const status = agentStatus(terminal);
      const place = terminalPlace(id);
      if (!status || (status.reason && !settings.notifyOn[status.reason])) continue;
      const body = [place && `${place.group.name} / ${place.workspace.name}`, status.activity].filter(Boolean).join('\n');
      senju.notify(id, `${tabLabel(terminal)} ${status.text}`, body);
    }
  }
  if (attentionTimer) clearTimeout(attentionTimer);
  attentionTimer = recheckIn === null ? null : setTimeout(refreshAttention, recheckIn + 50);
  const queue = (list: Wait[]) => list.map((w) => `${w.terminalId}@${w.since}`).join();
  const queueChanged = queue(waiting) !== queue(waitingAgents);
  waitingAgents = waiting;
  if (unseen.join() === unseenAgents.join()) return queueChanged;
  unseenAgents = unseen;
  senju.setBadge(unseen.length);
  return true;
}

/** How long an agent has waited for the user, or null when it does not wait. */
function waitedFor(terminalId: string): string | null {
  const wait = waitingAgents.find((w) => w.terminalId === terminalId);
  return wait ? formatWait(Date.now() - wait.since) : null;
}

/** The status with how long the agent has waited for the user or for its background work: "finished 12m". */
function statusText(terminalId: string, status: AgentStatus): string {
  const age = waitedFor(terminalId) ?? (status.since ? formatWait(Date.now() - status.since) : null);
  return age ? `${status.text} ${age}` : status.text;
}

// The wait times in the status bar move on.
setInterval(() => {
  if (!state || (!waitingAgents.length && !Object.values(state.terminals).some((t) => t.agent?.state === 'background'))) return;
  renderStatus();
  overview.update();
}, 15_000);

const usageView = new UsageView({
  request: (terminalId) => senju.send({ type: 'usage', terminalId }),
  name: (terminalId) => tabLabel(state.terminals[terminalId]),
  profile: (terminalId) => profileText(state.profiles?.[terminalId]),
});

// --- overview of all agents ---

const overview = new Overview({
  cards: overviewCards,
  peek: (terminalIds) => senju.send({ type: 'peek', terminalIds, lines: OVERVIEW_LINES }),
  open: (terminalId) => goToTerminal(terminalId),
  onToggle: (open) => {
    document.body.classList.toggle('overview-open', open);
    overviewWorkspace = state?.activeWorkspaceId ?? null;
    if (!open) focusedTerminal()?.focus();
    refreshAttention();
  },
});
/** The workspace active when the overview opened; showing another one closes it. */
let overviewWorkspace: string | null = null;

/** Every agent: those waiting for the user first, longest wait first, then the rest in sidebar order. */
function overviewCards(): OverviewCard[] {
  const ordered: string[] = [];
  for (const group of state.groups) for (const workspace of group.workspaces) ordered.push(...terminalIds(workspace.root));
  const queue = waitingAgents.map((w) => w.terminalId);
  const ids = [...queue, ...ordered.filter((id) => !queue.includes(id))];
  return ids.flatMap((terminalId) => {
    const terminal = state.terminals[terminalId];
    const status = agentStatus(terminal);
    const place = terminalPlace(terminalId);
    if (!status || !place) return [];
    return [
      {
        terminalId,
        name: tabLabel(terminal),
        kind: status.kind,
        text: statusText(terminalId, status),
        activity: status.tasks?.join(' · ') ?? status.activity,
        place: `${place.group.name} / ${place.workspace.name}`,
        profile: profileText(state.profiles?.[terminalId]) || undefined,
        context: contextLabel(terminalId),
      },
    ];
  });
}

/** Checks again outside a render: the window gained or lost focus, or a guessed wait lasted. */
function refreshAttention(): void {
  if (state && checkAttention()) {
    renderStatus();
    renderTitle();
  }
}

/** Shows the agent's terminal: its workspace, pane and tab. */
function goToTerminal(terminalId: string): void {
  if (!state.terminals[terminalId]) return;
  overview.close();
  act({ type: 'activateTab', terminalId });
  terminals.get(terminalId)?.focus();
}

/** Goes to the agent that has waited longest, or from one in the queue to the next. */
function nextAttention(): void {
  const target = nextInQueue(waitingAgents, focusedPane()?.activeTab);
  if (target) goToTerminal(target);
}

// --- commands ---

function neighbor(direction: 'left' | 'right' | 'up' | 'down'): string | null {
  const workspace = activeContext()?.workspace;
  const current = workspace && paneViews.get(workspace.focusedPaneId)?.element.getBoundingClientRect();
  if (!workspace || !current) return null;
  let best: { id: string; score: number } | null = null;
  for (const { id } of panes(workspace.root)) {
    if (id === workspace.focusedPaneId) continue;
    const r = paneViews.get(id)?.element.getBoundingClientRect();
    if (!r) continue;
    const horizontal = direction === 'left' || direction === 'right';
    const gap =
      direction === 'right' ? r.left - current.right : direction === 'left' ? current.left - r.right : direction === 'down' ? r.top - current.bottom : current.top - r.bottom;
    if (gap < -4) continue;
    const overlap = horizontal
      ? Math.min(r.bottom, current.bottom) - Math.max(r.top, current.top)
      : Math.min(r.right, current.right) - Math.max(r.left, current.left);
    const offset = horizontal ? Math.abs(r.top + r.height / 2 - (current.top + current.height / 2)) : Math.abs(r.left + r.width / 2 - (current.left + current.width / 2));
    const score = gap * 10 + (overlap > 0 ? 0 : 10000) + offset;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}

function cycle<T>(items: T[], index: number, step: number): T | undefined {
  if (items.length === 0) return undefined;
  return items[(Math.max(index, 0) + step + items.length) % items.length];
}

/** New groups start in the home directory with a generated name; rename by double click. */
function newGroup(): void {
  act({ type: 'createGroup', name: '', cwd: home, windowId: state.windowId });
}

async function runCommand(command: Command): Promise<void> {
  note(`command ${command}`);
  const ctx = activeContext();
  const pane = focusedPane();
  const split = (side: SplitSide) => pane && act({ type: 'splitPane', paneId: pane.id, side });
  const zoomTab = (zoom: (current: number) => number) => {
    if (pane) setTabZoom(pane.activeTab, zoom(tabZoom(pane.activeTab)));
  };
  const focus = (dir: 'left' | 'right' | 'up' | 'down') => {
    // Neighbors are found by their place on screen, which a maximized pane covers.
    if (ctx && maximized.delete(ctx.workspace.id)) showMaximized(ctx.workspace);
    const id = neighbor(dir);
    if (!id) return;
    act({ type: 'focusPane', paneId: id });
    paneViews.get(id)?.activeView?.focus();
  };
  const switchTab = (target: string | undefined) => target && act({ type: 'activateTab', terminalId: target });
  switch (command) {
    case 'newGroup':
      return void newGroup();
    case 'newWindow':
      return senju.newWindow();
    case 'toggleSidebar':
      return setSidebarHidden(!state.ui.sidebarHidden);
    case 'newWorkspace': {
      const group = ctx?.group ?? state.groups[0];
      if (group) act({ type: 'createWorkspace', groupId: group.id });
      else newGroup();
      return;
    }
    case 'newTab':
      if (pane) act({ type: 'createTab', paneId: pane.id });
      else return runCommand('newWorkspace');
      return;
    case 'closeTab':
      if (pane) return closeTab(pane.activeTab);
      return;
    case 'renameTab': {
      const label = pane && paneViews.get(pane.id)?.tabLabelElement(pane.activeTab);
      if (pane && label) renameTab(pane.activeTab, label);
      return;
    }
    case 'splitRight':
      return void split('right');
    case 'splitDown':
      return void split('down');
    case 'focusLeft':
      return focus('left');
    case 'focusRight':
      return focus('right');
    case 'focusUp':
      return focus('up');
    case 'focusDown':
      return focus('down');
    case 'nextTab':
    case 'prevTab':
      if (pane) switchTab(cycle(pane.tabs, pane.tabs.indexOf(pane.activeTab), command === 'nextTab' ? 1 : -1));
      return;
    case 'nextWorkspace':
    case 'prevWorkspace': {
      // Through all groups in sidebar order, opening a collapsed group it enters.
      const list = state.groups.flatMap((group) => group.workspaces.map((workspace) => ({ group, workspace })));
      const next = cycle(list, list.findIndex((w) => w.workspace.id === state.activeWorkspaceId), command === 'nextWorkspace' ? 1 : -1);
      if (!next) return;
      if (next.group.collapsed) act({ type: 'setGroupCollapsed', groupId: next.group.id, collapsed: false });
      act({ type: 'activateWorkspace', workspaceId: next.workspace.id });
      return;
    }
    case 'moveWorkspaceDown':
    case 'moveWorkspaceUp': {
      // One place down or up; past the end of its group, into the next or previous group.
      if (!ctx) return;
      const { group, workspace } = ctx;
      const index = group.workspaces.indexOf(workspace);
      const groupIndex = state.groups.indexOf(group);
      const down = command === 'moveWorkspaceDown';
      if (down && index < group.workspaces.length - 1) act({ type: 'moveWorkspace', workspaceId: workspace.id, groupId: group.id, toIndex: index + 2 });
      else if (!down && index > 0) act({ type: 'moveWorkspace', workspaceId: workspace.id, groupId: group.id, toIndex: index - 1 });
      else {
        const target = state.groups[groupIndex + (down ? 1 : -1)];
        if (target) act({ type: 'moveWorkspace', workspaceId: workspace.id, groupId: target.id, toIndex: down ? 0 : target.workspaces.length });
      }
      return;
    }
    case 'nextGroup':
    case 'prevGroup': {
      const groups = state.groups.filter((g) => g.workspaces.length > 0 || g === ctx?.group);
      const next = cycle(groups, ctx ? groups.indexOf(ctx.group) : -1, command === 'nextGroup' ? 1 : -1);
      if (!next || next === ctx?.group) return;
      // Return to the workspace last used in that group.
      const remembered = next.workspaces.find((w) => w.id === lastWorkspace.get(next.id));
      const target = remembered ?? next.workspaces[0];
      if (!target) return;
      if (next.collapsed) act({ type: 'setGroupCollapsed', groupId: next.id, collapsed: false });
      act({ type: 'activateWorkspace', workspaceId: target.id });
      return;
    }
    case 'closeWorkspace':
      if (ctx) return closeWorkspace(ctx.workspace);
      return;
    case 'closePane':
      if (pane) return closePane(pane);
      return;
    case 'toggleOverview':
      return overview.toggle();
    case 'showUsage':
      if (pane) usageView.open(pane.activeTab);
      return;
    case 'nextAttention':
      return nextAttention();
    case 'toggleMaximize':
      if (pane) toggleMaximize(pane.id);
      return;
    case 'nextPane':
    case 'prevPane': {
      const list = ctx ? panes(ctx.workspace.root) : [];
      const next = cycle(list, list.findIndex((p) => p.id === pane?.id), command === 'nextPane' ? 1 : -1);
      if (next && next.id !== pane?.id) {
        act({ type: 'focusPane', paneId: next.id });
        paneViews.get(next.id)?.activeView?.focus();
      }
      return;
    }
    case 'openSettings':
      return settingsView.show();
    case 'copy':
      return focusedTerminal()?.copy();
    case 'paste':
      return focusedTerminal()?.paste();
    case 'find':
      return focusedTerminal()?.find();
    case 'copyMode':
      return focusedTerminal()?.toggleCopyMode();
    case 'zoomIn':
      return zoomTab((z) => z + 1);
    case 'zoomOut':
      return zoomTab((z) => z - 1);
    case 'resetZoom':
      return zoomTab(() => 0);
    case 'zoomInAll':
      return setZoom(settings.zoom + 1);
    case 'zoomOutAll':
      return setZoom(settings.zoom - 1);
    case 'resetZoomAll':
      return resetAllZoom();
    default:
      if (pane) switchTab(pane.tabs[Number(command.slice('tab'.length)) - 1]);
  }
}

/** Runs the shortcut bound to a key event; returns whether one was bound. */
function handleKey(e: KeyboardEvent): boolean {
  const command = keymap.match(e);
  if (!command) return false;
  e.preventDefault();
  e.stopPropagation();
  void runCommand(command);
  return true;
}

// --- startup ---

function onMessage(msg: UiMessage): void {
  switch (msg.type) {
    case 'connected':
      for (const view of terminals.values()) view.reset();
      layoutSignature = '';
      showOutdated(msg.outdated);
      break;
    case 'state': {
      shared = msg.state;
      state = windowView(msg.state, windowId);
      const active = activeContext();
      if (active) lastWorkspace.set(active.group.id, active.workspace.id);
      for (const [id, view] of terminals) {
        if (!state.terminals[id]) {
          view.dispose();
          terminals.delete(id);
        }
      }
      const started = performance.now();
      render();
      const ms = performance.now() - started;
      if (ms >= SLOW_RENDER_MS) report('slow render', { ms: Math.round(ms), terminals: Object.keys(state.terminals).length });
      if (pendingSwitch?.shown()) {
        measureSwitch(pendingSwitch.what, pendingSwitch.at);
        pendingSwitch = null;
      } else if (pendingSwitch && performance.now() - pendingSwitch.at > 10_000) {
        pendingSwitch = null;
      }
      break;
    }
    case 'snapshot':
      terminals.get(msg.terminalId)?.onSnapshot(msg.data);
      break;
    case 'peek':
      overview.screens(msg.screens);
      break;
    case 'usage':
      usageView.show(msg.terminalId, msg.details);
      break;
    case 'data':
      terminals.get(msg.terminalId)?.onData(msg.data);
      break;
    case 'error':
      console.error(msg.message);
      setBanner('error', msg.message, [{ label: 'Dismiss', run: () => setBanner('error', null) }]);
      break;
  }
}

/** Shows, replaces or (with null) removes one banner row above the window. */
function setBanner(id: string, text: string | null, buttons: { label: string; primary?: boolean; run: () => void }[] = []): void {
  const host = $('banner');
  let row = host.querySelector<HTMLElement>(`[data-banner="${id}"]`);
  if (text === null) {
    row?.remove();
  } else {
    if (!row) {
      row = el('div', 'banner-row');
      row.dataset.banner = id;
      host.append(row);
    }
    const label = el('span', 'banner-text', text);
    row.replaceChildren(
      label,
      ...buttons.map(({ label: name, primary, run }) => {
        const button = el('button', `button${primary ? ' primary' : ''}`, name);
        button.addEventListener('click', run);
        return button;
      }),
    );
  }
  host.hidden = host.children.length === 0;
}

/** Offers to restart a daemon left running from an older build, which ignores newer actions. */
function showOutdated(outdated: boolean): void {
  if (!outdated) return setBanner('outdated', null);
  setBanner('outdated', 'Senju was updated, but the background service still runs the previous version. Restart it to use the new one; terminals come back as after a reboot.', [
    { label: 'Restart service', primary: true, run: () => (setBanner('outdated', null), senju.restartDaemon()) },
    { label: 'Later', run: () => setBanner('outdated', null) },
  ]);
}

/** The update banner: offered, downloading, ready to install. */
function showUpdate(status: UpdateStatus): void {
  settingsView?.render();
  switch (status.state) {
    case 'available':
      return setBanner('update', `Senju ${status.version} is available.`, [
        { label: status.manual ? 'Download' : 'Download and install', primary: true, run: () => senju.updateAction('download') },
        { label: 'What’s new', run: () => senju.openExternal(status.url) },
        { label: 'Later', run: () => senju.updateAction('dismiss') },
      ]);
    case 'downloading':
      return setBanner('update', `Downloading Senju ${status.version}… ${status.percent}%`);
    case 'ready':
      return setBanner('update', `Senju ${status.version} is ready. Restarting the app installs it; your terminals keep running.`, [
        { label: 'Restart and install', primary: true, run: () => senju.updateAction('install') },
        { label: 'Later', run: () => setBanner('update', null) },
      ]);
    case 'error':
      return setBanner('update', `The update failed: ${status.message}`, [{ label: 'Dismiss', run: () => setBanner('update', null) }]);
    default:
      return setBanner('update', null);
  }
}

/** Applies settings to the whole window: shortcuts, theme and fonts. */
function applySettings(next: Settings): void {
  // A zoom not saved yet is newer than the one in saved settings.
  settings = zoomSave ? { ...next, zoom: settings.zoom } : next;
  keymap = new Keymap(platform, settings.keybindings);
  const theme = resolveTheme(settings);
  const root = document.documentElement.style;
  const light = isLight(theme.background);
  root.setProperty('--bg', theme.background);
  root.setProperty('--fg', theme.foreground);
  root.setProperty('--link', theme.blue);
  root.setProperty('--waiting', theme.red);
  root.setProperty('--done', theme.green);
  root.setProperty('color-scheme', light ? 'light' : 'dark');
  document.body.classList.toggle('light', light);
  for (const view of terminals.values()) view.applySettings(settings);
  refreshTips();
  if (state) renderStatus();
}

async function main(): Promise<void> {
  startPerfMonitor();
  // Not by folder, as tabs without a name are: the home folder is the user's name.
  nameTerminals((id) => {
    const terminal = state?.terminals[id];
    return terminal?.name || (terminal?.job?.argv.length ? programName(terminal.job.argv) : 'shell');
  });
  [settings, platform, home] = await Promise.all([senju.settings(), senju.platform(), senju.homedir()]);
  document.body.classList.add(`platform-${platform}`);
  applySettings(settings);
  settingsView = new SettingsView({
    platform,
    settings: () => settings,
    save: async (patch) => applySettings(await senju.saveSettings(patch)),
    appInfo: () => senju.appInfo(),
    updateStatus: () => senju.updateStatus(),
    updateAction: (action) => senju.updateAction(action),
    copy: (text) => senju.clipboardWrite(text),
    openSettingsFile: () => senju.openConfig('settings'),
    openRecipesFolder: () => senju.openConfig('recipes'),
    showLogs: () => senju.openConfig('logs'),
    reportIssue: () => senju.openExternal('https://github.com/illerax/senju/issues/new'),
    stopAll: async () => {
      const ok = await confirmDialog({
        title: 'Quit and stop all processes?',
        detail: 'Running programs are stopped. Agents and commands are restored on the next start.',
        confirmLabel: 'Quit and stop',
      });
      if (ok) senju.stopAll();
    },
    confirm: (message, detail) => confirmDialog({ title: message, detail, confirmLabel: 'Delete' }),
  });
  document.body.append(settingsView.element);
  settingsView.element.addEventListener('close', () => focusedTerminal()?.focus());

  $('sidebar-logo').innerHTML = logoSvg(16);
  $('add-group').replaceWith(Object.assign(iconButton('plus', 'New group'), { id: 'add-group' }));
  $('toggle-sidebar').replaceWith(Object.assign(iconButton('sidebar', 'Hide sidebar'), { id: 'toggle-sidebar' }));
  $('open-settings').replaceWith(Object.assign(iconButton('gear', 'Settings'), { id: 'open-settings' }));
  $('workspace').after(overview.element);
  $('add-group').before(Object.assign(iconButton('grid', 'All agents'), { id: 'show-overview' }));
  $('show-overview').addEventListener('click', () => overview.toggle());
  $('add-group').before(Object.assign(iconButton('history', 'Closed groups'), { id: 'closed-groups' }));
  $('closed-groups').addEventListener('click', () => void closedGroupsMenu($('closed-groups')));
  tip($('show-overview'), 'All agents', 'toggleOverview');
  $('add-group').addEventListener('click', () => void newGroup());
  $('toggle-sidebar').addEventListener('click', () => setSidebarHidden(!state.ui.sidebarHidden));
  tip($('add-group'), 'New group', 'newGroup');
  $('open-settings').addEventListener('click', () => settingsView.show());
  tip($('open-settings'), 'Settings', 'openSettings');
  window.addEventListener('keydown', (e) => {
    if (!editing) handleKey(e);
  });

  senju.onMessage((msg) => onMessage(msg as UiMessage));
  showOutdated(await senju.daemonOutdated());
  senju.onUpdate(showUpdate);
  senju.onSettings((next) => {
    applySettings(next as Settings);
    settingsView.render();
  });
  senju.onNotificationClick((terminalId) => goToTerminal(terminalId));
  for (const event of ['focus', 'blur'] as const) window.addEventListener(event, refreshAttention);
  document.addEventListener('visibilitychange', refreshAttention);
  const update = await senju.updateStatus();
  if (update.state !== 'idle') showUpdate(update);
  const initial = (await senju.state()) as AppState | null;
  if (initial && !state) onMessage({ type: 'state', state: initial });
}

void main();
