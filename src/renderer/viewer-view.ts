// A viewer: a file rendered by its format, in a tab or a window of its own.
// It asks the daemon for the file every second while it is shown and renders
// again when the file changed, keeping the scroll position and the opened
// tree nodes.

import type { MenuItem } from '../shared/menu';
import type { ViewerState } from '../shared/types';
import { imageType, MAX_VIEWER_BYTES, viewerFormat, type ViewerContent, type ViewerFormat } from '../shared/viewer';
import { iconButton } from './icons';
import { parseJson, parseYaml } from './viewer-parse';
import { hasRendering, notice, renderCode, renderCsv, renderHtml, renderImage, renderMarkdown, renderSource, renderTree, type RenderContext } from './viewer-render';

const POLL_MS = 1000;
/** A read the daemon has not answered for this long is asked again. */
const READ_TIMEOUT_MS = 15_000;

export interface ViewerHooks {
  read: (viewerId: string, known?: number) => void;
  openLink: (url: string) => void;
  copy: (text: string) => void;
  menu: (items: MenuItem[], e: MouseEvent) => Promise<string | null>;
  onFocus?: (viewerId: string) => void;
  onZoom?: (viewerId: string, steps: number) => void;
  /** Moves the viewer to a window of its own; missing in that window. */
  popOut?: (viewerId: string) => void;
  /** Moves the viewer from its window of its own back to a tab; only in that window. */
  dock?: (viewerId: string) => void;
  /** The windows the viewer can move to (window-choices.ts), and the move to the one chosen. */
  windows?: () => MenuItem[];
  moveToWindow?: (viewerId: string, choice: string) => void;
  /** Its home folder, to show paths shorter. */
  home: () => string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const sizeText = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const kindNames: Record<ViewerFormat['kind'], string> = {
  markdown: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  html: 'HTML',
  csv: 'Table',
  image: 'Image',
  code: 'Code',
  text: 'Text',
};

export class ViewerView {
  readonly element = el('div', 'viewer');
  private readonly bar = el('div', 'viewer-bar');
  private readonly where = el('span', 'viewer-path');
  private readonly info = el('span', 'viewer-info');
  private readonly modeButton = el('button', 'button viewer-mode');
  private readonly body = el('div', 'viewer-body');
  private viewer: ViewerState | null = null;
  private content: ViewerContent | null = null;
  private source = false;
  private renderedKey = '';
  private readonly toggled = new Map<string, boolean>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private askedAt = 0;
  private zoom = 0;

  constructor(
    readonly viewerId: string,
    private readonly hooks: ViewerHooks,
  ) {
    this.body.tabIndex = 0;
    this.modeButton.type = 'button';
    this.modeButton.addEventListener('click', () => this.setSource(!this.source));
    const spacer = el('span', 'viewer-spacer');
    this.bar.append(this.where, this.info, spacer, this.modeButton);
    if (hooks.popOut) {
      const popOut = iconButton('popOut', 'Open in a window of its own');
      popOut.addEventListener('click', () => hooks.popOut?.(viewerId));
      this.bar.append(popOut);
    }
    if (hooks.dock) {
      const dock = iconButton('dock', 'Return to a tab');
      dock.addEventListener('click', () => hooks.dock?.(viewerId));
      this.bar.append(dock);
    }
    this.element.append(this.bar, this.body);
    this.element.addEventListener('focusin', () => hooks.onFocus?.(viewerId));
    this.element.addEventListener('mousedown', () => hooks.onFocus?.(viewerId));
    this.body.addEventListener('contextmenu', (e) => void this.contextMenu(e));
    this.body.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || !hooks.onZoom) return;
        e.preventDefault();
        hooks.onZoom(viewerId, e.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
  }

  /** Starts asking for the file while the viewer is shown. */
  attach(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.element.remove();
  }

  /** The daemon restarted or reconnected: read the file again. */
  reset(): void {
    this.askedAt = 0;
    this.content = null;
    this.renderedKey = '';
    this.poll();
  }

  focus(): void {
    this.body.focus({ preventScroll: true });
  }

  /** The selected text, for the copy command. */
  selection(): string {
    return window.getSelection()?.toString() ?? '';
  }

  setZoom(px: number): void {
    if (px === this.zoom) return;
    this.zoom = px;
    this.element.style.setProperty('--viewer-zoom', `${px}px`);
  }

  update(viewer: ViewerState): void {
    const previous = this.viewer;
    this.viewer = viewer;
    if (previous && previous.file !== viewer.file) this.reset();
    this.render();
  }

  setContent(content: ViewerContent | undefined): void {
    this.askedAt = 0;
    if (!content) return;
    this.content = content;
    this.render();
  }

  private poll(): void {
    if (!this.element.isConnected || document.hidden) return;
    if (this.askedAt && Date.now() - this.askedAt < READ_TIMEOUT_MS) return;
    this.askedAt = Date.now();
    this.hooks.read(this.viewerId, this.content && !this.content.error ? this.content.mtime : undefined);
  }

  private get format(): ViewerFormat {
    return viewerFormat(this.viewer?.file ?? '', this.viewer?.format);
  }

  private setSource(source: boolean): void {
    this.source = source;
    this.render();
  }

  private render(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const format = this.format;
    const home = this.hooks.home();
    const file = viewer.owned ? 'Sent by an agent' : home && viewer.file.startsWith(home) ? `~${viewer.file.slice(home.length)}` : viewer.file;
    // Marks keep a path's slashes in place where the right-to-left box cuts its start.
    const shown = `\u200e${file}\u200e`;
    if (this.where.textContent !== shown) this.where.textContent = shown;
    this.where.title = viewer.file;
    const content = this.content;
    this.info.textContent = [kindNames[format.kind], content && !content.error ? sizeText(content.size) : ''].filter(Boolean).join(' · ');
    const renderable = hasRendering(format);
    this.modeButton.hidden = !renderable;
    this.modeButton.textContent = this.source ? 'Rendered' : 'Source';
    this.modeButton.title = this.source ? 'Show it rendered' : 'Show its source';
    const key = JSON.stringify([format, this.source, content?.mtime, content?.error, content?.size]);
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    const scroll = { top: this.body.scrollTop, left: this.body.scrollLeft };
    this.body.replaceChildren(...this.renderContent(format, content));
    this.body.scrollTop = scroll.top;
    this.body.scrollLeft = scroll.left;
  }

  private renderContent(format: ViewerFormat, content: ViewerContent | null): HTMLElement[] {
    if (!content) return [el('div', 'viewer-empty', 'Loading…')];
    if (content.error) return [el('div', 'viewer-empty', content.error)];
    const parts: HTMLElement[] = [];
    if (content.truncated) parts.push(notice(`Showing the first ${sizeText(MAX_VIEWER_BYTES)} of ${sizeText(content.size)}.`));
    const text = content.data;
    if (format.kind === 'image') return [...parts, renderImage(text, imageType(this.viewer?.file ?? ''))];
    if (this.source || !hasRendering(format)) return [...parts, format.kind === 'code' ? renderCode(text, format.language) : renderSource(text, format)];
    const ctx: RenderContext = {
      toggled: this.toggled,
      openLink: (url) => this.hooks.openLink(url),
      nodeMenu: (e, path, value) => void this.nodeMenu(e, path, value),
    };
    try {
      switch (format.kind) {
        case 'markdown':
          return [...parts, renderMarkdown(text, ctx)];
        case 'json':
          return [...parts, renderTree(parseJson(text), ctx)];
        case 'yaml':
          return [...parts, renderTree(parseYaml(text), ctx)];
        case 'csv':
          return [...parts, renderCsv(text, format.separator ?? ',')];
        case 'html':
          return [...parts, renderHtml(this.viewerId, content.mtime)];
      }
    } catch (err) {
      // A file being written may not parse yet; its source still shows.
      return [...parts, notice(`Shown as source: ${(err as Error).message}`, 'error'), renderSource(text, format)];
    }
    return [...parts, renderSource(text, format)];
  }

  private async nodeMenu(e: MouseEvent, path: string, value: unknown): Promise<void> {
    const choice = await this.hooks.menu(
      [
        { id: 'path', label: `Copy Path  ${path.length > 40 ? `…${path.slice(-39)}` : path}` },
        { id: 'value', label: 'Copy Value' },
      ],
      e,
    );
    if (choice === 'path') this.hooks.copy(path);
    if (choice === 'value') this.hooks.copy(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }

  private async contextMenu(e: MouseEvent): Promise<void> {
    if ((e.target as HTMLElement).closest('.tree-row')) return;
    e.preventDefault();
    const selected = this.selection();
    const items = [
      { id: 'copy', label: 'Copy', enabled: !!selected },
      { id: 'copyPath', label: 'Copy File Path' },
      ...(hasRendering(this.format) ? [{ id: 'mode', label: this.source ? 'Show Rendered' : 'Show Source' }] : []),
      ...(this.hooks.popOut || this.hooks.dock || this.hooks.windows ? [{ id: '-', label: '' }] : []),
      ...(this.hooks.popOut ? [{ id: 'popOut', label: 'Open in a Window of Its Own' }] : []),
      ...(this.hooks.dock ? [{ id: 'dock', label: 'Return to a Tab' }] : []),
      ...(this.hooks.windows ? [{ id: 'window', label: 'Move to Window', submenu: this.hooks.windows() }] : []),
    ];
    const choice = await this.hooks.menu(items, e);
    if (choice === 'copy') this.hooks.copy(selected);
    if (choice === 'copyPath' && this.viewer) this.hooks.copy(this.viewer.file);
    if (choice === 'mode') this.setSource(!this.source);
    if (choice === 'popOut') this.hooks.popOut?.(this.viewerId);
    if (choice === 'dock') this.hooks.dock?.(this.viewerId);
    if (choice?.startsWith('window:')) this.hooks.moveToWindow?.(this.viewerId, choice);
  }
}
