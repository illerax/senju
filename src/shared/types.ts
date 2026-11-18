// Persistent workspace state. The daemon is the single owner and writer of this
// structure; the UI only renders it and sends actions.
//
// A group (a project) holds workspaces. A workspace is split into panes, and
// each pane holds tabs, one terminal per tab.

export type SplitDirection = 'row' | 'column';

export interface PaneNode {
  type: 'pane';
  id: string;
  /** Terminal ids, in tab order. */
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
}

export interface GroupState {
  id: string;
  name: string;
  /** Directory new workspaces of the group start in. */
  cwd: string;
  workspaces: WorkspaceState[];
  /** Whether the sidebar hides the group's workspaces. */
  collapsed: boolean;
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
  pending?: PendingCommand;
}

export interface UiState {
  bounds?: { x: number; y: number; width: number; height: number; maximized: boolean };
  sidebarHidden?: boolean;
}

export interface AppState {
  version: 2;
  groups: GroupState[];
  activeWorkspaceId: string | null;
  terminals: Record<string, TerminalState>;
  ui: UiState;
}

export function emptyState(): AppState {
  return { version: 2, groups: [], activeWorkspaceId: null, terminals: {}, ui: {} };
}
