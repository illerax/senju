// The find bar of a terminal: searches its scrollback and screen, highlights
// every match and steps through them.

import type { Terminal } from '@xterm/xterm';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import type { Theme } from '../shared/themes';
import { searchColors } from '../shared/themes';
import { iconButton } from './icons';

/** Matches beyond this many are found but not all highlighted. */
const HIGHLIGHT_LIMIT = 2000;

export class TerminalSearch {
  readonly element = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly count = document.createElement('span');
  private readonly caseButton = document.createElement('button');
  private readonly regexButton = document.createElement('button');
  private readonly addon = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });
  private caseSensitive = false;
  private regex = false;

  constructor(
    private readonly term: Terminal,
    private readonly theme: () => Theme,
    /** Called when the bar closes, to give the focus back to the terminal. */
    private readonly onClose: () => void,
  ) {
    term.loadAddon(this.addon);
    this.element.className = 'terminal-search';
    this.element.hidden = true;
    this.input.className = 'terminal-search-input';
    this.input.placeholder = 'Find';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Find in the terminal');
    this.count.className = 'terminal-search-count';

    const toggle = (button: HTMLButtonElement, text: string, label: string, flip: () => boolean) => {
      button.type = 'button';
      button.className = 'terminal-search-toggle';
      button.textContent = text;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => {
        button.setAttribute('aria-pressed', String(flip()));
        this.find('incremental');
      });
    };
    toggle(this.caseButton, 'Aa', 'Match case', () => (this.caseSensitive = !this.caseSensitive));
    toggle(this.regexButton, '.*', 'Regular expression', () => (this.regex = !this.regex));

    const action = (icon: 'chevronUp' | 'chevronDown' | 'close', label: string, run: () => void) => {
      const button = iconButton(icon, label);
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', run);
      return button;
    };
    this.element.append(
      this.input,
      this.count,
      this.caseButton,
      this.regexButton,
      action('chevronUp', 'Previous match (Shift+Enter)', () => this.find('previous')),
      action('chevronDown', 'Next match (Enter)', () => this.find('next')),
      action('close', 'Close (Escape)', () => this.close()),
    );

    this.input.addEventListener('input', () => this.find('incremental'));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.find(e.shiftKey ? 'previous' : 'next');
      else if (e.key === 'Escape') this.close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    this.addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (!this.input.value) this.count.textContent = '';
      else if (resultCount === 0) this.count.textContent = 'No results';
      else {
        // The addon stops counting at the highlight limit, and may not number the active match past it.
        const total = resultCount >= HIGHLIGHT_LIMIT ? `${HIGHLIGHT_LIMIT}+` : String(resultCount);
        this.count.textContent = resultIndex < 0 ? `${total} matches` : `${resultIndex + 1} of ${total}`;
      }
      this.element.classList.toggle('no-results', !!this.input.value && resultCount === 0);
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** Opens the bar, starting from the selected text if there is one on a single line. */
  open(): void {
    const selection = this.term.getSelection();
    if (selection && !selection.includes('\n')) this.input.value = selection;
    this.element.hidden = false;
    this.input.focus();
    this.input.select();
    if (this.input.value) this.find('incremental');
  }

  close(): void {
    if (!this.isOpen) return;
    this.element.hidden = true;
    this.addon.clearDecorations();
    this.count.textContent = '';
    this.element.classList.remove('no-results');
    this.onClose();
  }

  /** Steps to the next or previous match of the last search with the bar closed; false when there is none. */
  findAgain(previous: boolean): boolean {
    const text = this.input.value;
    if (!text || (this.regex && !validRegex(text))) return false;
    const options: ISearchOptions = { caseSensitive: this.caseSensitive, regex: this.regex };
    return previous ? this.addon.findPrevious(text, options) : this.addon.findNext(text, options);
  }

  /** Searches again with the current theme's colors, e.g. after the theme changed. */
  refresh(): void {
    if (this.isOpen && this.input.value) this.find('incremental');
  }

  private find(direction: 'next' | 'previous' | 'incremental'): void {
    const text = this.input.value;
    if (!text) {
      this.addon.clearDecorations();
      this.term.clearSelection();
      this.count.textContent = '';
      this.element.classList.remove('no-results');
      return;
    }
    if (this.regex && !validRegex(text)) {
      this.addon.clearDecorations();
      this.count.textContent = 'Invalid pattern';
      this.element.classList.add('no-results');
      return;
    }
    const options: ISearchOptions = {
      caseSensitive: this.caseSensitive,
      regex: this.regex,
      incremental: direction === 'incremental',
      decorations: searchColors(this.theme()),
    };
    if (direction === 'previous') this.addon.findPrevious(text, options);
    else this.addon.findNext(text, options);
  }
}

function validRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
