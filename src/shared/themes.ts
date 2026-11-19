// Terminal color themes. The UI chrome is derived from a theme's background,
// foreground and blue, so every theme styles the whole window.

/** Terminal font settings. In a theme every field is optional and falls back to the default font. */
export interface Font {
  fontFamily: string;
  fontSize: number;
  /** CSS weight: 100–900. */
  fontWeight: number;
  lineHeight: number;
}

export const defaultFont: Font = {
  fontFamily: "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', Menlo, Consolas, monospace",
  fontSize: 13,
  fontWeight: 400,
  lineHeight: 1,
};

export interface Theme {
  /** The theme's own font; anything missing comes from the default font. */
  font?: Partial<Font>;
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** The color fields of a theme. */
export type ThemeColor = Exclude<keyof Theme, 'font'>;

export const themeKeys: ThemeColor[] = [
  'background',
  'foreground',
  'cursor',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

/** Builds a theme from the base colors and the 16 ANSI colors in order. */
function theme(background: string, foreground: string, cursor: string, selectionBackground: string, ansi: string[]): Theme {
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = ansi;
  return {
    background,
    foreground,
    cursor,
    selectionBackground,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
}

const solarizedAnsi = ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#586e75', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'];

export const builtinThemes: Record<string, Theme> = {
  'Senju Dark': theme('#16181d', '#d4d7de', '#e6c07b', '#3a4150', [
    '#1e2127', '#e06c75', '#98c379', '#d19a66', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
    '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff',
  ]),
  'Tokyo Night': theme('#1a1b26', '#c0caf5', '#c0caf5', '#33467c', [
    '#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
    '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5',
  ]),
  'Catppuccin Mocha': theme('#1e1e2e', '#cdd6f4', '#f5e0dc', '#45475a', [
    '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
    '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8',
  ]),
  Dracula: theme('#282a36', '#f8f8f2', '#f8f8f2', '#44475a', [
    '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
    '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff',
  ]),
  Nord: theme('#2e3440', '#d8dee9', '#d8dee9', '#434c5e', [
    '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
    '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4',
  ]),
  'Gruvbox Dark': theme('#282828', '#ebdbb2', '#ebdbb2', '#504945', [
    '#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
    '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2',
  ]),
  'Solarized Dark': theme('#002b36', '#839496', '#93a1a1', '#073642', solarizedAnsi),
  'Solarized Light': theme('#fdf6e3', '#657b83', '#586e75', '#eee8d5', solarizedAnsi),
  'GitHub Light': theme('#ffffff', '#1f2328', '#0969da', '#add6ff', [
    '#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781',
    '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f',
  ]),
};

export const defaultThemeName = 'Senju Dark';

/** Whether a background is light, for choosing the UI's color scheme. */
export function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}

/** The colors of the selected theme: a custom one, a built-in one, or the default. */
export function resolveTheme(settings: { theme: string; themes: Record<string, Theme> }): Theme {
  const theme = settings.themes[settings.theme] ?? builtinThemes[settings.theme] ?? builtinThemes[defaultThemeName];
  return { ...builtinThemes[defaultThemeName], ...theme };
}

/** The font of the selected theme: its own font settings over the default font. */
export function resolveFont(settings: { theme: string; themes: Record<string, Theme> } & Font): Font {
  const own = resolveTheme(settings).font ?? {};
  const pick = <K extends keyof Font>(key: K): Font[K] => {
    const value = own[key];
    return value === undefined || value === '' ? settings[key] : (value as Font[K]);
  };
  return { fontFamily: pick('fontFamily'), fontSize: pick('fontSize'), fontWeight: pick('fontWeight'), lineHeight: pick('lineHeight') };
}

/** Font sizes zooming stays within, the same as the settings allow. */
const minFontSize = 6;
const maxFontSize = 40;

type ZoomSettings = Parameters<typeof resolveFont>[0] & { zoom: number };

/** The zoom kept within the font size bounds of the current font. */
export function clampZoom(settings: ZoomSettings, zoom: number): number {
  const base = resolveFont(settings).fontSize;
  const steps = Number.isFinite(zoom) ? Math.round(zoom) : 0;
  return Math.min(maxFontSize, Math.max(minFontSize, base + steps)) - base;
}

/** The font of the terminals: the current font with the zoom added to its size. */
export function terminalFont(settings: ZoomSettings): Font {
  const font = resolveFont(settings);
  return { ...font, fontSize: font.fontSize + clampZoom(settings, settings.zoom) };
}

/** The zoom as a percentage of the font's own size. */
export function zoomPercent(settings: ZoomSettings): number {
  const base = resolveFont(settings).fontSize;
  return Math.round(((base + clampZoom(settings, settings.zoom)) / base) * 100);
}
