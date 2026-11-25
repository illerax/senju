// Where a group or a tab can move: a new window, or another window of the
// app, named by its groups.

import type { MenuItem } from '../shared/menu';
import type { AppState } from '../shared/types';

/** The submenu of "Move to Window"; ids are `window:new` and `window:<id>`. `current` is left out. */
export function windowChoices(shared: AppState, current?: string): MenuItem[] {
  const others = shared.windows.filter((w) => w.id !== current);
  return [
    { id: 'window:new', label: 'New Window' },
    ...(others.length ? [{ id: '-', label: '' }] : []),
    ...others.map((w, i) => {
      const names = shared.groups.filter((g) => g.windowId === w.id).map((g) => g.name);
      return { id: `window:${w.id}`, label: names.length ? truncate(names.join(', '), 48) : `Empty window ${i + 1}` };
    }),
  ];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
