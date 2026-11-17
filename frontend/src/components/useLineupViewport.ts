import { useLayoutEffect, useRef } from 'react';

/** Keeps native lineup scrolling, complete-row bounds and a visible overflow cue. */
export default function useLineupViewport(lineupKey: string) {
  const availableRef = useRef<HTMLElement>(null);
  const lineupRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const availableBox = availableRef.current;
    const viewport = lineupRef.current;
    if (!availableBox || !viewport || typeof ResizeObserver === 'undefined') return;

    const rows = [...viewport.querySelectorAll<HTMLElement>('.broadcast-player, .broadcast-empty')];
    let scheduled: number | undefined;
    let previousHeight: number | undefined;
    // Touch browsers may hide native scrollbars even while a roster is clipped.
    // Keep a noninteractive position cue; scrolling itself remains native.
    const updateScrollCue = () => {
      const height = viewport.clientHeight;
      const maximum = Math.max(0, viewport.scrollHeight - height);
      const thumb = viewport.scrollHeight
        ? Math.min(height, Math.max(20, (height * height) / viewport.scrollHeight))
        : 0;
      availableBox.dataset.scrollable = String(maximum > 1);
      availableBox.style.setProperty('--lineup-scroll-height', `${height}px`);
      availableBox.style.setProperty('--lineup-scroll-thumb', `${thumb || 0}px`);
      availableBox.style.setProperty(
        '--lineup-scroll-offset',
        `${maximum ? (Math.min(maximum, Math.max(0, viewport.scrollTop)) / maximum) * (height - thumb) : 0}px`,
      );
    };
    availableBox.dataset.scrollCue = '';
    viewport.addEventListener('scroll', updateScrollCue, { passive: true });

    const measure = () => {
      scheduled = undefined;
      const viewportTop = viewport.getBoundingClientRect().top;
      const availableHeight = availableBox.getBoundingClientRect().bottom - viewportTop;
      if (availableHeight <= 0) return;

      // Content-space coordinates retain the real team gap and any wrapped kit
      // rows, independently of the user's current scroll position.
      let completeBottom = 0;
      for (const row of rows) {
        const bottom = row.getBoundingClientRect().bottom - viewportTop + viewport.scrollTop;
        if (bottom > availableHeight) break;
        completeBottom = bottom;
      }
      // A viewport shorter than one row keeps the CSS scrolling fallback.
      const height =
        completeBottom > 0 ? Math.min(availableHeight, Math.ceil(completeBottom)) : undefined;
      if (height === previousHeight) {
        updateScrollCue();
        return;
      }
      previousHeight = height;
      if (height === undefined) viewport.style.removeProperty('--lineup-viewport-height');
      else viewport.style.setProperty('--lineup-viewport-height', `${height}px`);

      // Resizing must not leave the keyboard's focused player below the new
      // cutoff. Scroll this viewport only; keep focus and every row mounted.
      const active = document.activeElement;
      if (active instanceof HTMLElement && viewport.contains(active)) {
        const focusedRow = active.closest<HTMLElement>('.broadcast-player');
        if (focusedRow) {
          const bounds = viewport.getBoundingClientRect();
          const focusedBounds = focusedRow.getBoundingClientRect();
          if (focusedBounds.bottom > bounds.bottom)
            viewport.scrollTop += focusedBounds.bottom - bounds.bottom;
          else if (focusedBounds.top < bounds.top)
            viewport.scrollTop -= bounds.top - focusedBounds.top;
        }
      }
      updateScrollCue();
    };
    const schedule = () => {
      if (scheduled === undefined) scheduled = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    // The available-height box never takes its height from the capped viewport.
    // Observing rows/banks catches font, equipment wrapping and breakpoint changes
    // without observing our own changed viewport height.
    observer.observe(availableBox);
    for (const element of viewport.querySelectorAll('.broadcast-bank, .broadcast-player'))
      observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      if (scheduled !== undefined) cancelAnimationFrame(scheduled);
      viewport.style.removeProperty('--lineup-viewport-height');
      viewport.removeEventListener('scroll', updateScrollCue);
      delete availableBox.dataset.scrollCue;
      delete availableBox.dataset.scrollable;
      for (const key of ['height', 'thumb', 'offset'])
        availableBox.style.removeProperty('--lineup-scroll-' + key);
    };
  }, [lineupKey]);

  return { availableRef, lineupRef };
}
