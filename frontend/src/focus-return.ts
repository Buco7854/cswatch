/** A delayed dialog return belongs to the focus context that requested it. */
export type FocusReturnContext = { active: Element | null; closing: Element | null };
export function captureFocusReturn(): FocusReturnContext {
  const active = document.activeElement;
  return {
    active,
    closing: active?.closest('dialog,[role="dialog"],[role="menu"],[role="listbox"]') || null,
  };
}
/** Preserve a newer explicit destination, while retaining native unmount/inert fallbacks. */
export function focusMovedSince(context: FocusReturnContext) {
  const active = document.activeElement;
  if (
    !(active instanceof HTMLElement) ||
    active === context.active ||
    active === document.body ||
    active === document.documentElement ||
    !active.isConnected ||
    context.closing?.contains(active) ||
    active.closest('[inert]') ||
    active.matches(':disabled')
  )
    return false;
  const box = active.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(active).visibility === 'visible';
}
