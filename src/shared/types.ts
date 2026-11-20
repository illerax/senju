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

/**
 * What an agent reports through its hooks (Claude Code). Agents without hooks
 * have only `busy`, guessed from their output.
 */
export interface AgentState {
  /**
   * working: on a task; permission: asks to allow a tool; question: asks the
   * user something; done: finished its turn; waiting: stopped without saying
   * why, e.g. interrupted; error: the turn failed; ended: the session is over
   * and the program is exiting.
   */
  state: 'working' | 'permission' | 'question' | 'done' | 'waiting' | 'error' | 'ended';
  /** The tool call in progress or waiting for permission, e.g. "Bash: npm test". */
  activity?: string;
  /** Why the turn failed, e.g. "rate limit". */
  error?: string;
  /** When the state last changed. */
  at: number;
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
  /** Groups closed to disk, newest first. Sent to the UI only; the daemon reads them from their files. */
  closedGroups?: ClosedGroupInfo[];
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
}

export function emptyState(): AppState {
  return { version: 2, groups: [], activeWorkspaceId: null, terminals: {}, ui: {} };
}
