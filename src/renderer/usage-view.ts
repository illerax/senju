// The usage window of an agent: how full its context is and with what, and
// the tokens of its session, its tab and its workspace. The daemon reads the
// agent's session files (daemon/usage.ts); the window asks again while open.

import { contextPercent, formatTokens, totalTokens, type TokenCounts, type UsageDetails } from '../shared/usage';

const REFRESH_MS = 3000;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

/** The level of a context fill, also its CSS class: amber from 60%, red from 85%. */
export function contextLevel(percent: number): 'low' | 'high' | 'full' {
  return percent >= 85 ? 'full' : percent >= 60 ? 'high' : 'low';
}

const time = (at: number) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

export class UsageView {
  private backdrop: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private terminalId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private previousFocus: HTMLElement | null = null;
  private profile: HTMLElement | null = null;

  constructor(
    private readonly ctx: {
      /** Asks the daemon; the answer arrives through `show`. */
      request: (terminalId: string) => void;
      name: (terminalId: string) => string;
      /** What the agent runs with, in one line. */
      profile: (terminalId: string) => string;
    },
  ) {}

  open(terminalId: string): void {
    this.close();
    this.terminalId = terminalId;
    this.previousFocus = document.activeElement as HTMLElement | null;
    const backdrop = el('div', 'dialog-backdrop');
    const dialog = el('div', 'dialog usage');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;
    const head = el('div', 'usage-head');
    const titles = el('div', 'usage-titles');
    titles.append(el('h2', 'dialog-title', `${this.ctx.name(terminalId)} · context and tokens`));
    this.profile = el('p', 'usage-profile', this.ctx.profile(terminalId));
    titles.append(this.profile);
    const close = el('button', 'button', 'Close');
    close.addEventListener('click', () => this.close());
    head.append(titles, close);
    this.body = el('div', 'usage-body');
    this.body.append(el('p', 'usage-note', 'Reading the session…'));
    dialog.append(head, this.body);
    backdrop.append(dialog);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    document.body.append(backdrop);
    dialog.focus();
    this.backdrop = backdrop;
    this.ctx.request(terminalId);
    this.timer = setInterval(() => this.terminalId && this.ctx.request(this.terminalId), REFRESH_MS);
  }

  close(): void {
    if (!this.backdrop) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.backdrop.remove();
    this.backdrop = this.body = null;
    this.terminalId = null;
    this.previousFocus?.focus?.();
  }

  /** The daemon's answer. */
  show(terminalId: string, details: UsageDetails | null): void {
    if (!this.body || terminalId !== this.terminalId) return;
    const scroll = this.body.scrollTop;
    if (this.profile) this.profile.textContent = this.ctx.profile(terminalId);
    this.body.replaceChildren(...(details ? this.render(details) : [el('p', 'usage-note', "This agent's session can't be read: Senju reads the sessions of Claude Code and Codex once they have answered at least once.")]));
    this.body.scrollTop = scroll;
  }

  private render(d: UsageDetails): HTMLElement[] {
    const out: HTMLElement[] = [];

    // How full the context is.
    const percent = contextPercent(d);
    const context = el('section', 'usage-section');
    const summary = el('div', 'usage-context');
    const amount = el('span', 'usage-context-amount', formatTokens(d.context));
    const of = d.window ? ` of ${d.window.exact ? '' : '≈'}${formatTokens(d.window.tokens)}` : '';
    summary.append(amount, el('span', 'usage-muted', `tokens in context${of}${percent !== null ? ` · ${percent}%` : ''}${d.model ? ` · ${d.model}` : ''}`));
    context.append(summary);
    if (percent !== null) {
      const bar = el('div', `usage-bar ${contextLevel(percent)}`);
      const fill = el('div', 'usage-bar-fill');
      fill.style.width = `${percent}%`;
      bar.append(fill);
      context.append(bar);
    }
    if (d.window && !d.window.exact) {
      context.append(el('p', 'usage-note', "The agent doesn't record its context window; the size comes from the agent's recipe."));
    }
    for (const c of d.compactions) {
      context.append(el('p', 'usage-note', `Compacted at ${time(c.at)}: ${formatTokens(c.before)} → ${formatTokens(c.after)}`));
    }
    out.push(context);

    // What fills it.
    if (d.parts.length) {
      const parts = el('section', 'usage-section');
      parts.append(el('h3', '', 'What fills the context'));
      parts.append(el('p', 'usage-note', 'Estimated: the agent reports only the size of each request, so what each request added is split by the size of its text.'));
      const largest = Math.max(...d.parts.map((p) => p.tokens));
      const list = el('div', 'usage-parts');
      for (const part of d.parts) {
        const row = el('div', 'usage-part');
        const bar = el('div', 'usage-part-bar');
        bar.style.width = `${Math.max(1, (part.tokens / largest) * 100)}%`;
        const label = el('span', 'usage-part-label', part.label);
        label.title = part.label;
        row.append(label, el('span', 'usage-part-tokens', formatTokens(part.tokens)), el('span', 'usage-part-track'));
        row.lastElementChild!.append(bar);
        list.append(row);
      }
      parts.append(list);
      out.push(parts);
    }

    // Tokens.
    const tokens = el('section', 'usage-section');
    tokens.append(el('h3', '', 'Tokens used'));
    const table = el('table', 'usage-table');
    const header = el('tr');
    for (const name of ['', 'Input', 'Cache read', 'Cache write', 'Output', 'Total']) header.append(el('th', '', name));
    table.append(header);
    const row = (name: string, t: TokenCounts, title = '') => {
      const tr = el('tr');
      const th = el('th', '', name);
      if (title) th.title = title;
      tr.append(th);
      for (const n of [t.input, t.cacheRead, t.cacheWrite, t.output, totalTokens(t)]) tr.append(el('td', '', formatTokens(n)));
      table.append(tr);
    };
    const sub = totalTokens(d.session.subagents);
    row('This session', d.session.tokens, `${d.session.requests} requests${sub ? `, subagents included (${formatTokens(sub)})` : ''}`);
    if (d.tab.sessions > 1) row(`This tab, ${d.tab.sessions} sessions`, d.tab.tokens);
    if (d.workspace.sessions > 1 && d.workspace.sessions !== d.tab.sessions) row(`Workspace, ${d.workspace.sessions} sessions`, d.workspace.tokens, 'Every agent session of this workspace, closed tabs included');
    tokens.append(table);
    const notes: string[] = [];
    if (sub) notes.push(`Subagents used ${formatTokens(sub)} of this session.`);
    for (const note of notes) tokens.append(el('p', 'usage-note', note));
    out.push(tokens);

    // By message.
    if (d.prompts.length) {
      const prompts = el('section', 'usage-section');
      prompts.append(el('h3', '', 'By message'));
      const list = el('table', 'usage-table usage-prompts');
      const head = el('tr');
      for (const name of ['', 'Message', 'Requests', 'Output', 'Total']) head.append(el('th', '', name));
      list.append(head);
      for (const p of d.prompts) {
        const tr = el('tr');
        const text = el('td', 'usage-prompt-text', p.text);
        text.title = p.text;
        tr.append(el('td', 'usage-muted', time(p.at)), text, el('td', '', String(p.requests)), el('td', '', formatTokens(p.tokens.output)), el('td', '', formatTokens(totalTokens(p.tokens))));
        list.append(tr);
      }
      prompts.append(list);
      out.push(prompts);
    }
    return out;
  }
}
