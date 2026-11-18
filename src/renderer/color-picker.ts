// A color picker drawn by the app instead of the system's: a saturation and
// brightness field, a hue strip and a hex field.

interface Hsv {
  h: number;
  s: number;
  v: number;
}

function hexToHsv(hex: string): Hsv {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  const [r, g, b] = m ? m.slice(1).map((x) => parseInt(x, 16) / 255) : [0, 0, 0];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

let closeOpen: (() => void) | null = null;

/** Opens a picker below `anchor`; `onChange` gets every new color while it is open. */
export function openColorPicker(anchor: HTMLElement, value: string, onChange: (hex: string) => void): void {
  closeOpen?.();
  let hsv = hexToHsv(value);
  const popover = document.createElement('div');
  popover.className = 'color-popover';
  const field = document.createElement('div');
  field.className = 'color-field';
  const fieldThumb = document.createElement('div');
  fieldThumb.className = 'color-thumb';
  field.append(fieldThumb);
  const hue = document.createElement('div');
  hue.className = 'color-hue';
  const hueThumb = document.createElement('div');
  hueThumb.className = 'color-hue-thumb';
  hue.append(hueThumb);
  const row = document.createElement('div');
  row.className = 'color-row-bottom';
  const preview = document.createElement('span');
  preview.className = 'color-preview';
  const hex = document.createElement('input');
  hex.type = 'text';
  hex.className = 'input color-hex';
  hex.setAttribute('aria-label', 'Hex color');
  row.append(preview, hex);
  popover.append(field, hue, row);
  document.body.append(popover);

  const paint = (emit: boolean) => {
    const color = hsvToHex(hsv);
    field.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`;
    fieldThumb.style.left = `${hsv.s * 100}%`;
    fieldThumb.style.top = `${(1 - hsv.v) * 100}%`;
    hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
    preview.style.background = color;
    if (document.activeElement !== hex) hex.value = color;
    if (emit) onChange(color);
  };

  const drag = (target: HTMLElement, update: (x: number, y: number) => void) => {
    target.addEventListener('pointerdown', (down) => {
      down.preventDefault();
      target.setPointerCapture(down.pointerId);
      const move = (e: PointerEvent) => {
        const r = target.getBoundingClientRect();
        update(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
        paint(true);
      };
      move(down);
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', () => target.removeEventListener('pointermove', move), { once: true });
    });
  };
  drag(field, (x, y) => (hsv = { ...hsv, s: x, v: 1 - y }));
  drag(hue, (x) => (hsv = { ...hsv, h: x * 360 }));
  hex.addEventListener('input', () => {
    const v = hex.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v)) {
      hsv = hexToHsv(v.startsWith('#') ? v : `#${v}`);
      paint(true);
    }
  });

  const rect = anchor.getBoundingClientRect();
  const { width, height } = popover.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  popover.style.top = `${rect.bottom + height + 8 > window.innerHeight ? rect.top - height - 6 : rect.bottom + 6}px`;
  paint(false);

  const onOutside = (e: MouseEvent) => {
    if (!popover.contains(e.target as Node) && e.target !== anchor) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      close();
      anchor.focus();
    }
  };
  const close = () => {
    popover.remove();
    window.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('keydown', onKey, true);
    closeOpen = null;
  };
  closeOpen = close;
  setTimeout(() => window.addEventListener('mousedown', onOutside, true));
  window.addEventListener('keydown', onKey, true);
}
