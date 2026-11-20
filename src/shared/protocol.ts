// Messages exchanged between the UI and the daemon over a local socket as
// newline-delimited JSON.

import type { AppState, UiState } from './types';

/** Bump when messages change incompatibly; a UI replaces a daemon with another version. */
export const PROTOCOL_VERSION = 2;

export type SplitSide = 'left' | 'right' | 'up' | 'down';

export type Action =
  | { type: 'createGroup'; name: string; cwd: string }
  | { type: 'renameGroup'; groupId: string; name: string }
  /** Sets the directory new workspaces of the group start in. */
  | { type: 'setGroupCwd'; groupId: string; cwd: string }
  | { type: 'deleteGroup'; groupId: string }
  /** Saves the group with its terminals to disk, then closes it; reopenGroup brings it back. */
  | { type: 'closeGroup'; groupId: string }
  | { type: 'reopenGroup'; closedId: string }
  | { type: 'forgetClosedGroup'; closedId: string }
  /** Saves the group to a file the user chose, keeping it open. */
  | { type: 'exportGroup'; groupId: string; file: string }
  /** Opens a group saved to a file, as a new group. */
  | { type: 'importGroup'; file: string }
  | { type: 'moveGroup'; groupId: string; toIndex: number }
  | { type: 'setGroupCollapsed'; groupId: string; collapsed: boolean }
  | { type: 'createWorkspace'; groupId: string }
  | { type: 'renameWorkspace'; workspaceId: string; name: string }
  | { type: 'closeWorkspace'; workspaceId: string }
  | { type: 'setWorkspaceColor'; workspaceId: string; color: string | null }
  /** Moves a workspace to a position in a group, possibly another one. */
  | { type: 'moveWorkspace'; workspaceId: string; groupId: string; toIndex: number }
  | { type: 'activateWorkspace'; workspaceId: string }
  | { type: 'splitPane'; paneId: string; side: SplitSide }
  | { type: 'closePane'; paneId: string }
  | { type: 'focusPane'; paneId: string }
  | { type: 'resizeSplit'; splitId: string; sizes: number[] }
  | { type: 'createTab'; paneId: string }
  | { type: 'closeTab'; terminalId: string }
  | { type: 'activateTab'; terminalId: string }
  | { type: 'renameTab'; terminalId: string; name: string }
  | { type: 'zoomTab'; terminalId: string; zoom: number }
  /** Moves a tab to a position in a pane, possibly another one. */
  | { type: 'moveTab'; terminalId: string; paneId: string; toIndex: number }
  | { type: 'runPending'; terminalId: string }
  | { type: 'dismissPending'; terminalId: string }
  | { type: 'setUi'; ui: UiState };

export type ClientMessage =
  | { type: 'hello'; protocol: number }
  | { type: 'action'; action: Action }
  | { type: 'attach'; terminalId: string }
  | { type: 'input'; terminalId: string; data: string }
  | { type: 'resize'; terminalId: string; cols: number; rows: number }
  /** Asks for the last lines on the screen of some terminals, as plain text. */
  | { type: 'peek'; terminalIds: string[]; lines: number }
  /** Saves state and stops the daemon together with all terminal processes; they are restored on next start. */
  | { type: 'shutdown' };

export type DaemonMessage =
  | { type: 'hello'; protocol: number; pid: number; build: string }
  | { type: 'state'; state: AppState }
  | { type: 'snapshot'; terminalId: string; data: string }
  | { type: 'data'; terminalId: string; data: string }
  /** The last non-empty lines on each terminal's screen. */
  | { type: 'peek'; screens: Record<string, string[]> }
  | { type: 'error'; message: string };
