// Context menus drawn by the app, so they share the theme, type and icons of
// the rest of the window. Keyboard: arrows move, Enter picks, Right opens a
// submenu, Left or Escape closes it.

import type { MenuItem } from '../shared/menu';
import { iconSvg } from './icons';

export type { MenuItem } from '../shared/menu';

interface Level {
  element: HTMLElement;
  items: MenuItem[];
  rows: HTMLElement[];
  active: number;
  parentRow?: HTMLElement;
}

let closeCurrent: ((value: string | null) => void) | null = null;

/** Shows a menu at a point, or below an element; resolves with the chosen id, or null. */
export function showMenu(items: MenuItem[], at: { x: number; y: number } | HTMLElement): Promise<string | null> {
  closeCurrent?.(null);
  const previousFocus = document.activeElement as HTMLElement | null;
  const levels: Level[] = [];

  return new Promise((resolve) => {
    const finish = (value: string | null) => {
      closeCurrent = null;
      for (const level of levels) level.element.remove();
      levels.length = 0;
      window.removeEventListener('mousedown', onOutside, true);
      window.removeEventListener('blur', onDismiss);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('keydown', onKey, true);
      previousFocus?.focus?.();
      resolve(value);
    };
    closeCurrent = finish;

    const onOutside = (e: MouseEvent) => {
      if (!levels.some((l) => l.element.contains(e.target as Node))) finish(null);
    };
    const onDismiss = () => finish(null);

    const setActive = (level: Level, index: number) => {
      level.rows.forEach((row, i) => row.classList.toggle('active', i === index));
      level.active = index;
    };

    const closeAfter = (depth: number) => {
      while (levels.length > depth + 1) {
        const level = levels.pop()!;
        level.parentRow?.classList.remove('open');
        level.element.remove();
      }
    };

    const openSubmenu = (depth: number, row: HTMLElement, item: MenuItem, focusFirst: boolean) => {
      closeAfter(depth);
      row.classList.add('open');
      const rect = row.getBoundingClientRect();
      const level = build(item.submenu ?? [], depth + 1);
      level.parentRow = row;
      place(level.element, { x: rect.right - 4, y: rect.top - 5 }, rect.left + 4);
      if (focusFirst) setActive(level, firstEnabled(level.items, 0, 1));
    };

    const pick = (depth: number, index: number) => {
      const level = levels[depth];
      const item = level?.items[index];
      if (!item || item.id === '-' || item.enabled === false) return;
      if (item.submenu) openSubmenu(depth, level.rows[index], item, true);
      else finish(item.id);
    };

    const build = (list: MenuItem[], depth: number): Level => {
      const element = document.createElement('div');
      element.className = 'menu';
      element.setAttribute('role', 'menu');
      const level: Level = { element, items: list, rows: [], active: -1 };
      list.forEach((item, index) => {
        if (item.id === '-') {
          const separator = document.createElement('div');
          separator.className = 'menu-separator';
          separator.setAttribute('role', 'separator');
          element.append(separator);
          level.rows.push(separator);
          return;
        }
        const row = document.createElement('div');
        row.className = `menu-item${item.enabled === false ? ' disabled' : ''}`;
        row.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
        if (item.checked !== undefined) row.setAttribute('aria-checked', String(item.checked));
        const mark = document.createElement('span');
        mark.className = 'menu-mark';
        if (item.color) {
          const swatch = document.createElement('span');
          swatch.className = 'menu-swatch';
          swatch.style.background = item.color;
          mark.append(swatch);
        } else if (item.checked) {
          mark.innerHTML = iconSvg('check', 14);
        }
        const label = document.createElement('span');
        label.className = 'menu-label';
        label.textContent = item.label;
        const side = document.createElement('span');
        side.className = 'menu-side';
        if (item.submenu) side.innerHTML = iconSvg('chevronRight', 14);
        else if (item.accelerator) side.textContent = item.accelerator;
        // A color item shows its swatch in front, so the current one is checked at the end.
        else if (item.color && item.checked) side.innerHTML = iconSvg('check', 14);
        row.append(mark, label, side);
        row.addEventListener('mouseenter', () => {
          setActive(level, index);
          if (item.submenu && item.enabled !== false) openSubmenu(depth, row, item, false);
          else closeAfter(depth);
        });
        row.addEventListener('click', () => pick(depth, index));
        element.append(row);
        level.rows.push(row);
      });
      document.body.append(element);
      levels.push(level);
      return level;
    };

    const onKey = (e: KeyboardEvent) => {
      const depth = levels.length - 1;
      const level = levels[depth];
      if (!level) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'ArrowDown') setActive(level, firstEnabled(level.items, level.active + 1, 1));
      else if (e.key === 'ArrowUp') setActive(level, firstEnabled(level.items, level.active < 0 ? level.items.length - 1 : level.active - 1, -1));
      else if (e.key === 'Enter' || e.key === ' ') pick(depth, level.active);
      else if (e.key === 'ArrowRight' && level.items[level.active]?.submenu) pick(depth, level.active);
      else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
        if (depth > 0) closeAfter(depth - 1);
        else finish(null);
      }
    };

    const root = build(items, 0);
    if (at instanceof HTMLElement) {
      const rect = at.getBoundingClientRect();
      place(root.element, { x: rect.left, y: rect.bottom + 4 });
    } else {
      place(root.element, at);
    }
    // Defer, so the click that opened the menu does not close it.
    setTimeout(() => {
      window.addEventListener('mousedown', onOutside, true);
      window.addEventListener('blur', onDismiss);
      window.addEventListener('resize', onDismiss);
    });
    window.addEventListener('keydown', onKey, true);
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
}

function firstEnabled(items: MenuItem[], from: number, step: 1 | -1): number {
  const n = items.length;
  for (let i = 0; i < n; i++) {
    const index = (((from + step * i) % n) + n) % n;
    const item = items[index];
    if (item.id !== '-' && item.enabled !== false) return index;
  }
  return -1;
}

/** Positions a menu at a point, flipping it to stay inside the window. */
function place(element: HTMLElement, point: { x: number; y: number }, flipX?: number): void {
  const { width, height } = element.getBoundingClientRect();
  const margin = 6;
  let x = point.x;
  let y = point.y;
  if (x + width > window.innerWidth - margin) x = flipX !== undefined ? flipX - width : window.innerWidth - margin - width;
  if (y + height > window.innerHeight - margin) y = Math.max(margin, window.innerHeight - margin - height);
  element.style.left = `${Math.max(margin, x)}px`;
  element.style.top = `${Math.max(margin, y)}px`;
}
