// Application commands, their default shortcuts and how they are listed in
// the settings. Shortcuts are written as accelerators like "Ctrl+Shift+T".
//
// Defaults on Linux and Windows use Ctrl+Shift (or Ctrl+Tab), which programs
// in a terminal cannot receive as distinct keys, so nothing a program relies
// on is taken away. macOS uses Cmd.
//
// Copy mode keys apply only while a terminal is in copy mode, where nothing
// reaches the program, so they are plain keys.

export const commandCategories = ['Groups', 'Workspaces', 'Panes', 'Tabs', 'Clipboard', 'Window', 'Copy mode'] as const;
export type CommandCategory = (typeof commandCategories)[number];

/** Where a shortcut works: everywhere in the window, or in a terminal in copy mode. */
export type CommandScope = 'app' | 'copyMode';

interface CommandInfo {
  label: string;
  category: CommandCategory;
  linux: string[];
  mac: string[];
}

/** A copy mode key, the same on every platform. */
const copyKey = (label: string, ...keys: string[]): CommandInfo => ({ label, category: 'Copy mode', linux: keys, mac: keys });

const tabCommands = Object.fromEntries(
  Array.from({ length: 9 }, (_, i) => [
    `tab${i + 1}`,
    { label: `Go to tab ${i + 1}`, category: 'Tabs', linux: [`Ctrl+Shift+${i + 1}`], mac: [`Cmd+${i + 1}`] },
  ]),
) as Record<`tab${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`, CommandInfo>;

export const commands = {
  newGroup: { label: 'New group', category: 'Groups', linux: ['Ctrl+Shift+G'], mac: ['Cmd+Shift+N'] },
  nextGroup: { label: 'Next group', category: 'Groups', linux: ['Ctrl+Shift+End'], mac: ['Cmd+Ctrl+Down'] },
  prevGroup: { label: 'Previous group', category: 'Groups', linux: ['Ctrl+Shift+Home'], mac: ['Cmd+Ctrl+Up'] },

  newWorkspace: { label: 'New workspace', category: 'Workspaces', linux: ['Ctrl+Shift+N'], mac: ['Cmd+N'] },
  closeWorkspace: { label: 'Close workspace', category: 'Workspaces', linux: [], mac: [] },
  nextWorkspace: { label: 'Next workspace', category: 'Workspaces', linux: ['Ctrl+Shift+PageDown'], mac: ['Cmd+Shift+Down'] },
  prevWorkspace: { label: 'Previous workspace', category: 'Workspaces', linux: ['Ctrl+Shift+PageUp'], mac: ['Cmd+Shift+Up'] },
  moveWorkspaceDown: { label: 'Move workspace down', category: 'Workspaces', linux: ['Ctrl+Alt+Shift+PageDown'], mac: ['Cmd+Alt+Shift+Down'] },
  moveWorkspaceUp: { label: 'Move workspace up', category: 'Workspaces', linux: ['Ctrl+Alt+Shift+PageUp'], mac: ['Cmd+Alt+Shift+Up'] },

  splitRight: { label: 'Split right', category: 'Panes', linux: ['Ctrl+Shift+D'], mac: ['Cmd+D'] },
  splitDown: { label: 'Split down', category: 'Panes', linux: ['Ctrl+Shift+E'], mac: ['Cmd+Shift+D'] },
  closePane: { label: 'Close pane with its tabs', category: 'Panes', linux: ['Ctrl+Shift+X'], mac: ['Cmd+Shift+W'] },
  nextPane: { label: 'Next pane', category: 'Panes', linux: ['Ctrl+Shift+]'], mac: ['Cmd+]'] },
  prevPane: { label: 'Previous pane', category: 'Panes', linux: ['Ctrl+Shift+['], mac: ['Cmd+['] },
  toggleMaximize: { label: 'Maximize or restore the pane', category: 'Panes', linux: ['Ctrl+Shift+Enter'], mac: ['Cmd+Shift+Enter'] },
  focusLeft: { label: 'Focus pane on the left', category: 'Panes', linux: ['Ctrl+Shift+Left'], mac: ['Cmd+Alt+Left'] },
  focusRight: { label: 'Focus pane on the right', category: 'Panes', linux: ['Ctrl+Shift+Right'], mac: ['Cmd+Alt+Right'] },
  focusUp: { label: 'Focus pane above', category: 'Panes', linux: ['Ctrl+Shift+Up'], mac: ['Cmd+Alt+Up'] },
  focusDown: { label: 'Focus pane below', category: 'Panes', linux: ['Ctrl+Shift+Down'], mac: ['Cmd+Alt+Down'] },

  nextAttention: { label: 'Go to the agent waiting longest, then the next', category: 'Tabs', linux: ['Ctrl+Shift+J'], mac: ['Cmd+J'] },
  newTab: { label: 'New terminal tab', category: 'Tabs', linux: ['Ctrl+Shift+T'], mac: ['Cmd+T'] },
  closeTab: { label: 'Close tab', category: 'Tabs', linux: ['Ctrl+Shift+W'], mac: ['Cmd+W'] },
  openFile: { label: 'Open a file in a viewer tab', category: 'Tabs', linux: ['Ctrl+Shift+P'], mac: ['Cmd+O'] },
  renameTab: { label: 'Rename tab', category: 'Tabs', linux: ['Ctrl+Shift+R'], mac: ['Cmd+Shift+R'] },
  nextTab: { label: 'Next tab', category: 'Tabs', linux: ['Ctrl+Tab'], mac: ['Ctrl+Tab', 'Cmd+Shift+]'] },
  prevTab: { label: 'Previous tab', category: 'Tabs', linux: ['Ctrl+Shift+Tab'], mac: ['Ctrl+Shift+Tab', 'Cmd+Shift+['] },
  ...tabCommands,
  find: { label: 'Find in the terminal', category: 'Tabs', linux: ['Ctrl+Shift+F'], mac: ['Cmd+F'] },
  showUsage: { label: "Show the agent's context and tokens", category: 'Tabs', linux: ['Ctrl+Shift+K'], mac: ['Cmd+Shift+K'] },

  copy: { label: 'Copy', category: 'Clipboard', linux: ['Ctrl+Shift+C'], mac: ['Cmd+C'] },
  paste: { label: 'Paste', category: 'Clipboard', linux: ['Ctrl+Shift+V', 'Shift+Insert'], mac: ['Cmd+V'] },
  copyMode: { label: 'Copy mode: select and copy text with the keyboard', category: 'Clipboard', linux: ['Ctrl+Shift+Y', 'Ctrl+Shift+Space'], mac: ['Cmd+Shift+Space'] },

  newWindow: { label: 'New window', category: 'Window', linux: ['Ctrl+Shift+O'], mac: ['Cmd+Shift+O'] },
  toggleSidebar: { label: 'Show or hide the sidebar', category: 'Window', linux: ['Ctrl+Shift+B'], mac: ['Cmd+B'] },
  toggleOverview: { label: 'Show or hide all agents', category: 'Window', linux: ['Ctrl+Shift+A'], mac: ['Cmd+Shift+A'] },
  openSettings: { label: 'Open settings', category: 'Window', linux: ['Ctrl+Shift+,'], mac: ['Cmd+,'] },
  zoomIn: { label: 'Zoom in the tab', category: 'Window', linux: ['Ctrl+Shift+='], mac: ['Cmd+='] },
  zoomOut: { label: 'Zoom out the tab', category: 'Window', linux: ['Ctrl+Shift+-'], mac: ['Cmd+-'] },
  resetZoom: { label: 'Reset the zoom of the tab', category: 'Window', linux: ['Ctrl+Shift+0'], mac: ['Cmd+0'] },
  zoomInAll: { label: 'Zoom in all terminals', category: 'Window', linux: ['Ctrl+Alt+Shift+='], mac: ['Cmd+Alt+='] },
  zoomOutAll: { label: 'Zoom out all terminals', category: 'Window', linux: ['Ctrl+Alt+Shift+-'], mac: ['Cmd+Alt+-'] },
  resetZoomAll: { label: 'Reset the zoom of all terminals', category: 'Window', linux: ['Ctrl+Alt+Shift+0'], mac: ['Cmd+Alt+0'] },

  copyModeLeft: copyKey('Move left', 'H', 'Left'),
  copyModeDown: copyKey('Move down', 'J', 'Down'),
  copyModeUp: copyKey('Move up', 'K', 'Up'),
  copyModeRight: copyKey('Move right', 'L', 'Right'),
  copyModeWordForward: copyKey('Next word', 'W'),
  copyModeWordBack: copyKey('Previous word', 'B'),
  copyModeLineStart: copyKey('Start of the line', '0', 'Home'),
  copyModeLineEnd: copyKey('End of the line', 'Shift+4', 'End'),
  copyModePageUp: copyKey('Page up', 'PageUp', 'Ctrl+B'),
  copyModePageDown: copyKey('Page down', 'PageDown', 'Ctrl+F'),
  copyModeTop: copyKey('Top of the scrollback', 'G', 'Ctrl+Home'),
  copyModeBottom: copyKey('Bottom', 'Shift+G', 'Ctrl+End'),
  copyModeSelect: copyKey('Start or stop selecting', 'V', 'Space'),
  copyModeSelectLines: copyKey('Select whole lines', 'Shift+V'),
  copyModeFind: copyKey('Find', '/'),
  copyModeFindNext: copyKey('Next match', 'N'),
  copyModeFindPrevious: copyKey('Previous match', 'Shift+N'),
  copyModeCopy: copyKey('Copy the selection, or the line without one, and exit', 'Y', 'Enter'),
  copyModeExit: copyKey('Exit copy mode', 'Escape', 'Q'),
} satisfies Record<string, CommandInfo>;

export type Command = keyof typeof commands;

export const commandIds = Object.keys(commands) as Command[];

export function commandScope(command: Command): CommandScope {
  return commands[command].category === 'Copy mode' ? 'copyMode' : 'app';
}

export function defaultBindings(command: Command, platform: string): string[] {
  const info: CommandInfo = commands[command];
  return platform === 'darwin' ? info.mac : info.linux;
}
