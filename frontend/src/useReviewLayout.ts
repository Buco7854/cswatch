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
      const objective = root.querySelector<HTMLElement>('.viewer-objective-layer .objective-hud');
      const score = root.querySelector<HTMLElement>('.viewer-match-score');
      const candidate = root.querySelector<HTMLElement>('.review-feed');
      const feed = candidate?.closest('.review-feed-dialog') ? null : candidate;
      const wanted = new Set(
        [objective, score, feed].filter((element): element is HTMLElement => !!element),
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
      const occupiedBottom = (element: HTMLElement | null) => {
        const box = element?.getBoundingClientRect();
        return box && box.width > 0 && box.height > 0
          ? Math.max(0, box.bottom - bounds.top) + 12
          : 0;
      };
      root.style.setProperty('--review-objective-bottom', `${occupiedBottom(objective)}px`);
      root.style.setProperty('--review-score-bottom', `${occupiedBottom(score)}px`);
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
      root.style.removeProperty('--review-score-bottom');
      root.style.removeProperty('--review-feed-height');
    };
  }, [frame, ready]);
}
