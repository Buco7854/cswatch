import {
  breakableKey,
  breakableLimits,
  uniqueBreakableNodes,
  validMapBreakables,
} from '../../shared/map-breakables.mjs';

/** Compare recorded removal intervals with effective Three visibility at a paused tick. */
export function frameBreakables(tracks, lastTick, tick, observation) {
  const complete =
    Array.isArray(observation?.nodes) && observation.nodes.length <= breakableLimits.tracks;
  const report = {
    status: 'unavailable',
    reason: observation?.reason ?? null,
    recorded: null,
    tagged: complete ? observation.nodes.length : null,
    matched: 0,
    missing: 0,
    ambiguous: 0,
    expectedHidden: 0,
    agreed: 0,
    disagreed: 0,
    unknown: null,
    tracks: [],
    omittedTrackDetails: 0,
  };
  if (tracks === undefined || (Array.isArray(tracks) && !tracks.length)) {
    return { ...report, status: 'no-recorded-evidence', recorded: 0, unknown: 0 };
  }
  if (
    !validMapBreakables(tracks, lastTick) ||
    !Number.isFinite(tick) ||
    tick < 0 ||
    tick > lastTick
  )
    return { ...report, reason: 'invalid-recording-or-tick' };
  report.recorded = tracks.length;
  const matches =
    complete &&
    uniqueBreakableNodes(tracks, (accept) => {
      for (const node of observation.nodes) accept(node, node);
    });
  for (const track of tracks) {
    const key = breakableKey(track);
    const hidden = track.hidden.some(([start, end]) => start <= tick && tick < end);
    if (hidden) report.expectedHidden++;
    const node = matches && matches.get(key);
    const binding = !complete
      ? 'unavailable'
      : node === null
        ? 'ambiguous'
        : node === undefined
          ? 'missing'
          : 'matched';
    if (complete) report[binding]++;
    const visible = typeof node?.visible === 'boolean' ? node.visible : null;
    const agrees = visible === null ? null : visible === !hidden;
    if (agrees === true) report.agreed++;
    if (agrees === false) report.disagreed++;
    report.tracks.push({
      key,
      className: track.className ?? 'prop_dynamic',
      binding,
      hammerId: node?.hammerId ?? null,
      expected: hidden ? 'hidden' : 'shown',
      actual: visible === null ? null : visible ? 'shown' : 'hidden',
      agrees,
    });
  }
  report.unknown = report.recorded - report.agreed - report.disagreed;
  report.status = !complete
    ? 'unavailable'
    : report.disagreed
      ? 'mismatch'
      : report.unknown
        ? 'partial'
        : 'matched';
  // Keep frame.json within its existing byte budget while retaining full counts.
  if (report.tracks.length > 32) {
    report.omittedTrackDetails = report.tracks.length - 32;
    report.tracks = [
      ...report.tracks.filter((row) => row.agrees !== true),
      ...report.tracks.filter((row) => row.agrees === true),
    ].slice(0, 32);
  }
  if (!complete) report.reason ??= 'map-observation-unavailable';
  return report;
}
