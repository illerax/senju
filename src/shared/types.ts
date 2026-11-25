import { tabIds } from './layout';
import type { AgentProfile, AgentSessionFile, AgentUsage } from './usage';

// Persistent workspace state. The daemon is the single owner and writer of this
// structure; the UI only renders it and sends actions.
//
// A group (a project) holds workspaces. A workspace is split into panes, and
// each pane holds tabs. A tab is a terminal, or a viewer that shows a file.

export type SplitDirection = 'row' | 'column';

export interface PaneNode {
  type: 'pane';
  id: string;
  /** Ids of the tabs' terminals and viewers, in tab order. */
  tabs: string[];
  activeTab: string;
}

export interface SplitNode {
  type: 'split';
  id: string;
  /** 'row' places children left to right, 'column' top to bottom. */
  direction: SplitDirection;
  children: LayoutNode[];
  /** Relative sizes of children, summing to 1. */
  sizes: number[];
}

export type LayoutNode = PaneNode | SplitNode;

export interface WorkspaceState {
  id: string;
  name: string;
  root: LayoutNode;
  focusedPaneId: string;
  /** Hex color marking the workspace in the sidebar and around its layout. */
  color?: string;
  /** Session files of every agent that ran in the workspace, for its token usage. */
  agentSessions?: AgentSessionFile[];
}

export interface GroupState {
  id: string;
  name: string;
  /** Directory new workspaces of the group start in. */
  cwd: string;
  workspaces: WorkspaceState[];
  /** Whether the sidebar hides the group's workspaces. */
  collapsed: boolean;
  /** The window that shows the group. */
  windowId: string;
}

/** A program running in the foreground of a terminal's shell. */
export interface JobState {
  argv: string[];
  cwd: string;
  /** Environment variables that differ from the terminal shell's environment. */
  env: Record<string, string>;
  startedAt: number;
  /** Name of the matched agent recipe, if any. */
  recipe?: string;
  sessionId?: string;
}

/** A command that was running before a restart and waits for the user to run it again. */
export interface PendingCommand {
  command: string;
  cwd: string;
}

/**
 * What an agent reports through its hooks (Claude Code). Agents without hooks
 * have only `busy`, guessed from their output.
 */
export interface AgentState {
  /**
   * working: on a task; permission: asks to allow a tool; question: asks the
   * user something; done: finished its turn; background: ended its turn but
   * resumes by itself when a background task finishes or a scheduled wakeup
   * fires; waiting: stopped without saying why, e.g. interrupted; error: the
   * turn failed; ended: the session is over and the program is exiting.
   */
  state: 'working' | 'permission' | 'question' | 'done' | 'background' | 'waiting' | 'error' | 'ended';
  /**
   * The tool call in progress or waiting for permission, e.g. "Bash: npm test";
   * in the background state, what the agent waits for.
   */
  activity?: string;
  /** In the background state, each task or scheduled wakeup it waits for. */
  tasks?: BackgroundTask[];
  /** Why the turn failed, e.g. "rate limit". */
  error?: string;
  /** When the state last changed. */
  at: number;
}

/** Background work of an agent, as Claude Code lists it when a turn ends. */
export interface BackgroundTask {
  /** shell, monitor, subagent, workflow, MCP task…; scheduled for a wakeup. */
  type: string;
  /** What it runs, e.g. "Bash: npm run build" or a subagent's description. */
  text: string;
}

export interface TerminalState {
  id: string;
  /** Tab name set by the user; otherwise the tab shows the running program or directory. */
  name?: string;
  cwd: string;
  /** Last terminal size, reused when the terminal is restored. */
  cols: number;
  rows: number;
  /** Environment variables of the shell that differ from the daemon's environment. */
  env: Record<string, string>;
  job?: JobState;
  /** The running program printed output in the last few seconds. An agent that stays quiet is waiting for input. */
  busy?: boolean;
  /** Reported by the agent's hooks; exact where `busy` is a guess. */
  agent?: AgentState;
  pending?: PendingCommand;
  /** Pixels the user zoomed this terminal by, on top of the zoom of all terminals. */
  zoom?: number;
  /** Session files of the agents that ran in this tab, for its token usage. */
  agentSessions?: AgentSessionFile[];
}

/**
 * A tab that shows a file rather than running a shell: a document, data or an
 * image an agent prepared, rendered by its format and reloaded when it changes.
 */
export interface ViewerState {
  id: string;
  /** Absolute path of the file shown. */
  file: string;
  /**
   * Content an agent sent rather than a file of its own: Senju keeps it in a
   * folder of the viewer's (viewerDir) and deletes it with the viewer.
   */
  owned?: boolean;
  /** Tab name set by the agent or the user; otherwise the file's name. */
  name?: string;
  /** Format chosen by the agent, e.g. "markdown"; otherwise from the file's extension. */
  format?: string;
  /** Pixels the user zoomed the viewer by. */
  zoom?: number;
  /** Shown in a window of its own instead of a tab. */
  window?: boolean;
  /**
   * The terminal whose agent showed it: content it sends again under the same
   * name replaces this viewer's, and a viewer returning from its window goes
   * next to it when its old pane is gone.
   */
  source?: string;
  /** In a window of its own: the pane it was taken from, where it returns. */
  pane?: string;
}

export interface UiState {
  bounds?: { x: number; y: number; width: number; height: number; maximized: boolean };
  sidebarHidden?: boolean;
}

/** A window of the app: it shows the groups that name it, in the order of `AppState.groups`. */
export interface WindowState {
  id: string;
  activeWorkspaceId: string | null;
  ui: UiState;
}

export interface AppState {
  version: 3;
  /** Groups of every window, in sidebar order. */
  groups: GroupState[];
  /** Open windows; there is always at least one. */
  windows: WindowState[];
  terminals: Record<string, TerminalState>;
  /** Viewer tabs, and viewers shown in windows of their own. */
  viewers: Record<string, ViewerState>;
  /** Groups closed to disk, newest first. Sent to the UI only; the daemon reads them from their files. */
  closedGroups?: ClosedGroupInfo[];
  /** Context and tokens of each running agent, by terminal id. Sent to the UI only. */
  usage?: Record<string, AgentUsage>;
  /** What each running agent runs with, by terminal id. Sent to the UI only. */
  profiles?: Record<string, AgentProfile>;
}

/** A group closed to disk, as the UI lists it. */
export interface ClosedGroupInfo {
  id: string;
  name: string;
  cwd: string;
  workspaces: number;
  terminals: number;
  closedAt: number;
}

/**
 * A group saved to a file, when closed or exported: everything to bring it
 * back as after a reboot, at its place in the sidebar.
 */
export interface SavedGroup {
  format: 'senju-group';
  version: 1;
  savedAt: number;
  /** The group's place among the groups. */
  index: number;
  /** The workspace of the group that was active, if one was. */
  activeWorkspaceId: string | null;
  group: GroupState;
  terminals: Record<string, TerminalState>;
  /** Each terminal's scrollback, as saved for restarts. */
  scrollback: Record<string, string>;
  /** Viewers among the tabs; missing in files of older versions. */
  viewers?: Record<string, ViewerState>;
  /** Content of the viewers Senju keeps the file of, by viewer id. */
  viewerContent?: Record<string, string>;
}

export function emptyState(): AppState {
  return { version: 3, groups: [], windows: [], terminals: {}, viewers: {} };
}

/** What one window shows: its groups, with its active workspace and UI state. */
export interface WindowView extends AppState {
  windowId: string;
  activeWorkspaceId: string | null;
  ui: UiState;
}

/** The state as the window `windowId` shows it; the first window stands in for one that no longer exists. */
export function windowView(state: AppState, windowId: string): WindowView {
  const window = state.windows.find((w) => w.id === windowId) ?? state.windows[0];
  const id = window?.id ?? windowId;
  const groups = state.groups.filter((g) => g.windowId === id);
  const terminals: AppState['terminals'] = {};
  const viewers: AppState['viewers'] = {};
  for (const group of groups) {
    for (const workspace of group.workspaces) {
      for (const id of tabIds(workspace.root)) {
        if (state.terminals[id]) terminals[id] = state.terminals[id];
        else if (state.viewers?.[id]) viewers[id] = state.viewers[id];
      }
    }
  }
  return { ...state, groups, terminals, viewers, windowId: id, activeWorkspaceId: window?.activeWorkspaceId ?? null, ui: window?.ui ?? {} };
}
