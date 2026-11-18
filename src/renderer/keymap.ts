// Matches key events against the shortcuts: defaults from shared/commands,
// overridden by the user's settings. Shortcuts are accelerators like
// "Ctrl+Shift+T", resolved by physical key so keyboard layouts do not matter.

import { commandIds, defaultBindings, type Command } from '../shared/commands';
import type { Settings } from '../shared/settings';

export type { Command } from '../shared/commands';

interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  code: string;
}

/** Key names in accelerators and the KeyboardEvent.code they stand for. */
const namedKeys: Record<string, string> = {
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Escape',
  Space: 'Space',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '\\': 'Backslash',
};
const codeNames = Object.fromEntries(Object.entries(namedKeys).map(([name, code]) => [code, name]));

function keyToCode(key: string): string | null {
  if (/^[A-Z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  return namedKeys[key] ?? null;
}

function codeToKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return codeNames[code] ?? null;
}

export function parseAccelerator(accelerator: string): Chord | null {
  const parts = accelerator.split('+').map((p) => p.trim());
  const key = parts.pop();
  if (!key) return null;
  const chord: Chord = { ctrl: false, shift: false, alt: false, meta: false, code: '' };
  for (const mod of parts) {
    const m = mod.toLowerCase();
    if (m === 'ctrl' || m === 'control') chord.ctrl = true;
    else if (m === 'shift') chord.shift = true;
    else if (m === 'alt' || m === 'option') chord.alt = true;
    else if (m === 'cmd' || m === 'command' || m === 'meta' || m === 'super') chord.meta = true;
    else return null;
  }
  const code = keyToCode(key);
  if (!code) return null;
  chord.code = code;
  return chord;
}

/** The accelerator for a key event, or null for a lone modifier or an unknown key. */
export function eventToAccelerator(e: KeyboardEvent): string | null {
  const key = codeToKey(e.code);
  if (!key) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.metaKey && 'Cmd', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return [...mods, key].join('+');
}

/** Canonical spelling, so equal shortcuts compare equal. */
export function normalizeAccelerator(accelerator: string): string | null {
  const chord = parseAccelerator(accelerator);
  if (!chord) return null;
  const key = codeToKey(chord.code);
  const mods = [chord.ctrl && 'Ctrl', chord.meta && 'Cmd', chord.alt && 'Alt', chord.shift && 'Shift'].filter(Boolean);
  return [...mods, key].join('+');
}

/** Shortcuts without Ctrl or Cmd (other than function keys) would take keys away from programs in the terminal. */
export function isRiskyAccelerator(accelerator: string): boolean {
  const chord = parseAccelerator(accelerator);
  if (!chord) return false;
  if (/^F\d+$/.test(chord.code)) return false;
  return !chord.ctrl && !chord.meta && !(chord.shift && chord.code === 'Insert');
}

export class Keymap {
  private readonly bindings: { command: Command; chord: Chord; accelerator: string }[] = [];
  private readonly byCommand = new Map<Command, string[]>();

  constructor(
    readonly platform: string,
    overrides: Settings['keybindings'],
  ) {
    for (const command of commandIds) {
      const accelerators = overrides[command] ?? defaultBindings(command, platform);
      const valid: string[] = [];
      for (const accelerator of accelerators) {
        const chord = parseAccelerator(accelerator);
        const normalized = normalizeAccelerator(accelerator);
        if (!chord || !normalized) continue;
        valid.push(normalized);
        this.bindings.push({ command, chord, accelerator: normalized });
      }
      this.byCommand.set(command, valid);
    }
  }

  match(e: KeyboardEvent): Command | null {
    const hit = this.bindings.find(
      ({ chord }) => chord.code === e.code && chord.ctrl === e.ctrlKey && chord.shift === e.shiftKey && chord.alt === e.altKey && chord.meta === e.metaKey,
    );
    return hit?.command ?? null;
  }

  /** All shortcuts of a command. */
  shortcuts(command: Command): string[] {
    return this.byCommand.get(command) ?? [];
  }

  /** The first shortcut of a command, for menus and tooltips. */
  accelerator(command: Command): string | undefined {
    return this.shortcuts(command)[0];
  }

  /** Commands that use the shortcut. */
  commandsFor(accelerator: string): Command[] {
    const normalized = normalizeAccelerator(accelerator);
    return this.bindings.filter((b) => b.accelerator === normalized).map((b) => b.command);
  }
}
