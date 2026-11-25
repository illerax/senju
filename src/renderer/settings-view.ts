// The settings page: keyboard shortcuts and themes. Every change is saved
// right away and applied to the running window.

import type { NeedReason } from '../shared/agent-status';
import { commandCategories, commandIds, commands, commandScope, defaultBindings, type Command, type CommandCategory } from '../shared/commands';
import type { Settings } from '../shared/settings';
import type { UpdateAction, UpdateStatus } from '../shared/update';
import { builtinThemes, resolveFont, resolveTheme, themeKeys, type Font, type Theme, type ThemeColor } from '../shared/themes';
import { openColorPicker } from './color-picker';
import { iconButton, iconSvg } from './icons';
import { showMenu, type MenuItem } from './menu';
import { eventToAccelerator, isRiskyAccelerator, Keymap, normalizeAccelerator } from './keymap';

export interface AppInfo {
  version: string;
  build: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  daemonOutdated: boolean;
}

export interface SettingsContext {
  platform: string;
  appInfo: () => Promise<AppInfo>;
  updateStatus: () => Promise<UpdateStatus>;
  updateAction: (action: UpdateAction) => void;
  copy: (text: string) => void;
  settings: () => Settings;
  save: (patch: Partial<Settings>) => Promise<void>;
  openSettingsFile: () => void;
  openRecipesFolder: () => void;
  /** Shows diagnostics.log in the file manager. */
  showLogs: () => void;
  reportIssue: () => void;
  stopAll: () => void;
  /** Asks, then restarts the background service from the current build. */
  restartDaemon: () => void;
  confirm: (message: string, detail: string) => Promise<boolean>;
}

type Page = 'shortcuts' | 'theme' | 'notifications' | 'about';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const themeLabels: Record<ThemeColor, string> = {
  background: 'Background',
  foreground: 'Foreground',
  cursor: 'Cursor',
  selectionBackground: 'Selection',
  black: 'Black',
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
  magenta: 'Magenta',
  cyan: 'Cyan',
  white: 'White',
  brightBlack: 'Bright black',
  brightRed: 'Bright red',
  brightGreen: 'Bright green',
  brightYellow: 'Bright yellow',
  brightBlue: 'Bright blue',
  brightMagenta: 'Bright magenta',
  brightCyan: 'Bright cyan',
  brightWhite: 'Bright white',
};

export class SettingsView {
  readonly element = el('div', 'settings');
  private readonly content = el('div', 'settings-content');
  private readonly navButtons = new Map<Page, HTMLButtonElement>();
  private readonly categoryButtons = new Map<CommandCategory, HTMLButtonElement>();
  private readonly categoryNav = el('div', 'settings-subnav');
  private page: Page = 'shortcuts';
  /** The group of shortcuts shown; null shows all of them. */
  private category: CommandCategory | null = null;
  private filter = '';
  private notice = '';
  /** The shortcut being recorded: a command and the index of the replaced shortcut, or -1 to add one. */
  private recording: { command: Command; index: number } | null = null;
  private editingTheme: string | null = null;
  private saveTimer: number | null = null;

  constructor(private readonly ctx: SettingsContext) {
    this.element.hidden = true;
    const nav = el('nav', 'settings-nav');
    const header = el('div', 'settings-header');
    const close = iconButton('close', 'Close settings', 'settings-close');
    close.title = 'Close (Escape)';
    close.addEventListener('click', () => this.close());
    header.append(close, el('div', 'settings-title', 'Settings'));
    nav.append(header);
    for (const [page, label] of [
      ['shortcuts', 'Keyboard Shortcuts'],
      ['theme', 'Theme'],
      ['notifications', 'Notifications'],
      ['about', 'About'],
    ] as const) {
      const button = el('button', 'settings-nav-item', label);
      button.addEventListener('click', () => {
        if (page === 'shortcuts') this.category = null;
        this.show(page);
      });
      this.navButtons.set(page, button);
      nav.append(button);
      if (page === 'shortcuts') nav.append(this.categoryNav);
    }
    for (const category of commandCategories) {
      const button = el('button', 'settings-nav-item sub', category);
      button.addEventListener('click', () => {
        this.category = category;
        this.show('shortcuts');
      });
      this.categoryButtons.set(category, button);
      this.categoryNav.append(button);
    }
    nav.append(el('div', 'settings-spacer'));
    const action = (label: string, run: () => void, icon: Parameters<typeof iconSvg>[0], extra = '') => {
      const button = el('button', `settings-nav-item subtle ${extra}`.trim());
      button.innerHTML = iconSvg(icon, 14);
      button.append(label);
      button.addEventListener('click', run);
      nav.append(button);
    };
    action('Open settings.json', () => ctx.openSettingsFile(), 'file');
    action('Open agent recipes folder', () => ctx.openRecipesFolder(), 'folder');
    nav.append(el('div', 'settings-separator'));
    action('Quit and stop all processes', () => ctx.stopAll(), 'power', 'danger');
    this.element.append(nav, this.content);

    // Capture phase, so a shortcut being recorded never reaches the app or a terminal.
    window.addEventListener(
      'keydown',
      (e) => {
        // A menu, dialog or color picker on top handles its own keys.
        if (this.element.hidden || document.querySelector('.menu, .dialog-backdrop, .color-popover')) return;
        if (this.recording) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') {
            this.recording = null;
            this.render();
            return;
          }
          const accelerator = eventToAccelerator(e);
          if (accelerator) this.record(accelerator);
          return;
        }
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        // The first Escape clears a search, the next closes the settings.
        if (e.target instanceof HTMLInputElement && e.target.classList.contains('settings-search') && e.target.value) {
          this.filter = '';
          this.render();
        } else {
          this.close();
        }
      },
      true,
    );
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  show(page: Page = this.page): void {
    this.page = page;
    this.element.hidden = false;
    this.recording = null;
    this.notice = '';
    this.render();
  }

  close(): void {
    this.element.hidden = true;
    this.recording = null;
    this.element.dispatchEvent(new Event('close'));
  }

  render(): void {
    if (this.element.hidden) return;
    const shortcuts = this.page === 'shortcuts';
    for (const [page, button] of this.navButtons) button.classList.toggle('active', page === this.page && !(shortcuts && this.category));
    this.categoryNav.hidden = !shortcuts;
    for (const [category, button] of this.categoryButtons) button.classList.toggle('active', shortcuts && category === this.category);
    const scroll = this.content.scrollTop;
    const pages: Record<Page, () => HTMLElement> = {
      shortcuts: () => this.shortcutsPage(),
      theme: () => this.themePage(),
      notifications: () => this.notificationsPage(),
      about: () => this.aboutPage(),
    };
    this.content.replaceChildren(pages[this.page]());
    this.content.scrollTop = scroll;
  }

  // --- notifications ---

  private notificationsPage(): HTMLElement {
    const page = el('div', 'settings-page');
    page.append(el('h2', '', 'Notifications'));
    const settings = this.ctx.settings();
    const checkbox = (text: string, checked: boolean, change: (checked: boolean) => void, disabled = false) => {
      const label = el('label', 'checkbox');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = checked;
      box.disabled = disabled;
      box.addEventListener('change', () => change(box.checked));
      label.append(box, document.createTextNode(text));
      return label;
    };
    page.append(
      checkbox('Notify me when an agent I am not looking at needs me', settings.notifications, (on) => void this.ctx.save({ notifications: on }).then(() => this.render())),
      el(
        'p',
        'settings-hint',
        'A system notification tells you when an agent in another workspace or tab, or in a window you are not using, needs you. Clicking it shows that agent. The app icon and the window title count the agents waiting for you either way.',
      ),
      el('h3', '', 'Notify when an agent'),
    );
    const reasons: [NeedReason, string][] = [
      ['permission', 'Asks for permission'],
      ['question', 'Has a question'],
      ['finished', 'Finished its task'],
      ['failed', 'Failed, e.g. on a rate limit'],
      ['input', 'Waits for input (agents that do not report their status)'],
    ];
    for (const [reason, text] of reasons) {
      page.append(
        checkbox(text, settings.notifyOn[reason], (on) => void this.ctx.save({ notifyOn: { ...this.ctx.settings().notifyOn, [reason]: on } }), !settings.notifications),
      );
    }
    return page;
  }

  // --- about ---

  private aboutPage(): HTMLElement {
    const page = el('div', 'settings-page about');
    const head = el('div', 'about-head');
    const mark = el('img', 'about-mark');
    mark.src = 'icon.svg';
    mark.alt = 'Senju';
    const names = el('div', 'about-names');
    names.append(el('h2', '', 'Senju'), el('div', 'about-tagline', 'The IDE for multitasking in the age of AI'));
    head.append(mark, names);
    page.append(head);
    page.append(
      el(
        'p',
        'about-text',
        'Senju (千手, "a thousand hands") keeps your projects in groups of workspaces, each split into panes of terminal tabs. Terminals keep running when the window closes, and after a reboot agents such as Claude Code resume their own sessions.',
      ),
    );
    const facts = el('dl', 'about-facts');
    page.append(facts);
    const updates = el('div', 'about-updates');
    void this.ctx.updateStatus().then((status) => updates.replaceChildren(...this.updateSection(status)));
    void this.ctx.appInfo().then((info) => {
      const rows: [string, string][] = [
        ['Version', info.version],
        ['Build', info.build],
        ['Background service', info.daemonOutdated ? 'outdated, restart it below' : 'up to date'],
        ['Electron', info.electron],
        ['Chromium', info.chrome],
        ['Node.js', info.node],
        ['Platform', info.platform],
      ];
      for (const [term, value] of rows) facts.append(el('dt', '', term), el('dd', '', value));
      const copy = el('button', 'button', 'Copy version info');
      copy.addEventListener('click', () => {
        this.ctx.copy(rows.map(([t, v]) => `${t}: ${v}`).join('\n'));
        copy.textContent = 'Copied';
      });
      page.append(copy, updates, ...this.serviceSection(), ...this.problemSection());
    });
    return page;
  }

  private serviceSection(): HTMLElement[] {
    const text = el(
      'p',
      'settings-hint',
      'The background service runs every terminal and keeps them alive while windows are closed. Restart it when it misbehaves or still runs an older build: it saves everything and starts again, and terminals come back as after a reboot.',
    );
    const actions = el('div', 'theme-actions');
    const restart = el('button', 'button', 'Restart background service');
    restart.addEventListener('click', () => this.ctx.restartDaemon());
    actions.append(restart);
    return [el('h3', '', 'Background service'), text, actions];
  }

  private problemSection(): HTMLElement[] {
    const text = el(
      'p',
      'settings-hint',
      'Senju records hangs and errors, with the system they happened on, in diagnostics.log. Attach it to your report: it holds no terminal contents, commands, user or host names, and takes at most two megabytes.',
    );
    const actions = el('div', 'theme-actions');
    const show = el('button', 'button', 'Show diagnostics.log');
    show.addEventListener('click', () => this.ctx.showLogs());
    const report = el('button', 'button', 'Report a problem');
    report.addEventListener('click', () => this.ctx.reportIssue());
    actions.append(show, report);
    return [el('h3', '', 'Problems'), text, actions];
  }

  private updateSection(status: UpdateStatus): HTMLElement[] {
    const describe: Record<UpdateStatus['state'], string> = {
      idle: 'Not checked yet.',
      unsupported: status.state === 'unsupported' ? status.reason : '',
      checking: 'Checking for updates…',
      current: status.state === 'current' ? `Senju is up to date (checked ${new Date(status.checkedAt).toLocaleTimeString()}).` : '',
      available: status.state === 'available' ? `Senju ${status.version} is available.` : '',
      downloading: status.state === 'downloading' ? `Downloading Senju ${status.version}… ${status.percent}%` : '',
      ready: status.state === 'ready' ? `Senju ${status.version} is downloaded and installs when the app restarts.` : '',
      error: status.state === 'error' ? `The last check failed: ${status.message}` : '',
    };
    const heading = el('h3', '', 'Updates');
    const text = el('p', 'settings-hint', describe[status.state]);
    const actions = el('div', 'theme-actions');
    const button = (label: string, action: UpdateAction, primary = false) => {
      const b = el('button', `button${primary ? ' primary' : ''}`, label);
      b.addEventListener('click', () => this.ctx.updateAction(action));
      return b;
    };
    if (status.state === 'available') actions.append(button(status.manual ? 'Download' : 'Download and install', 'download', true));
    if (status.state === 'ready') actions.append(button('Restart and install', 'install', true));
    if (status.state !== 'unsupported' && status.state !== 'checking' && status.state !== 'downloading') actions.append(button('Check for updates', 'check'));
    const auto = el('label', 'checkbox');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = this.ctx.settings().checkForUpdates;
    box.addEventListener('change', () => void this.ctx.save({ checkForUpdates: box.checked }));
    auto.append(box, document.createTextNode('Check for updates automatically'));
    const note = el(
      'p',
      'settings-hint',
      'Senju looks for a new release at start and every few hours, and only downloads and installs it when you agree. Your settings stay as they are, and running terminals keep running through the update.',
    );
    return [heading, text, actions, auto, note];
  }

  // --- shortcuts ---

  private keymap(): Keymap {
    return new Keymap(this.ctx.platform, this.ctx.settings().keybindings);
  }

  private shortcutsPage(): HTMLElement {
    const page = el('div', 'settings-page');
    page.append(el('h2', '', this.category ? `Keyboard Shortcuts: ${this.category}` : 'Keyboard Shortcuts'));
    page.append(
      el(
        'p',
        'settings-hint',
        this.category === 'Copy mode'
          ? 'These keys work only in copy mode, which takes every key away from the program in the terminal, so plain keys are fine. Click a key to change it, or + to add another one.'
          : 'Click a shortcut to change it, or + to add another one. Shortcuts with Ctrl+Shift (Cmd on macOS) never collide with programs running in a terminal.',
      ),
    );
    const search = el('input', 'settings-search');
    search.type = 'text';
    search.placeholder = 'Search commands or keys';
    search.value = this.filter;
    search.addEventListener('input', () => {
      this.filter = search.value;
      const pos = search.selectionStart;
      this.render();
      const next = this.content.querySelector<HTMLInputElement>('.settings-search');
      next?.focus();
      next?.setSelectionRange(pos, pos);
    });
    page.append(search);
    if (this.notice) page.append(el('div', 'settings-notice', this.notice));

    const keymap = this.keymap();
    const overrides = this.ctx.settings().keybindings;
    const query = this.filter.trim().toLowerCase();
    for (const category of this.category ? [this.category] : commandCategories) {
      const rows = commandIds.filter((id) => {
        const info = commands[id];
        if (info.category !== category) return false;
        return !query || info.label.toLowerCase().includes(query) || keymap.shortcuts(id).some((s) => s.toLowerCase().includes(query));
      });
      if (rows.length === 0) continue;
      if (!this.category) page.append(el('h3', '', category));
      const table = el('div', 'shortcut-table');
      for (const command of rows) table.append(this.shortcutRow(command, keymap, command in overrides));
      page.append(table);
    }
    return page;
  }

  private shortcutRow(command: Command, keymap: Keymap, overridden: boolean): HTMLElement {
    const row = el('div', 'shortcut-row');
    row.append(el('span', 'shortcut-label', commands[command].label));
    const keys = el('span', 'shortcut-keys');
    const shortcuts = keymap.shortcuts(command);
    shortcuts.forEach((accelerator, index) => {
      const recording = this.recording?.command === command && this.recording.index === index;
      const risky = commandScope(command) === 'app' && isRiskyAccelerator(accelerator);
      const chip = el('span', `key-chip${recording ? ' recording' : ''}${risky ? ' risky' : ''}`);
      if (risky) chip.title = 'Programs in the terminal will not receive this key';
      const text = el('button', 'key-chip-text', recording ? 'Press keys…' : accelerator);
      text.addEventListener('click', () => this.startRecording(command, index));
      const remove = iconButton('close', 'Remove shortcut', 'key-chip-remove');
      remove.addEventListener('click', () => this.setShortcuts(command, shortcuts.filter((_, i) => i !== index)));
      chip.append(text, remove);
      keys.append(chip);
    });
    if (this.recording?.command === command && this.recording.index === -1) {
      keys.append(el('span', 'key-chip recording', 'Press keys…'));
    } else {
      const add = iconButton('plus', 'Add shortcut', 'shortcut-add');
      add.addEventListener('click', () => this.startRecording(command, -1));
      keys.append(add);
    }
    if (shortcuts.length === 0 && !this.recording) keys.prepend(el('span', 'shortcut-none', 'None'));
    row.append(keys);
    const reset = el('button', 'button small shortcut-reset', 'Reset');
    reset.hidden = !overridden;
    reset.title = `Default: ${defaultBindings(command, this.ctx.platform).join(', ') || 'none'}`;
    reset.addEventListener('click', () => this.setShortcuts(command, null));
    row.append(reset);
    return row;
  }

  private startRecording(command: Command, index: number): void {
    this.recording = { command, index };
    this.notice = '';
    this.render();
  }

  private record(accelerator: string): void {
    const target = this.recording;
    if (!target) return;
    const normalized = normalizeAccelerator(accelerator);
    if (!normalized) return;
    this.recording = null;
    const keymap = this.keymap();
    const overrides = { ...this.ctx.settings().keybindings };
    // A shortcut belongs to one command: take it away from any other.
    const scope = commandScope(target.command);
    const taken = keymap.commandsFor(normalized, scope).filter((c) => c !== target.command);
    for (const other of taken) overrides[other] = keymap.shortcuts(other).filter((s) => s !== normalized);
    const current = [...keymap.shortcuts(target.command)];
    if (target.index >= 0 && target.index < current.length) current[target.index] = normalized;
    else current.push(normalized);
    overrides[target.command] = [...new Set(current)];
    this.notice = taken.length ? `${normalized} was removed from: ${taken.map((c) => commands[c].label).join(', ')}.` : '';
    if (scope === 'app' && isRiskyAccelerator(normalized)) this.notice += `${this.notice ? ' ' : ''}${normalized} has no Ctrl or Cmd, so programs in the terminal will no longer receive it.`;
    void this.saveKeybindings(overrides);
  }

  /** Sets a command's shortcuts; null restores the defaults. */
  private setShortcuts(command: Command, shortcuts: string[] | null): void {
    const overrides = { ...this.ctx.settings().keybindings };
    if (shortcuts === null) delete overrides[command];
    else overrides[command] = shortcuts;
    this.notice = '';
    void this.saveKeybindings(overrides);
  }

  private async saveKeybindings(overrides: Settings['keybindings']): Promise<void> {
    // Drop overrides that equal the defaults.
    for (const command of Object.keys(overrides) as Command[]) {
      if (JSON.stringify(overrides[command]) === JSON.stringify(defaultBindings(command, this.ctx.platform))) delete overrides[command];
    }
    await this.ctx.save({ keybindings: overrides });
    this.render();
  }

  // --- themes ---

  private themePage(): HTMLElement {
    const settings = this.ctx.settings();
    const page = el('div', 'settings-page');
    page.append(el('h2', '', 'Theme'));

    const grid = el('div', 'theme-grid');
    const names = [...Object.keys(builtinThemes), ...Object.keys(settings.themes).filter((n) => !(n in builtinThemes))];
    for (const name of names) {
      const custom = name in settings.themes;
      const colors = resolveTheme({ theme: name, themes: settings.themes });
      const card = el('button', `theme-card${name === settings.theme ? ' active' : ''}`);
      card.append(themePreview(colors, true, resolveFont({ ...settings, theme: name })));
      const label = el('div', 'theme-name', name);
      if (custom) label.append(el('span', 'theme-badge', 'custom'));
      card.append(label);
      card.addEventListener('click', () => {
        this.editingTheme = custom && this.editingTheme ? name : null;
        void this.ctx.save({ theme: name }).then(() => this.render());
      });
      grid.append(card);
    }
    page.append(grid);

    const actions = el('div', 'theme-actions');
    const create = el('button', 'button', 'New theme from selected');
    create.addEventListener('click', () => void this.createTheme());
    actions.append(create);
    if (settings.theme in settings.themes) {
      const edit = el('button', 'button', this.editingTheme === settings.theme ? 'Done editing' : 'Edit');
      edit.addEventListener('click', () => {
        this.editingTheme = this.editingTheme === settings.theme ? null : settings.theme;
        this.render();
      });
      const remove = el('button', 'button danger', 'Delete');
      remove.addEventListener('click', () => void this.deleteTheme(settings.theme));
      actions.append(edit, remove);
    }
    page.append(actions);

    if (this.editingTheme && this.editingTheme === settings.theme && settings.themes[this.editingTheme]) page.append(this.themeEditor(this.editingTheme));

    page.append(el('h3', '', 'Default font'));
    page.append(el('p', 'settings-hint', 'Used by built-in themes and by custom themes that do not set their own font.'));
    page.append(
      fontFields(settings, null, (patch) => {
        // Undefined resets a field to its default.
        void this.ctx.save(patch);
      }),
    );
    return page;
  }

  private async createTheme(): Promise<void> {
    const settings = this.ctx.settings();
    const base = resolveTheme(settings);
    let n = 1;
    while (`Custom ${n}` in settings.themes || `Custom ${n}` in builtinThemes) n++;
    const name = `Custom ${n}`;
    this.editingTheme = name;
    await this.ctx.save({ themes: { ...settings.themes, [name]: base }, theme: name });
    this.render();
  }

  private async deleteTheme(name: string): Promise<void> {
    if (!(await this.ctx.confirm(`Delete theme “${name}”?`, 'This cannot be undone.'))) return;
    const themes = { ...this.ctx.settings().themes };
    delete themes[name];
    this.editingTheme = null;
    await this.ctx.save({ themes, theme: undefined });
    this.render();
  }

  private themeEditor(name: string): HTMLElement {
    const editor = el('div', 'theme-editor');
    const nameInput = el('input', 'settings-input');
    nameInput.type = 'text';
    nameInput.value = name;
    nameInput.addEventListener('change', () => void this.renameTheme(name, nameInput.value.trim()));
    editor.append(field('Name', nameInput));

    const preview = el('div', 'theme-editor-preview');
    const updatePreview = () => {
      const settings = this.ctx.settings();
      preview.replaceChildren(themePreview(settings.themes[name], false, resolveFont({ ...settings, theme: name })));
    };
    updatePreview();

    const groups: [string, ThemeColor[]][] = [
      ['Base', themeKeys.slice(0, 4)],
      ['Normal', themeKeys.slice(4, 12)],
      ['Bright', themeKeys.slice(12)],
    ];
    const columns = el('div', 'theme-colors');
    for (const [title, keys] of groups) {
      const column = el('div', 'theme-color-group');
      column.append(el('h4', '', title));
      for (const key of keys) {
        const row = el('div', 'color-row');
        const picker = el('button', 'color-swatch');
        picker.type = 'button';
        picker.setAttribute('aria-label', `Pick ${themeLabels[key].toLowerCase()} color`);
        const text = el('input', 'input color-text');
        text.type = 'text';
        text.setAttribute('aria-label', `${themeLabels[key]} hex`);
        const value = this.ctx.settings().themes[name][key];
        picker.style.background = value;
        text.value = value;
        const set = (color: string) => {
          if (!/^#[0-9a-f]{6}$/i.test(color)) return;
          const themes = this.ctx.settings().themes;
          themes[name] = { ...themes[name], [key]: color };
          picker.style.background = color;
          text.value = color;
          updatePreview();
          this.queueSave({ themes: { ...themes } });
        };
        picker.addEventListener('click', () => openColorPicker(picker, text.value, set));
        text.addEventListener('change', () => set(text.value.trim()));
        row.append(picker, el('span', 'color-label', themeLabels[key]), text);
        column.append(row);
      }
      columns.append(column);
    }
    const font = el('div', 'theme-font');
    font.append(el('h4', '', 'Font'), el('p', 'settings-hint', 'Leave a field empty to use the default font.'));
    const own = this.ctx.settings().themes[name].font ?? {};
    font.append(
      fontFields(own, this.ctx.settings(), (patch) => {
        const themes = this.ctx.settings().themes;
        const next: Partial<Font> = { ...(themes[name].font ?? {}), ...patch };
        for (const key of Object.keys(next) as (keyof Font)[]) if (next[key] === undefined) delete next[key];
        themes[name] = { ...themes[name], font: Object.keys(next).length ? next : undefined };
        updatePreview();
        this.queueSave({ themes: { ...themes } });
      }),
    );
    editor.append(preview, columns, font);
    return editor;
  }

  /** Coalesces rapid edits (dragging a color picker) into one save. */
  private queueSave(patch: Partial<Settings>): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.ctx.save(patch);
    }, 150);
  }

  private async renameTheme(from: string, to: string): Promise<void> {
    const settings = this.ctx.settings();
    if (!to || to === from || to in builtinThemes || to in settings.themes) {
      this.render();
      return;
    }
    const themes: Record<string, Theme> = {};
    for (const [name, theme] of Object.entries(settings.themes)) themes[name === from ? to : name] = theme;
    this.editingTheme = to;
    await this.ctx.save({ themes, theme: settings.theme === from ? to : settings.theme });
    this.render();
  }
}

function field(label: string, input: HTMLElement): HTMLElement {
  const wrapper = el('label', 'settings-field');
  wrapper.append(el('span', 'settings-field-label', label), input);
  return wrapper;
}

/** A few lines of fake terminal output in the theme's colors. */
function themePreview(theme: Theme, compact: boolean, font: Font): HTMLElement {
  const box = el('div', `theme-preview${compact ? ' compact' : ''}`);
  box.style.background = theme.background;
  box.style.color = theme.foreground;
  box.style.fontFamily = font.fontFamily;
  box.style.fontWeight = String(font.fontWeight);
  if (!compact) {
    box.style.fontSize = `${font.fontSize}px`;
    box.style.lineHeight = String(1.4 * font.lineHeight);
  }
  const line = (...parts: [string, string?][]) => {
    const row = el('div', 'theme-preview-line');
    for (const [text, color] of parts) {
      const span = el('span', '', text);
      if (color) span.style.color = color;
      row.append(span);
    }
    return row;
  };
  box.append(
    line(['~/senju', theme.blue], [' on ', theme.foreground], ['main', theme.magenta], [' $ ', theme.green], ['npm test']),
    line(['✓ ', theme.green], ['27 passed  ', theme.foreground], ['✗ ', theme.red], ['1 failed', theme.red]),
  );
  if (!compact) {
    box.append(
      line(['warning', theme.yellow], [': unused import ', theme.foreground], ['src/app.ts', theme.cyan], [':12', theme.brightBlack]),
      line(['selected text', theme.foreground]),
    );
    const selected = box.lastElementChild!.firstElementChild as HTMLElement;
    selected.style.background = theme.selectionBackground;
    const cursorLine = line(['$ ', theme.green]);
    const cursor = el('span', 'theme-preview-cursor');
    cursor.style.background = theme.cursor;
    cursorLine.append(cursor);
    box.append(cursorLine);
  }
  const swatches = el('div', 'theme-swatches');
  for (const key of themeKeys.slice(4)) {
    const swatch = el('span', 'theme-swatch');
    swatch.style.background = theme[key];
    swatches.append(swatch);
  }
  box.append(swatches);
  return box;
}

const weights: [number, string][] = [
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold'],
  [700, 'Bold'],
];

/** A bare family name gets quotes and a monospace fallback, as CSS needs for names with spaces. */
function cssFamily(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[,'"]/.test(trimmed)) return trimmed;
  return `'${trimmed}', monospace`;
}

/**
 * Fields for a font. With `inherited` set, empty fields fall back to it (a
 * theme's font); otherwise every field has a value (the default font).
 */
function fontFields(values: Partial<Font>, inherited: Font | null, onChange: (patch: Partial<Font>) => void): HTMLElement {
  const box = el('div', 'font-fields');
  const family = el('input', 'settings-input');
  family.type = 'text';
  family.value = values.fontFamily ?? '';
  family.placeholder = inherited?.fontFamily ?? '';
  family.addEventListener('change', () => {
    const value = cssFamily(family.value);
    family.value = value;
    onChange({ fontFamily: value || undefined });
  });
  // The installed fonts open in an app-drawn menu: a native datalist only
  // suggests entries matching the text, and the field holds a whole font stack.
  const pickFamily = async () => {
    const fonts = await monospaceFonts();
    const current = firstFamily(family.value);
    const items: MenuItem[] = fonts.map((name) => ({ id: name, label: name, checked: name === current }));
    if (inherited) items.unshift({ id: '', label: 'Default', checked: family.value === '' }, { id: '-', label: '' });
    if (fonts.length === 0) items.push({ id: 'none', label: 'No monospace fonts found', enabled: false });
    const picked = await showMenu(items, family);
    if (picked === null) return;
    family.value = picked && cssFamily(picked);
    onChange({ fontFamily: family.value || undefined });
  };
  const open = iconButton('chevronDown', 'Installed fonts', 'font-family-open');
  open.addEventListener('click', (e) => {
    e.preventDefault();
    void pickFamily();
  });
  family.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    void pickFamily();
  });
  const familyBox = el('div', 'font-family');
  familyBox.append(family, open);

  const number = (value: number | undefined, placeholder: number | undefined, min: number, max: number, step: number, key: 'fontSize' | 'lineHeight') => {
    const input = el('input', 'settings-input small');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = value === undefined ? '' : String(value);
    if (placeholder !== undefined) input.placeholder = String(placeholder);
    input.addEventListener('change', () => {
      if (input.value === '') return onChange({ [key]: undefined });
      const v = Number(input.value);
      if (v >= min && v <= max) onChange({ [key]: v });
    });
    return input;
  };

  const weight = el('select', 'settings-input');
  if (inherited) weight.append(new Option(`Default (${weights.find(([w]) => w === inherited.fontWeight)?.[1] ?? inherited.fontWeight})`, ''));
  for (const [w, label] of weights) weight.append(new Option(label, String(w)));
  weight.value = values.fontWeight === undefined ? '' : String(values.fontWeight);
  if (!inherited && !weight.value) weight.value = '400';
  weight.addEventListener('change', () => onChange({ fontWeight: weight.value ? Number(weight.value) : undefined }));

  box.append(
    field('Family', familyBox),
    field('Size', number(values.fontSize, inherited?.fontSize, 6, 40, 1, 'fontSize')),
    field('Weight', weight),
    field('Line height', number(values.lineHeight, inherited?.lineHeight, 0.8, 2, 0.05, 'lineHeight')),
  );
  return box;
}

/** The first family of a CSS font stack, without quotes. */
function firstFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '');
}

let fontList: Promise<string[]> | null = null;

/** Installed monospace fonts, measured on a canvas; looked up once. */
function monospaceFonts(): Promise<string[]> {
  fontList ??= (async () => {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
    if (!query) return [];
    let families: string[];
    try {
      families = [...new Set((await query()).map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return [];
    return families.filter((family) => {
      ctx.font = `20px '${family}', serif`;
      return Math.abs(ctx.measureText('iiiiii').width - ctx.measureText('WWWWWW').width) < 0.5;
    });
  })();
  return fontList;
}
