// The one icon set of the UI: 16-unit grid, 1.5 stroke, round caps, drawn in
// the current text color. Every button uses these instead of typed glyphs.

const paths = {
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  splitRight: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M8 3v10"/>',
  splitDown: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 8h12"/>',
  chevronDown: '<path d="M4.5 6.25L8 9.75l3.5-3.5"/>',
  chevronUp: '<path d="M4.5 9.75L8 6.25l3.5 3.5"/>',
  chevronRight: '<path d="M6.25 4.5L9.75 8l-3.5 3.5"/>',
  sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.75v1.5M8 12.75v1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M1.75 8h1.5M12.75 8h1.5M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>',
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  file: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
  power: '<path d="M8 2v6"/><path d="M4.5 4.5a5 5 0 1 0 7 0"/>',
  history: '<path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.77"/><path d="M2.5 2.75v2.5H5"/><path d="M8 5.25V8l2 1.5"/>',
  grid: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  maximize: '<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9.5 6.5M2.5 13.5l4-4"/>',
  restore: '<path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25L13.5 13.5"/>',
  popOut: '<path d="M9.5 2.5h4v4M13.5 2.5L8 8"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>',
  dock: '<path d="M6.5 13.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v3"/><path d="M14 9H9v5M9 9l5 5"/>',
  code: '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>',
} as const;

export type IconName = keyof typeof paths;

export function iconSvg(name: IconName, size = 16): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

/** An icon-only button; the label is announced and shown as the tooltip. */
export function iconButton(name: IconName, label: string, className = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-button ${className}`.trim();
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = iconSvg(name);
  return button;
}

/** The Senju mark at a small size, drawn in the brand colors. */
export function logoSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 128 128" aria-hidden="true"><rect width="128" height="128" rx="28" fill="#e8a93b"/><rect x="16" y="20" width="96" height="88" rx="14" fill="none" stroke="#1d1a14" stroke-width="9"/><path d="M64 20 V108 M64 64 H112" stroke="#1d1a14" stroke-width="9"/></svg>`;
}
