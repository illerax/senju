// An overview of every agent: a grid of cards with each agent's status and the
// last lines of its screen. A click, or Enter on a card, goes to that agent.

import type { AgentKind } from '../shared/agent-status';

/** Lines of each agent's screen a card shows. */
export const OVERVIEW_LINES = 14;

export interface OverviewCard {
  terminalId: string;
  name: string;
  kind: AgentKind;
  /** The status with how long it has lasted, e.g. "finished 12m". */
  text: string;
  activity?: string;
  /** Group and workspace. */
  place: string;
  /** What the agent runs with: configuration, account, model. */
  profile?: string;
  /** How full its context is, e.g. "context 42%". */
  context?: string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

interface CardElements {
  card: HTMLButtonElement;
  name: HTMLElement;
  status: HTMLElement;
  place: HTMLElement;
  activity: HTMLElement;
  profile: HTMLElement;
  screen: HTMLElement;
}

export class Overview {
  readonly element = el('section', 'overview');
  private readonly grid = el('div', 'overview-grid');
  private readonly empty = el('p', 'overview-empty', 'No agents are running. Start Claude Code or another agent in a terminal, and it shows up here.');
  private readonly cards = new Map<string, CardElements>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ctx: {
      /** The agents to show, in order. */
      cards: () => OverviewCard[];
      /** Asks the daemon for the screens; they arrive through `screens`. */
      peek: (terminalIds: string[]) => void;
      open: (terminalId: string) => void;
      /** The overview opened or closed. */
      onToggle: (open: boolean) => void;
    },
  ) {
    this.element.hidden = true;
    const head = el('div', 'overview-head');
    head.append(el('h2', '', 'All agents'), el('span', 'overview-hint', 'Enter or click to go to an agent · Esc to close'));
    this.element.append(head, this.grid, this.empty);
    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        return;
      }
      const step = { ArrowRight: 1, ArrowDown: this.columns(), ArrowLeft: -1, ArrowUp: -this.columns() }[e.key];
      if (!step) return;
      e.preventDefault();
      const cards = [...this.grid.children] as HTMLElement[];
      const index = cards.indexOf(document.activeElement as HTMLElement);
      cards[Math.max(0, Math.min(cards.length - 1, index < 0 ? 0 : index + step))]?.focus();
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  open(): void {
    if (this.isOpen) return;
    this.element.hidden = false;
    this.ctx.onToggle(true);
    this.update();
    (this.grid.firstElementChild as HTMLElement | null)?.focus();
    // Screens change all the time; the state broadcast does not carry them.
    this.timer = setInterval(() => this.requestScreens(), 1000);
  }

  close(): void {
    if (!this.isOpen) return;
    this.element.hidden = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ctx.onToggle(false);
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Updates the cards in place, so the focused card keeps its focus. */
  update(): void {
    if (!this.isOpen) return;
    const list = this.ctx.cards();
    const elements = list.map((card) => {
      const e = this.cardElements(card.terminalId);
      e.card.className = `overview-card ${card.kind}`;
      e.name.textContent = card.name;
      e.status.textContent = card.text;
      e.place.textContent = card.place;
      e.activity.textContent = card.activity ?? '';
      e.activity.hidden = !card.activity;
      const profile = [card.context, card.profile].filter(Boolean).join(' · ');
      if (e.profile.title !== profile) {
        // Each part stays whole; lines break between parts only.
        e.profile.replaceChildren(...profile.split(' · ').flatMap((part, i) => [...(i ? [' · '] : []), el('span', '', part)]));
        e.profile.title = profile;
      }
      e.profile.hidden = !profile;
      e.card.title = `Go to ${card.name} in ${card.place}`;
      return e.card;
    });
    elements.forEach((child, i) => {
      if (this.grid.children[i] !== child) this.grid.insertBefore(child, this.grid.children[i] ?? null);
    });
    while (this.grid.children.length > elements.length) this.grid.lastElementChild!.remove();
    for (const id of this.cards.keys()) if (!list.some((c) => c.terminalId === id)) this.cards.delete(id);
    this.empty.hidden = list.length > 0;
    this.requestScreens();
  }

  /** The daemon's answer to a peek. */
  screens(screens: Record<string, string[]>): void {
    for (const [id, lines] of Object.entries(screens)) {
      const screen = this.cards.get(id)?.screen;
      const text = lines.join('\n');
      if (screen && screen.textContent !== text) screen.textContent = text;
    }
  }

  private requestScreens(): void {
    if (this.cards.size) this.ctx.peek([...this.cards.keys()]);
  }

  private columns(): number {
    const cards = [...this.grid.children] as HTMLElement[];
    const top = cards[0]?.offsetTop;
    const count = cards.filter((c) => c.offsetTop === top).length;
    return Math.max(1, count);
  }

  private cardElements(terminalId: string): CardElements {
    let e = this.cards.get(terminalId);
    if (e) return e;
    const card = el('button', 'overview-card');
    card.type = 'button';
    const header = el('div', 'overview-card-head');
    const name = el('span', 'overview-name');
    const status = el('span', 'overview-status');
    const place = el('span', 'overview-place');
    header.append(name, status, place);
    const activity = el('div', 'overview-activity');
    const profile = el('div', 'overview-profile');
    const screen = el('pre', 'overview-screen');
    card.append(header, profile, activity, screen);
    card.addEventListener('click', () => {
      this.close();
      this.ctx.open(terminalId);
    });
    e = { card, name, status, place, activity, profile, screen };
    this.cards.set(terminalId, e);
    return e;
  }
}
