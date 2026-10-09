// Shared overlay behavior (dialogs, sheets, palette, lightbox): scroll lock and focus trapping (08 §8.22, §13).

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

// Reference-count nested overlays; restore scrolling only after the final one closes.
let locks = 0;
let savedOverflow = '';

export function lockScroll(): void {
  if (locks === 0) {
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  }
  locks += 1;
}

export function unlockScroll(): void {
  if (locks === 0) return;
  locks -= 1;
  if (locks === 0) document.documentElement.style.overflow = savedOverflow;
}

/** Tab-focusable descendants in document order. */
export function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    element => element.getAttribute('aria-hidden') !== 'true'
  );
}

/** Cycle Tab inside the container; stay put if none are focusable. */
export function trapTab(event: KeyboardEvent, container: HTMLElement): void {
  const items = focusableIn(container);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  const outside = !(active instanceof Node) || !container.contains(active);
  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}
