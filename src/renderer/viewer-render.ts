// Renders a viewer's file by its format: Markdown as a document, JSON and
// YAML as trees, CSV as a table, code with highlighting, images, and HTML in a
// sandboxed frame served by the main process (`senju-view:`), which runs its
// scripts but loads nothing from the network.

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import scala from 'highlight.js/lib/languages/scala';
import type { ViewerFormat } from '../shared/viewer';
import { parseCsv } from './viewer-parse';

hljs.registerLanguage('dart', dart);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('scala', scala);

/** Larger text is shown without highlighting, which would take seconds. */
const MAX_HIGHLIGHT = 512 * 1024;
/** Children of a tree node, and rows of a table, shown before a "show more" row. */
const PAGE = 200;
const MAX_ROWS = 10_000;

export interface RenderContext {
  /** Paths of the tree nodes the user opened or closed, kept across reloads. */
  toggled: Map<string, boolean>;
  openLink: (url: string) => void;
  /** A menu for a tree node, to copy its path or value. */
  nodeMenu: (e: MouseEvent, path: string, value: unknown) => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

/** Whether a format has a rendered view besides its source. */
export function hasRendering(format: ViewerFormat): boolean {
  return ['markdown', 'json', 'yaml', 'html', 'csv'].includes(format.kind);
}

/** The language a format's source is highlighted as. */
function sourceLanguage(format: ViewerFormat): string | undefined {
  return { markdown: 'markdown', json: 'json', yaml: 'yaml', html: 'xml', csv: undefined, image: undefined, text: undefined, code: format.language }[format.kind];
}

/** Text with line numbers, highlighted as a language when it has one and is not too large. */
export function renderCode(text: string, language: string | undefined): HTMLElement {
  const box = el('div', 'viewer-code');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const gutter = el('pre', 'viewer-gutter', lines.map((_, i) => i + 1).join('\n'));
  const code = el('pre', 'viewer-source');
  const inner = el('code', 'hljs');
  if (language && hljs.getLanguage(language) && text.length <= MAX_HIGHLIGHT) inner.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  else inner.textContent = text;
  code.append(inner);
  box.append(gutter, code);
  return box;
}

export function renderSource(text: string, format: ViewerFormat): HTMLElement {
  return renderCode(text, sourceLanguage(format));
}

/** A notice above the content, e.g. why it is shown as source. */
export function notice(text: string, kind: 'info' | 'error' = 'info'): HTMLElement {
  return el('div', `viewer-notice ${kind}`, text);
}

export function renderMarkdown(text: string, ctx: RenderContext): HTMLElement {
  const doc = el('article', 'viewer-markdown');
  const html = marked.parse(text, { gfm: true, async: false });
  doc.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  for (const block of doc.querySelectorAll<HTMLElement>('pre code')) {
    const language = /language-([\w+-]+)/.exec(block.className)?.[1];
    if (language && hljs.getLanguage(language) && (block.textContent?.length ?? 0) <= MAX_HIGHLIGHT) {
      block.innerHTML = hljs.highlight(block.textContent ?? '', { language, ignoreIllegals: true }).value;
    }
    block.classList.add('hljs');
  }
  doc.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('a');
    const href = link?.getAttribute('href');
    if (!link || !href) return;
    e.preventDefault();
    if (href.startsWith('#')) doc.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView();
    else ctx.openLink(link.href);
  });
  // Headings get ids, so links within the document work.
  const used = new Set<string>();
  for (const heading of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = (heading.textContent ?? '').toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
    let id = base;
    for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    heading.id = id;
  }
  return doc;
}

/** A key in a path, as jq writes it: .name, or ["odd key"]. */
function pathKey(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return /^[A-Za-z_][\w]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function primitive(value: unknown): HTMLElement {
  if (value === null) return el('span', 'tree-null', 'null');
  if (typeof value === 'string') return el('span', 'tree-string', JSON.stringify(value));
  if (typeof value === 'number' || typeof value === 'bigint') return el('span', 'tree-number', String(value));
  if (typeof value === 'boolean') return el('span', 'tree-boolean', String(value));
  if (value instanceof Date) return el('span', 'tree-string', value.toISOString());
  return el('span', 'tree-null', String(value));
}

const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] => typeof value === 'object' && value !== null && !(value instanceof Date);

function entries(value: Record<string, unknown> | unknown[]): [string | number, unknown][] {
  if (Array.isArray(value)) return value.map((v, i) => [i, v]);
  if (value instanceof Map) return [...value.entries()].map(([k, v]) => [String(k), v]);
  return Object.entries(value);
}

/** One node of a tree: a key with a value, its children shown when opened. Top levels start open. */
function treeNode(key: string | number | null, value: unknown, path: string, depth: number, ctx: RenderContext): HTMLElement {
  const node = el('div', 'tree-node');
  const row = el('div', 'tree-row');
  const toggle = el('span', 'tree-toggle');
  row.append(toggle);
  if (key !== null) row.append(el('span', typeof key === 'number' ? 'tree-index' : 'tree-key', typeof key === 'number' ? String(key) : key), el('span', 'tree-colon', ':'));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.nodeMenu(e, path || '.', value);
  });
  node.append(row);
  if (!isContainer(value)) {
    row.append(primitive(value));
    return node;
  }
  const list = entries(value);
  const array = Array.isArray(value);
  const summary = el('span', 'tree-summary', list.length === 0 ? (array ? '[]' : '{}') : array ? `[ ${list.length} ]` : `{ ${list.length} }`);
  row.append(summary);
  if (list.length === 0) return node;
  node.classList.add('container');
  const children = el('div', 'tree-children');
  node.append(children);
  let shown = 0;
  const more = () => {
    const end = Math.min(list.length, shown + PAGE);
    children.querySelector('.tree-more')?.remove();
    for (; shown < end; shown++) {
      const [k, v] = list[shown];
      children.append(treeNode(k, v, pathKey(path, k), depth + 1, ctx));
    }
    if (shown < list.length) {
      const button = el('button', 'tree-more', `Show ${Math.min(PAGE, list.length - shown)} more of ${list.length - shown}`);
      button.addEventListener('click', more);
      children.append(button);
    }
  };
  const setOpen = (open: boolean) => {
    node.classList.toggle('open', open);
    if (open && shown === 0) more();
  };
  setOpen(ctx.toggled.get(path) ?? depth < 2);
  row.addEventListener('click', () => {
    const open = !node.classList.contains('open');
    ctx.toggled.set(path, open);
    setOpen(open);
  });
  return node;
}

export function renderTree(value: unknown, ctx: RenderContext): HTMLElement {
  const tree = el('div', 'viewer-tree');
  tree.append(treeNode(null, value, '', 0, ctx));
  return tree;
}

export function renderCsv(text: string, separator: string): HTMLElement {
  const rows = parseCsv(text, separator);
  const box = el('div', 'viewer-table');
  const table = el('table');
  const [header = [], ...body] = rows;
  const head = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', 'row-number'));
  for (const cell of header) headRow.append(el('th', '', cell));
  head.append(headRow);
  const tbody = el('tbody');
  body.slice(0, MAX_ROWS).forEach((cells, i) => {
    const tr = el('tr');
    tr.append(el('td', 'row-number', String(i + 1)));
    for (const cell of cells) tr.append(el('td', /^-?[\d.,]+%?$/.test(cell.trim()) ? 'number' : '', cell));
    tbody.append(tr);
  });
  table.append(head, tbody);
  if (body.length > MAX_ROWS) box.append(notice(`Showing the first ${MAX_ROWS.toLocaleString()} of ${body.length.toLocaleString()} rows.`));
  box.append(table);
  return box;
}

export function renderImage(base64: string, type: string): HTMLElement {
  const box = el('div', 'viewer-image');
  const image = el('img');
  image.src = `data:${type};base64,${base64}`;
  image.alt = '';
  // A click shows the image at its own size, and again fits it.
  image.addEventListener('click', () => box.classList.toggle('actual'));
  box.append(image);
  return box;
}

/** An HTML page in a sandboxed frame; `version` makes it load again after the file changed. */
export function renderHtml(viewerId: string, version: number): HTMLElement {
  const frame = el('iframe', 'viewer-frame');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.src = `senju-view://${viewerId}/?v=${Math.round(version)}`;
  return frame;
}
