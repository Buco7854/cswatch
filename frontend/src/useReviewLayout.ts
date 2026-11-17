import { useLayoutEffect, type RefObject } from 'react';

/** Measure only real overlay boxes. CSS composes their occupied lanes per viewport. */
export function useReviewLayout(frame: RefObject<HTMLElement | null>, ready: boolean) {
  useLayoutEffect(() => {
    const root = frame.current;
    if (!root || !ready) return;
    let scheduled: number | undefined;
    const observed = new Set<Element>();
    const measure = () => {
      scheduled = undefined;
      const objective = root.querySelector<HTMLElement>('.objective-hud');
      const candidate = root.querySelector<HTMLElement>('.review-feed');
      const feed = candidate?.closest('.review-feed-dialog') ? null : candidate;
      const wanted = new Set(
        [objective, feed].filter((element): element is HTMLElement => !!element),
      );
      for (const element of observed)
        if (!wanted.has(element as HTMLElement)) {
          observer?.unobserve(element);
          observed.delete(element);
        }
      for (const element of wanted)
        if (!observed.has(element)) {
          observer?.observe(element);
          observed.add(element);
        }
      const bounds = root.getBoundingClientRect();
      root.style.setProperty(
        '--review-objective-bottom',
        `${objective ? Math.max(0, objective.getBoundingClientRect().bottom - bounds.top) + 12 : 0}px`,
      );
      root.style.setProperty(
        '--review-feed-height',
        `${feed?.getBoundingClientRect().height ?? 0}px`,
      );
    };
    const schedule = () => {
      if (scheduled === undefined) scheduled = requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const changes = new MutationObserver(schedule);
    changes.observe(root, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      changes.disconnect();
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      if (scheduled !== undefined) cancelAnimationFrame(scheduled);
      root.style.removeProperty('--review-objective-bottom');
      root.style.removeProperty('--review-feed-height');
    };
  }, [frame, ready]);
}
