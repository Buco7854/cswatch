import { useLayoutEffect, type RefObject } from 'react';

type Box = { left: number; top: number; right: number; bottom: number };
const blockerSelector =
  '.viewer-titlebar,.viewer-dock,.review-feed,.review-inputs-panel,.broadcast-lineup-stack,.viewer-context-actions,.voice-caption,.position-radar,.viewer-match-score,.objective-hud';
const observedSelector = blockerSelector + ',.killfeed';
const clearKillfeedPlacement = (root: HTMLElement) => {
  delete root.dataset.killfeedPlaced;
  for (const property of ['left', 'top', 'width'])
    root.style.removeProperty('--review-killfeed-' + property);
};

/** On a crowded small screen, the passive elimination feed takes a free edge
 * gap. It must not resize the player list or sit on a replay/input control. */
function placeKillfeed(root: HTMLElement, blockers: HTMLElement[]) {
  const feed = root.querySelector<HTMLElement>('.killfeed');
  if (!feed) {
    clearKillfeedPlacement(root);
    delete root.dataset.killfeedCrowded;
    return;
  }
  const bounds = root.getBoundingClientRect();
  const height = feed.getBoundingClientRect().height;
  if (height <= 0) {
    clearKillfeedPlacement(root);
    delete root.dataset.killfeedCrowded;
    return;
  }
  const edge = Number.parseFloat(getComputedStyle(root).getPropertyValue('--viewer-edge')) || 8;
  const gap = 8;
  const boxes: Box[] = blockers.flatMap((element) => {
    const style = getComputedStyle(element),
      box = element.getBoundingClientRect();
    return style.display !== 'none' &&
      style.visibility === 'visible' &&
      box.width > 0 &&
      box.height > 0
      ? [
          {
            left: box.left - bounds.left,
            top: box.top - bounds.top,
            right: box.right - bounds.left,
            bottom: box.bottom - bounds.top,
          },
        ]
      : [];
  });
  const toolbar = root.querySelector('.viewer-titlebar')!.getBoundingClientRect();
  const score = root.querySelector('.viewer-match-score')?.getBoundingClientRect();
  const minimumY = toolbar.bottom - bounds.top + gap;
  const preferredY = Math.max(minimumY + gap, score ? score.bottom - bounds.top + 12 : 0);
  const deck = root.querySelector('.viewer-dock')!.getBoundingClientRect();
  const maximumY = deck.top - bounds.top - height - gap;
  const candidates = [
    ...new Set([
      preferredY,
      minimumY,
      ...boxes.flatMap((box) => [box.bottom + gap, box.top - height - gap]),
    ]),
  ]
    .filter((y) => y >= minimumY && y <= maximumY)
    .sort((a, b) => Math.abs(a - preferredY) - Math.abs(b - preferredY));
  for (const top of candidates) {
    const occupied = boxes
      .filter((box) => box.bottom + gap > top && box.top - gap < top + height)
      .map((box) => ({
        left: Math.max(edge, box.left - gap),
        right: Math.min(root.clientWidth - edge, box.right + gap),
      }))
      .sort((a, b) => a.left - b.left);
    const free: { left: number; right: number }[] = [];
    let left = edge;
    for (const box of occupied) {
      if (box.left > left) free.push({ left, right: box.left });
      left = Math.max(left, box.right);
    }
    if (left < root.clientWidth - edge) free.push({ left, right: root.clientWidth - edge });
    const available = free
      .filter((box) => box.right - box.left >= 96)
      .sort((a, b) => b.right - b.left - (a.right - a.left) || b.right - a.right)[0];
    if (!available) continue;
    const width = Math.min(340, available.right - available.left);
    root.style.setProperty('--review-killfeed-left', `${available.right - width}px`);
    root.style.setProperty('--review-killfeed-top', `${top}px`);
    root.style.setProperty('--review-killfeed-width', `${width}px`);
    root.dataset.killfeedPlaced = 'true';
    delete root.dataset.killfeedCrowded;
    return;
  }
  // A fully occupied frame has no honest placement. Keep this passive box
  // measurable so resize/content changes can restore it without changing any
  // saved visibility preference or hiding events from the timeline/review list.
  clearKillfeedPlacement(root);
  root.dataset.killfeedCrowded = 'true';
}

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
      const blockers = [...root.querySelectorAll<HTMLElement>(blockerSelector)];
      const killfeed = root.querySelector<HTMLElement>('.killfeed');
      const wanted = new Set(
        [objective, score, feed, killfeed, ...blockers].filter(
          (element): element is HTMLElement => !!element,
        ),
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
      placeKillfeed(root, blockers);
    };
    const schedule = () => {
      if (scheduled === undefined) scheduled = requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    // ResizeObserver handles resizing inside existing panels. Watch the DOM
    // for panels entering or leaving so roster and scene updates skip layout work.
    const changes = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (
            node instanceof Element &&
            (node.matches(observedSelector) || node.querySelector(observedSelector))
          ) {
            schedule();
            return;
          }
        }
      }
    });
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
      clearKillfeedPlacement(root);
      delete root.dataset.killfeedCrowded;
    };
  }, [frame, ready]);
}
