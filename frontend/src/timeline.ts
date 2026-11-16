import type { ReviewEvent } from './review-events';

export type TimelineWindow = { start: number; end: number };
export type TimelineGroup = {
  id: string;
  anchor: number;
  events: ReviewEvent[];
};

/** The axis is shared with the slider thumb's travel, never a chunk's local bounds. */
export function timelinePosition(tick: number, window: TimelineWindow) {
  const duration = window.end - window.start;
  return duration > 0 ? Math.max(0, Math.min(1, (tick - window.start) / duration)) : 0;
}

/** Group colliding hit targets without moving the underlying recorded event stems. */
export function timelineGroups(
  events: ReviewEvent[],
  window: TimelineWindow,
  width: number,
  separation = 44,
): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const event of [...events].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id))) {
    if (event.tick < window.start || event.tick > window.end) continue;
    const position = timelinePosition(event.tick, window);
    const previous = groups.at(-1);
    if (previous && (position - previous.anchor) * Math.max(1, width) < separation) {
      previous.events.push(event);
    } else groups.push({ id: event.id, anchor: position, events: [event] });
  }
  return groups;
}
