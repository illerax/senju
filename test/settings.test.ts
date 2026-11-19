import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandIds, defaultBindings } from '../src/shared/commands';
import { defaultSettings, loadSettings, resolveTheme, saveSettings } from '../src/shared/settings';
import { builtinThemes } from '../src/shared/themes';
import { isRiskyAccelerator, Keymap, normalizeAccelerator, parseAccelerator } from '../src/renderer/keymap';

const key = (code: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) =>
  ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;

describe('accelerators', () => {
  it('parses keys by physical code', () => {
    expect(parseAccelerator('Ctrl+Shift+T')).toEqual({ ctrl: true, shift: true, alt: false, meta: false, code: 'KeyT' });
    expect(parseAccelerator('Cmd+[')?.code).toBe('BracketLeft');
    expect(parseAccelerator('Ctrl+Shift+PageDown')?.code).toBe('PageDown');
    expect(parseAccelerator('Ctrl+Nope')).toBeNull();
  });

  it('normalizes modifier order and case', () => {
    expect(normalizeAccelerator('shift+ctrl+t')).toBe('Ctrl+Shift+T');
  });

  it('flags shortcuts that take keys from terminal programs', () => {
    expect(isRiskyAccelerator('Alt+X')).toBe(true);
    expect(isRiskyAccelerator('Ctrl+Shift+X')).toBe(false);
    expect(isRiskyAccelerator('F5')).toBe(false);
  });

  it('every default shortcut is valid and used once per platform', () => {
    for (const platform of ['linux', 'darwin']) {
      const seen = new Map<string, string>();
      for (const command of commandIds) {
        for (const accelerator of defaultBindings(command, platform)) {
          const normalized = normalizeAccelerator(accelerator);
          expect(normalized, `${platform} ${command} ${accelerator}`).not.toBeNull();
          expect(seen.get(normalized!), `${platform} ${accelerator}`).toBeUndefined();
          seen.set(normalized!, command);
        }
      }
    }
  });
});

describe('Keymap', () => {
  it('matches defaults and applies overrides', () => {
    const keymap = new Keymap('linux', { newTab: ['Ctrl+Alt+T'], closePane: [] });
    expect(keymap.match(key('KeyT', { ctrlKey: true, altKey: true }))).toBe('newTab');
    expect(keymap.match(key('KeyT', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(keymap.match(key('KeyX', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(keymap.match(key('KeyD', { ctrlKey: true, shiftKey: true }))).toBe('splitRight');
    expect(keymap.commandsFor('ctrl+shift+d')).toEqual(['splitRight']);
  });
});

describe('settings file', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-settings-'));
    process.env.SENJU_HOME = home;
  });
  afterEach(() => {
    delete process.env.SENJU_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const file = () => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));

  it('keeps only values that differ from the defaults', () => {
    saveSettings({ theme: 'Nord', fontSize: defaultSettings.fontSize, keybindings: { newTab: ['Ctrl+Alt+T'] } });
    expect(file()).toEqual({ theme: 'Nord', keybindings: { newTab: ['Ctrl+Alt+T'] } });
    expect(resolveTheme(loadSettings())).toEqual(builtinThemes.Nord);
    saveSettings({ theme: undefined });
    expect(file().theme).toBeUndefined();
  });

  it('uses a custom theme and falls back for unknown names', () => {
    const custom = { ...builtinThemes.Dracula, background: '#000000' };
    saveSettings({ themes: { Mine: custom }, theme: 'Mine' });
    expect(resolveTheme(loadSettings()).background).toBe('#000000');
    saveSettings({ theme: 'Missing' });
    expect(resolveTheme(loadSettings())).toEqual(builtinThemes['Senju Dark']);
  });

  it('turns an old inline theme into a custom theme', () => {
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ theme: { background: '#101010' } }));
    const settings = loadSettings();
    expect(settings.theme).toBe('Custom');
    expect(resolveTheme(settings).background).toBe('#101010');
  });
});

describe('theme fonts', () => {
  it('uses the theme font over the default font, field by field', async () => {
    const { resolveFont } = await import('../src/shared/themes');
    const base = { ...defaultSettings, fontSize: 14 };
    expect(resolveFont({ ...base, theme: 'Nord' })).toMatchObject({ fontSize: 14, fontWeight: 400 });
    const themes = { Mine: { ...builtinThemes.Nord, font: { fontFamily: "'Iosevka', monospace", fontWeight: 300 } } };
    expect(resolveFont({ ...base, themes, theme: 'Mine' })).toEqual({ fontFamily: "'Iosevka', monospace", fontSize: 14, fontWeight: 300, lineHeight: 1 });
  });
});

describe('zoom', () => {
  it('adds the zoom to the font size of the current font', async () => {
    const { terminalFont, zoomPercent } = await import('../src/shared/themes');
    const themes = { Mine: { ...builtinThemes.Nord, font: { fontSize: 16 } } };
    expect(terminalFont({ ...defaultSettings, zoom: 2 }).fontSize).toBe(15);
    expect(terminalFont({ ...defaultSettings, themes, theme: 'Mine', zoom: -4 }).fontSize).toBe(12);
    expect(zoomPercent({ ...defaultSettings, themes, theme: 'Mine', zoom: 4 })).toBe(125);
  });

  it('keeps the zoomed size within the font size bounds', async () => {
    const { clampZoom, terminalFont } = await import('../src/shared/themes');
    expect(clampZoom(defaultSettings, -20)).toBe(-7);
    expect(clampZoom(defaultSettings, 100)).toBe(27);
    expect(terminalFont({ ...defaultSettings, zoom: Number.NaN }).fontSize).toBe(13);
  });
});
