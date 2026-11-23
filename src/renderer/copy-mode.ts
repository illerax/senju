// Copy mode of a terminal: a cursor moved with the keyboard over the screen and
// scrollback, selecting text to copy. Nothing typed reaches the program while
// it is on, and a bar at the bottom lists its keys as the user set them.

import type { Terminal } from '@xterm/xterm';
import type { Command } from '../shared/commands';
import { keyLabel, type Keymap } from './keymap';

interface Position {
  row: number;
  col: number;
}

export interface CopyModeContext {
  keymap: () => Keymap;
  /** Opens the find bar; it reports back through `afterFind`. */
  find: () => void;
  /** Steps to the next or previous match of the last search; false without one. */
  findAgain: (previous: boolean) => boolean;
  copy: (text: string) => void;
  /** Called when copy mode turns on or off. */
  onToggle: (active: boolean) => void;
}

/** How long the bar says the text was copied. */
const COPIED_MS = 1500;

/** The keys the bar shows, in its order. */
const hints: { label: string; commands: Command[] }[] = [
  { label: 'move', commands: ['copyModeLeft', 'copyModeDown', 'copyModeUp', 'copyModeRight'] },
  { label: 'words', commands: ['copyModeWordForward', 'copyModeWordBack'] },
  { label: 'line', commands: ['copyModeLineStart', 'copyModeLineEnd'] },
  { label: 'page', commands: ['copyModePageUp', 'copyModePageDown'] },
  { label: 'top / bottom', commands: ['copyModeTop', 'copyModeBottom'] },
  { label: 'select', commands: ['copyModeSelect'] },
  { label: 'lines', commands: ['copyModeSelectLines'] },
  { label: 'find', commands: ['copyModeFind'] },
  { label: 'next / previous', commands: ['copyModeFindNext', 'copyModeFindPrevious'] },
  { label: 'copy', commands: ['copyModeCopy'] },
  { label: 'exit', commands: ['copyModeExit'] },
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

/** 0 for blanks, 1 for word characters, 2 for punctuation, as words are told apart in vi. */
function charClass(ch: string): number {
  if (!ch || /\s/.test(ch)) return 0;
  return /[\p{L}\p{N}_]/u.test(ch) ? 1 : 2;
}

export class CopyMode {
  readonly bar = el('div', 'copy-mode-bar');
  private readonly cursorElement = el('div', 'copy-mode-cursor');
  private active = false;
  private pos: Position = { row: 0, col: 0 };
  /** Where the selection started, while selecting. */
  private anchor: Position | null = null;
  private lines = false;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly term: Terminal,
    private readonly ctx: CopyModeContext,
  ) {
    this.bar.hidden = true;
    this.cursorElement.hidden = true;
    term.onRender(() => this.placeCursor());
    term.onScroll(() => this.placeCursor());
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Starts at the terminal's cursor when it is on the screen, else at the bottom of what is shown. */
  enter(): void {
    if (this.active) return;
    const buffer = this.term.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    const shown = cursorRow >= buffer.viewportY && cursorRow < buffer.viewportY + this.term.rows;
    this.pos = shown ? { row: cursorRow, col: Math.min(buffer.cursorX, this.term.cols - 1) } : { row: buffer.viewportY + this.term.rows - 1, col: 0 };
    this.anchor = null;
    this.lines = false;
    this.active = true;
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.term.element?.querySelector('.xterm-screen')?.append(this.cursorElement);
    this.cursorElement.hidden = false;
    this.bar.hidden = false;
    this.bar.classList.remove('copied');
    this.term.clearSelection();
    this.update();
    this.ctx.onToggle(true);
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.anchor = null;
    this.cursorElement.hidden = true;
    if (!this.bar.classList.contains('copied')) this.bar.hidden = true;
    this.term.clearSelection();
    this.ctx.onToggle(false);
  }

  /** Handles a key while copy mode is on; false when it is not one of its keys. */
  handleKey(e: KeyboardEvent): boolean {
    const command = this.ctx.keymap().match(e, 'copyMode');
    if (command) this.run(command);
    return !!command;
  }

  /** The find bar closed: the cursor moves to the match it selected. */
  afterFind(): void {
    if (!this.active) return;
    this.toSelection();
    this.update();
  }

  /** Shows the keys again, e.g. after they were changed in the settings. */
  refresh(): void {
    if (this.active) this.renderBar();
  }

  private run(command: Command): void {
    const buffer = this.term.buffer.active;
    const page = Math.max(1, this.term.rows - 1);
    switch (command) {
      case 'copyModeLeft':
        return this.move({ col: this.pos.col - 1 });
      case 'copyModeRight':
        return this.move({ col: this.pos.col + 1 });
      case 'copyModeUp':
        return this.move({ row: this.pos.row - 1 });
      case 'copyModeDown':
        return this.move({ row: this.pos.row + 1 });
      case 'copyModeWordForward':
        return this.move(this.nextWord());
      case 'copyModeWordBack':
        return this.move(this.previousWord());
      case 'copyModeLineStart':
        return this.move({ col: 0 });
      case 'copyModeLineEnd':
        return this.move({ col: Math.max(0, this.cells(this.pos.row).findLastIndex((ch) => charClass(ch) !== 0)) });
      case 'copyModePageUp':
        return this.move({ row: this.pos.row - page });
      case 'copyModePageDown':
        return this.move({ row: this.pos.row + page });
      case 'copyModeTop':
        return this.move({ row: 0, col: 0 });
      case 'copyModeBottom':
        return this.move({ row: buffer.length - 1, col: 0 });
      case 'copyModeSelect':
      case 'copyModeSelectLines': {
        const lines = command === 'copyModeSelectLines';
        // The same key again stops selecting; the other one switches the kind.
        if (this.anchor && this.lines === lines) this.anchor = null;
        else this.anchor ??= { ...this.pos };
        this.lines = lines;
        return this.update();
      }
      case 'copyModeFind':
        return this.ctx.find();
      case 'copyModeFindNext':
      case 'copyModeFindPrevious':
        if (this.ctx.findAgain(command === 'copyModeFindPrevious')) this.toSelection();
        return this.update();
      case 'copyModeCopy':
        return this.copy();
      case 'copyModeExit':
        return this.exit();
    }
  }

  private move(to: Partial<Position>): void {
    const buffer = this.term.buffer.active;
    this.pos = {
      row: Math.max(0, Math.min(buffer.length - 1, to.row ?? this.pos.row)),
      col: Math.max(0, Math.min(this.term.cols - 1, to.col ?? this.pos.col)),
    };
    this.update();
  }

  /** Moves the cursor to the start of the terminal's selection, which a search just made. */
  private toSelection(): void {
    const range = this.term.getSelectionPosition();
    if (range) this.pos = { row: range.start.y, col: Math.min(range.start.x, this.term.cols - 1) };
  }

  /** The characters of a row, one per cell; the second cell of a wide character repeats it. */
  private cells(row: number): string[] {
    const line = this.term.buffer.active.getLine(row);
    const cells: string[] = [];
    for (let x = 0; x < this.term.cols; x++) {
      const cell = line?.getCell(x);
      cells.push(cell && cell.getWidth() === 0 ? (cells[x - 1] ?? '') : (cell?.getChars() ?? ''));
    }
    return cells;
  }

  private nextWord(): Position {
    const last = this.term.buffer.active.length - 1;
    let { row, col } = this.pos;
    let cells = this.cells(row);
    const start = charClass(cells[col]);
    // Past the rest of this word, then past blanks, across lines.
    if (start !== 0) while (col < cells.length && charClass(cells[col]) === start) col++;
    for (;;) {
      while (col < cells.length && charClass(cells[col]) === 0) col++;
      if (col < cells.length || row === last) break;
      row++;
      col = 0;
      cells = this.cells(row);
    }
    return { row, col: Math.min(col, cells.length - 1) };
  }

  private previousWord(): Position {
    let { row, col } = this.pos;
    let cells = this.cells(row);
    const back = (): boolean => {
      if (col > 0) {
        col--;
        return true;
      }
      if (row === 0) return false;
      row--;
      cells = this.cells(row);
      col = cells.length - 1;
      return true;
    };
    // Back over blanks, then to the start of the word before them.
    if (!back()) return this.pos;
    while (charClass(cells[col]) === 0 && back());
    const cls = charClass(cells[col]);
    while (col > 0 && charClass(cells[col - 1]) === cls && cls !== 0) col--;
    return { row, col };
  }

  private copy(): void {
    const text = this.anchor
      ? this.term.getSelection()
      : (this.term.buffer.active.getLine(this.pos.row)?.translateToString(true).trim() ?? '');
    if (!text) return;
    this.ctx.copy(text);
    const lines = text.split('\n').length;
    this.bar.classList.add('copied');
    this.bar.replaceChildren(el('span', 'copy-mode-title', lines > 1 ? `Copied ${lines} lines` : 'Copied'));
    this.copiedTimer = setTimeout(() => {
      this.bar.classList.remove('copied');
      if (!this.active) this.bar.hidden = true;
    }, COPIED_MS);
    this.exit();
  }

  private update(): void {
    const { row, col } = this.pos;
    if (!this.anchor) this.term.clearSelection();
    else if (this.lines) this.term.selectLines(Math.min(this.anchor.row, row), Math.max(this.anchor.row, row));
    else {
      const [from, to] = this.anchor.row < row || (this.anchor.row === row && this.anchor.col <= col) ? [this.anchor, this.pos] : [this.pos, this.anchor];
      this.term.select(from.col, from.row, (to.row - from.row) * this.term.cols + to.col - from.col + 1);
    }
    // Keep the cursor on the screen.
    const top = this.term.buffer.active.viewportY;
    if (row < top) this.term.scrollToLine(row);
    else if (row >= top + this.term.rows) this.term.scrollToLine(row - this.term.rows + 1);
    this.renderBar();
    this.placeCursor();
  }

  private placeCursor(): void {
    if (!this.active) return;
    const screen = this.cursorElement.parentElement;
    if (!screen) return;
    const width = screen.clientWidth / this.term.cols;
    const height = screen.clientHeight / this.term.rows;
    const line = this.pos.row - this.term.buffer.active.viewportY;
    this.cursorElement.hidden = line < 0 || line >= this.term.rows;
    this.cursorElement.style.cssText = `left:${this.pos.col * width}px;top:${line * height}px;width:${width}px;height:${height}px`;
    // The bar moves to the top while the cursor is where it would cover it.
    const host = this.bar.parentElement;
    if (host) {
      const cursorBottom = screen.getBoundingClientRect().top + (line + 1) * height - host.getBoundingClientRect().top;
      this.bar.classList.toggle('top', cursorBottom > host.clientHeight - this.bar.offsetHeight - 12);
    }
  }

  private renderBar(): void {
    const keymap = this.ctx.keymap();
    const state = this.anchor ? (this.lines ? 'Selecting lines' : 'Selecting') : 'Copy mode';
    const items = hints.flatMap(({ label, commands }) => {
      const keys = commands.map((c) => keymap.accelerator(c)).filter((k): k is string => !!k);
      if (keys.length === 0) return [];
      const item = el('span', 'copy-mode-hint');
      for (const key of keys) item.append(el('kbd', '', keyLabel(key)));
      item.append(label);
      return [item];
    });
    this.bar.replaceChildren(el('span', 'copy-mode-title', state), ...items);
  }
}
