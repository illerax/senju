// One xterm.js terminal bound to a daemon terminal; shown as a tab of a pane.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Settings } from '../shared/settings';
import { resolveTheme, terminalFont } from '../shared/themes';
import { senju } from './api';

export interface TerminalHooks {
  /** Returns true when the key event was handled as an application shortcut. */
  onKey: (e: KeyboardEvent) => boolean;
  onFocus: (terminalId: string) => void;
  onContextMenu: (terminalId: string, e: MouseEvent) => void;
  /** Zooms this terminal by a number of steps; negative zooms out. */
  onZoom: (terminalId: string, steps: number) => void;
}

/** Wheel distance, in pixels, of one zoom step. */
const ZOOM_WHEEL_STEP = 50;

export class TerminalView {
  readonly element: HTMLDivElement;
  readonly host: HTMLDivElement;
  readonly overlay: HTMLDivElement;
  readonly term: Terminal;
  private readonly fitAddon = new FitAddon();
  private attached = false;
  /**
   * The screen shows the daemon's snapshot. Until then it may hold the modes
   * of a program from before a daemon restart, such as mouse tracking, and
   * the reports they produce would land in the new shell as typed text.
   */
  private synced = false;
  private copyOnSelect: boolean;
  private settings: Settings;
  /** Pixels this terminal is zoomed by, on top of the zoom of all terminals. */
  private zoom = 0;
  private lastSize = '';

  constructor(
    readonly terminalId: string,
    settings: Settings,
    platform: string,
    hooks: TerminalHooks,
  ) {
    this.settings = settings;
    this.copyOnSelect = settings.copyOnSelect;
    this.element = document.createElement('div');
    this.element.className = 'terminal';
    this.element.dataset.terminalId = terminalId;
    this.host = document.createElement('div');
    this.host.className = 'terminal-host';
    this.overlay = document.createElement('div');
    this.overlay.className = 'terminal-overlay';
    this.element.append(this.host, this.overlay);

    // Ctrl+click (Cmd+click) opens plain URLs and OSC 8 hyperlinks alike. A
    // hyperlink's text can differ from its address, so hovering shows the
    // address; xterm's default handler would ask with a native confirm().
    const open = (event: MouseEvent, uri: string) => {
      if (event.ctrlKey || event.metaKey) senju.openExternal(uri);
    };
    this.term = new Terminal({
      ...terminalFont(settings),
      linkHandler: {
        activate: open,
        hover: (_event, uri) => (this.host.title = uri),
        leave: () => this.host.removeAttribute('title'),
      },
      scrollback: settings.scrollback,
      theme: resolveTheme(settings),
      allowProposedApi: true,
      cursorBlink: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
    });
    this.term.loadAddon(this.fitAddon);
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon(open));
    this.term.open(this.host);

    this.term.attachCustomKeyEventHandler((e) => e.type !== 'keydown' || !hooks.onKey(e));
    this.term.onData((data) => this.synced && senju.send({ type: 'input', terminalId, data }));
    this.term.textarea?.addEventListener('focus', () => hooks.onFocus(terminalId));
    this.term.onSelectionChange(() => {
      const text = this.term.getSelection();
      if (!text) return;
      if (platform === 'linux') senju.clipboardWrite(text, 'selection');
      if (this.copyOnSelect) senju.clipboardWrite(text);
    });

    this.host.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      hooks.onContextMenu(terminalId, e);
    });
    // Middle click pastes the primary selection, as in other Linux terminals.
    this.host.addEventListener('auxclick', (e) => {
      if (e.button !== 1 || platform !== 'linux') return;
      e.preventDefault();
      void senju.clipboardRead('selection').then((text) => text && this.term.paste(text));
    });

    // Ctrl+wheel (Cmd+wheel on macOS, where a trackpad pinch arrives as Ctrl+wheel)
    // zooms. Caught before xterm sees it, so it neither scrolls nor reaches programs.
    let wheel = 0;
    this.host.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || (platform === 'darwin' && e.metaKey))) return;
        e.preventDefault();
        e.stopPropagation();
        wheel += e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? e.deltaY : e.deltaY * ZOOM_WHEEL_STEP;
        if (Math.abs(wheel) < ZOOM_WHEEL_STEP) return;
        // One step per mouse wheel notch; small trackpad deltas add up to one.
        hooks.onZoom(this.terminalId, wheel < 0 ? 1 : -1);
        wheel = 0;
      },
      { capture: true, passive: false },
    );

    new ResizeObserver(() => this.fit()).observe(this.host);
  }

  /** Requests the screen contents and live output from the daemon. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    senju.send({ type: 'attach', terminalId: this.terminalId });
  }

  /** The daemon connection was replaced; the next attach starts from a fresh snapshot. */
  reset(): void {
    this.attached = false;
    this.synced = false;
    this.lastSize = '';
  }

  onSnapshot(data: string): void {
    this.term.reset();
    this.term.write(data);
    this.synced = true;
  }

  onData(data: string): void {
    this.term.write(data);
  }

  fit(): void {
    if (!this.element.isConnected || this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
    this.fitAddon.fit();
    const size = `${this.term.cols}x${this.term.rows}`;
    if (size !== this.lastSize) {
      this.lastSize = size;
      senju.send({ type: 'resize', terminalId: this.terminalId, cols: this.term.cols, rows: this.term.rows });
    }
  }

  /** Applies changed font and theme settings to the running terminal. */
  applySettings(settings: Settings): void {
    this.settings = settings;
    this.copyOnSelect = settings.copyOnSelect;
    this.term.options.theme = resolveTheme(settings);
    this.applyFont();
  }

  /** Sets this terminal's own zoom, on top of the zoom of all terminals. */
  setZoom(zoom: number): void {
    if (zoom === this.zoom) return;
    this.zoom = zoom;
    this.applyFont();
  }

  private applyFont(): void {
    const font = terminalFont(this.settings, this.zoom);
    // Setting an unchanged option still makes xterm re-measure, so compare first.
    if (this.term.options.fontFamily !== font.fontFamily) this.term.options.fontFamily = font.fontFamily;
    if (this.term.options.fontSize !== font.fontSize) this.term.options.fontSize = font.fontSize;
    if (this.term.options.fontWeight !== font.fontWeight) this.term.options.fontWeight = font.fontWeight;
    if (this.term.options.lineHeight !== font.lineHeight) this.term.options.lineHeight = font.lineHeight;
    this.fit();
  }

  focus(): void {
    this.term.focus();
  }

  async copy(): Promise<void> {
    const text = this.term.getSelection();
    if (text) senju.clipboardWrite(text);
  }

  async paste(): Promise<void> {
    const text = await senju.clipboardRead();
    if (text) this.term.paste(text);
  }

  dispose(): void {
    this.term.dispose();
    this.element.remove();
  }
}
