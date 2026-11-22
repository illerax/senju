import fs from 'node:fs';
import type { NeedReason } from './agent-status';
import type { Command } from './commands';
import { paths } from './paths';
import { builtinThemes, defaultFont, defaultThemeName, type Font, type Theme } from './themes';

export { resolveFont, resolveTheme, type Font, type Theme } from './themes';

/** Settings; the font fields are the default font, used by themes without their own. */
export interface Settings extends Font {
  /** Name of a built-in theme or of one in `themes`. */
  theme: string;
  /** User-defined themes by name. */
  themes: Record<string, Theme>;
  /** Shortcuts that differ from the defaults; an empty list unbinds a command. */
  keybindings: Partial<Record<Command, string[]>>;
  /** Shell executable; defaults to $SHELL (or PowerShell on Windows). */
  shell: string | null;
  shellArgs: string[] | null;
  /** Lines kept in memory per pane. */
  scrollback: number;
  /** Lines saved to disk per pane and restored after a reboot. */
  persistedScrollback: number;
  /**
   * Regular expressions matched against a command line. Matching commands are
   * started again automatically after a reboot; others get a "Run again" button.
   */
  autoRestart: string[];
  copyOnSelect: boolean;
  /** Look for new releases at start and every few hours; installing always asks first. */
  checkForUpdates: boolean;
  /** Pixels added to the font size of every terminal by zooming; 0 is the font's own size. */
  zoom: number;
  /** A system notification when an agent the user is not looking at needs them. */
  notifications: boolean;
  /** Which reasons to notify about; missing ones are on. */
  notifyOn: Record<NeedReason, boolean>;
}

export const defaultSettings: Settings = {
  ...defaultFont,
  theme: defaultThemeName,
  themes: {},
  keybindings: {},
  shell: null,
  shellArgs: null,
  scrollback: 10000,
  persistedScrollback: 5000,
  autoRestart: [
    '^(npm|pnpm|yarn|bun) (run )?(dev|start|serve|watch)\\b',
    '^(npx |pnpm (exec |dlx )?|bunx )?(vite|next dev|nuxt dev|astro dev|webpack serve)\\b',
    '^tail -[fF]\\b',
    '^journalctl\\b.* -f\\b',
    '^(docker|podman) compose( \\S+)* (logs -f|up)\\b',
    '^kubectl logs\\b.* -f\\b',
    '^(top|htop|btop|watch)\\b',
  ],
  copyOnSelect: false,
  checkForUpdates: true,
  zoom: 0,
  notifications: true,
  notifyOn: { permission: true, question: true, finished: true, failed: true, input: true },
};

function readUserSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Missing or invalid file: use defaults.
    return {};
  }
}

/** Reads the settings file, falling back to defaults for anything missing or invalid. */
export function loadSettings(): Settings {
  const user = readUserSettings() as Partial<Settings> & { theme?: unknown };
  const settings: Settings = { ...defaultSettings, ...user, theme: defaultThemeName, themes: { ...(user.themes ?? {}) }, keybindings: { ...(user.keybindings ?? {}) }, notifyOn: { ...defaultSettings.notifyOn, ...(user.notifyOn ?? {}) } };
  if (typeof user.theme === 'string') {
    settings.theme = user.theme;
  } else if (user.theme && typeof user.theme === 'object') {
    // Older settings held the colors themselves.
    settings.themes.Custom = { ...builtinThemes[defaultThemeName], ...(user.theme as Partial<Theme>) };
    settings.theme = 'Custom';
  }
  return settings;
}

/** Stores changed settings; keys equal to their default are dropped, so the file holds only what the user chose. */
export function saveSettings(patch: Partial<Settings>): Settings {
  const user = readUserSettings();
  for (const [key, value] of Object.entries(patch)) {
    const fallback = (defaultSettings as unknown as Record<string, unknown>)[key];
    if (value === undefined || JSON.stringify(value) === JSON.stringify(fallback)) delete user[key];
    else user[key] = value;
  }
  fs.mkdirSync(paths.configDir, { recursive: true });
  const tmp = `${paths.settingsFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(user, null, 2)}\n`);
  fs.renameSync(tmp, paths.settingsFile);
  return loadSettings();
}
