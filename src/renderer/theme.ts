// The colors of a theme as CSS variables, which every color of the window
// derives from (styles.css).

import { isLight, type Theme } from '../shared/themes';

export function applyTheme(theme: Theme): void {
  const root = document.documentElement.style;
  const light = isLight(theme.background);
  root.setProperty('--bg', theme.background);
  root.setProperty('--fg', theme.foreground);
  root.setProperty('--link', theme.blue);
  root.setProperty('--waiting', theme.red);
  root.setProperty('--done', theme.green);
  // Syntax colors of viewers.
  for (const name of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) root.setProperty(`--ansi-${name}`, theme[name]);
  root.setProperty('color-scheme', light ? 'light' : 'dark');
  document.body.classList.toggle('light', light);
}
