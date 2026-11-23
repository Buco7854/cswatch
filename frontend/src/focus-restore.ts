export function focusReturn(trigger: HTMLElement | null) {
  const section = trigger?.closest('section, .settings-section, .settings-panel');
  const heading = section?.querySelector<HTMLElement>('h2, h3');
  return () => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active !== document.body || document.querySelector('dialog[open]')) return;
      if (trigger?.isConnected && !trigger.matches(':disabled') && !trigger.closest('[inert]')) {
        trigger.focus({ preventScroll: true });
        if (document.activeElement === trigger) return;
      }
      const fallback = heading?.isConnected ? heading : document.getElementById('main');
      if (!fallback) return;
      if (!fallback.hasAttribute('tabindex')) {
        fallback.tabIndex = -1;
        fallback.addEventListener('blur', () => fallback.removeAttribute('tabindex'), {
          once: true,
        });
      }
      fallback.focus({ preventScroll: true });
    });
  };
}

export function currentFocus() {
  return document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;
}
