// Confirmation dialogs drawn by the app, styled like the rest of the window.

export interface ConfirmOptions {
  title: string;
  detail?: string;
  confirmLabel?: string;
  /** Marks the confirm button as destructive. */
  danger?: boolean;
}

export function confirmDialog({ title, detail, confirmLabel = 'Close', danger = true }: ConfirmOptions): Promise<boolean> {
  const previousFocus = document.activeElement as HTMLElement | null;
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h2');
    heading.className = 'dialog-title';
    heading.id = 'dialog-title';
    heading.textContent = title;
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.append(heading);
    if (detail) {
      const text = document.createElement('p');
      text.className = 'dialog-detail';
      text.textContent = detail;
      dialog.append(text);
    }
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = `button ${danger ? 'danger' : 'primary'}`;
    confirm.textContent = confirmLabel;
    actions.append(cancel, confirm);
    dialog.append(actions);
    backdrop.append(dialog);
    document.body.append(backdrop);
    confirm.focus();

    const finish = (value: boolean) => {
      window.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      previousFocus?.focus?.();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === confirm ? cancel : confirm).focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        finish(document.activeElement !== cancel);
      }
    };
    window.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(false);
    });
  });
}
