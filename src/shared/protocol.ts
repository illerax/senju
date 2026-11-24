// Messages exchanged between the UI and the daemon over a local socket as
// newline-delimited JSON.

import type { AppState, UiState } from './types';
import type { UsageDetails } from './usage';
import type { ViewerContent } from './viewer';

/** Bump when messages change incompatibly; a UI replaces a daemon with another version. */
export const PROTOCOL_VERSION = 4;

export type SplitSide = 'left' | 'right' | 'up' | 'down';

export type Action =
  | { type: 'createGroup'; name: string; cwd: string; windowId: string }
  | { type: 'renameGroup'; groupId: string; name: string }
  /** Sets the directory new workspaces of the group start in. */
  | { type: 'setGroupCwd'; groupId: string; cwd: string }
  | { type: 'deleteGroup'; groupId: string }
  /** Saves the group with its terminals to disk, then closes it; reopenGroup brings it back. */
  | { type: 'closeGroup'; groupId: string }
  | { type: 'reopenGroup'; closedId: string; windowId: string }
  | { type: 'forgetClosedGroup'; closedId: string }
  /** Saves the group to a file the user chose, keeping it open. */
  | { type: 'exportGroup'; groupId: string; file: string }
  /** Opens a group saved to a file, as a new group. */
  | { type: 'importGroup'; file: string; windowId: string }
  /** Moves a group to a position among the groups of all windows. */
  | { type: 'moveGroup'; groupId: string; toIndex: number }
  /** Moves a group to the end of another window's sidebar and shows it there. */
  | { type: 'moveGroupToWindow'; groupId: string; windowId: string }
  /** Adds a window, optionally taking a group from another window. */
  | { type: 'createWindow'; windowId: string; groupId?: string }
  /** Removes a window; its groups move to the end of the window `into`. The last window is kept. */
  | { type: 'closeWindow'; windowId: string; into: string }
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
  // Tab actions name a terminal or a viewer by `terminalId`.
  | { type: 'closeTab'; terminalId: string }
  | { type: 'activateTab'; terminalId: string }
  | { type: 'renameTab'; terminalId: string; name: string }
  | { type: 'zoomTab'; terminalId: string; zoom: number }
  /** Moves a tab to a position in a pane, possibly another one. */
  | { type: 'moveTab'; terminalId: string; paneId: string; toIndex: number }
  /** Opens a file the user picked in a viewer tab of a pane. */
  | { type: 'openViewer'; paneId: string; file: string }
  /** Moves a viewer from its tab to a window of its own. */
  | { type: 'popOutViewer'; viewerId: string }
  /** Closes a viewer shown in a window of its own. */
  | { type: 'closeViewer'; viewerId: string }
  | { type: 'runPending'; terminalId: string }
  | { type: 'dismissPending'; terminalId: string }
  | { type: 'setUi'; windowId: string; ui: UiState };

export type ClientMessage =
  | { type: 'hello'; protocol: number }
  | { type: 'action'; action: Action }
  | { type: 'attach'; terminalId: string }
  | { type: 'input'; terminalId: string; data: string }
  | { type: 'resize'; terminalId: string; cols: number; rows: number }
  /** Asks for the last lines on the screen of some terminals, as plain text. */
  | { type: 'peek'; terminalIds: string[]; lines: number }
  /** Asks for the usage window of an agent: what fills its context and what it used. */
  | { type: 'usage'; terminalId: string }
  /**
   * From the `senju` command or its MCP server in a terminal: shows a file, or
   * content without one, in a viewer next to that terminal. Answered with
   * `shown` or `error`, and sent without a hello, so it names its protocol.
   */
  | { type: 'show'; protocol: number; terminalId: string; file?: string; content?: string; format?: string; name?: string; window?: boolean }
  /** Asks for a viewer's file; `known` is the mtime the window has, answered with no content when it is still current. */
  | { type: 'readViewer'; viewerId: string; known?: number }
  /** Saves state and stops the daemon together with all terminal processes; they are restored on next start. */
  | { type: 'shutdown' };

export type DaemonMessage =
  | { type: 'hello'; protocol: number; pid: number; build: string }
  | { type: 'state'; state: AppState }
  | { type: 'snapshot'; terminalId: string; data: string }
  | { type: 'data'; terminalId: string; data: string }
  /** The last non-empty lines on each terminal's screen. */
  | { type: 'peek'; screens: Record<string, string[]> }
  /** The usage window of an agent, or null when its sessions can't be read. */
  | { type: 'usage'; terminalId: string; details: UsageDetails | null }
  | { type: 'shown'; viewerId: string }
  /** A viewer's file; no content when it has not changed since `known`. */
  | { type: 'viewer'; viewerId: string; content?: ViewerContent }
  | { type: 'error'; message: string };
