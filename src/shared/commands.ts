// Application commands, their default shortcuts and how they are listed in
// the settings. Shortcuts are written as accelerators like "Ctrl+Shift+T".
//
// Defaults on Linux and Windows use Ctrl+Shift (or Ctrl+Tab), which programs
// in a terminal cannot receive as distinct keys, so nothing a program relies
// on is taken away. macOS uses Cmd.

export const commandCategories = ['Groups', 'Workspaces', 'Panes', 'Tabs', 'Clipboard', 'Window'] as const;
export type CommandCategory = (typeof commandCategories)[number];

interface CommandInfo {
  label: string;
  category: CommandCategory;
  linux: string[];
  mac: string[];
}

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
  nextWorkspace: { label: 'Next workspace in the group', category: 'Workspaces', linux: ['Ctrl+Shift+PageDown'], mac: ['Cmd+Shift+Down'] },
  prevWorkspace: { label: 'Previous workspace in the group', category: 'Workspaces', linux: ['Ctrl+Shift+PageUp'], mac: ['Cmd+Shift+Up'] },

  splitRight: { label: 'Split right', category: 'Panes', linux: ['Ctrl+Shift+D'], mac: ['Cmd+D'] },
  splitDown: { label: 'Split down', category: 'Panes', linux: ['Ctrl+Shift+E'], mac: ['Cmd+Shift+D'] },
  closePane: { label: 'Close pane with its tabs', category: 'Panes', linux: ['Ctrl+Shift+X'], mac: ['Cmd+Shift+W'] },
  nextPane: { label: 'Next pane', category: 'Panes', linux: ['Ctrl+Shift+]'], mac: ['Cmd+]'] },
  prevPane: { label: 'Previous pane', category: 'Panes', linux: ['Ctrl+Shift+['], mac: ['Cmd+['] },
  focusLeft: { label: 'Focus pane on the left', category: 'Panes', linux: ['Ctrl+Shift+Left'], mac: ['Cmd+Alt+Left'] },
  focusRight: { label: 'Focus pane on the right', category: 'Panes', linux: ['Ctrl+Shift+Right'], mac: ['Cmd+Alt+Right'] },
  focusUp: { label: 'Focus pane above', category: 'Panes', linux: ['Ctrl+Shift+Up'], mac: ['Cmd+Alt+Up'] },
  focusDown: { label: 'Focus pane below', category: 'Panes', linux: ['Ctrl+Shift+Down'], mac: ['Cmd+Alt+Down'] },

  newTab: { label: 'New terminal tab', category: 'Tabs', linux: ['Ctrl+Shift+T'], mac: ['Cmd+T'] },
  closeTab: { label: 'Close terminal tab', category: 'Tabs', linux: ['Ctrl+Shift+W'], mac: ['Cmd+W'] },
  renameTab: { label: 'Rename tab', category: 'Tabs', linux: ['Ctrl+Shift+R'], mac: ['Cmd+Shift+R'] },
  nextTab: { label: 'Next tab', category: 'Tabs', linux: ['Ctrl+Tab'], mac: ['Ctrl+Tab', 'Cmd+Shift+]'] },
  prevTab: { label: 'Previous tab', category: 'Tabs', linux: ['Ctrl+Shift+Tab'], mac: ['Ctrl+Shift+Tab', 'Cmd+Shift+['] },
  ...tabCommands,

  copy: { label: 'Copy', category: 'Clipboard', linux: ['Ctrl+Shift+C'], mac: ['Cmd+C'] },
  paste: { label: 'Paste', category: 'Clipboard', linux: ['Ctrl+Shift+V', 'Shift+Insert'], mac: ['Cmd+V'] },

  toggleSidebar: { label: 'Show or hide the sidebar', category: 'Window', linux: ['Ctrl+Shift+B'], mac: ['Cmd+B'] },
  openSettings: { label: 'Open settings', category: 'Window', linux: ['Ctrl+Shift+,'], mac: ['Cmd+,'] },
} satisfies Record<string, CommandInfo>;

export type Command = keyof typeof commands;

export const commandIds = Object.keys(commands) as Command[];

export function defaultBindings(command: Command, platform: string): string[] {
  const info: CommandInfo = commands[command];
  return platform === 'darwin' ? info.mac : info.linux;
}
