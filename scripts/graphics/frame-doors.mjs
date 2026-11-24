import {
  doorAnglesMatch,
  doorKey,
  doorLimits,
  uniqueDoorNodes,
  validMapDoors,
} from '../../shared/map-breakables.mjs';

const angleDelta = (a, b) => ((((a - b + 180) % 360) + 360) % 360) - 180;

function expectedYaw(samples, tick) {
  const at = samples.findLastIndex(([time]) => time <= tick);
  const sample = samples[at];
  if (!sample || sample[1] === null) return null;
  const next = samples[at + 1];
  return next && next[1] !== null && next[0] === sample[0] + 1
    ? sample[1] + angleDelta(next[1], sample[1]) * (tick - sample[0])
    : sample[1];
}

function compareStage(node, expected) {
  if (expected === null) return { status: 'unobserved', actual: null };
  const stages = node?.stages;
  if (!Array.isArray(stages) || stages.length > 5) return { status: 'unknown', actual: null };
  if (!stages.length) return { status: 'missing', actual: null };
  const ids = new Set(),
    numbers = new Set();
  for (const s of stages) {
    if (
      !s ||
      typeof s.modelId !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(s.modelId) ||
      !Number.isInteger(s.stage) ||
      s.stage < 0 ||
      s.stage > 4 ||
      typeof s.visible !== 'boolean' ||
      ids.has(s.modelId) ||
      numbers.has(s.stage) ||
      (s.stage === 0) !== (s.modelId === node.modelId)
    )
      return { status: 'unknown', actual: null };
    ids.add(s.modelId);
    numbers.add(s.stage);
  }
  if (!numbers.has(0)) return { status: 'unknown', actual: null };
  const shown = stages.filter((s) => s.visible);
  const actual = shown.length === 1 ? shown[0].modelId : null;
  return {
    status: !ids.has(expected) ? 'missing' : actual === expected ? 'matched' : 'mismatch',
    actual,
  };
}

/** Compare the recorded door channels with the installed scene graph. Visible means
 * enabled in that graph; this report never infers that the camera saw the door. */
export function frameDoors(tracks, lastTick, tick, observation) {
  const complete =
    Array.isArray(observation?.nodes) && observation.nodes.length <= doorLimits.tracks;
  const report = {
    status: 'unavailable',
    reason: observation?.reason ?? null,
    recorded: null,
    tagged: complete ? observation.nodes.length : null,
    matched: 0,
    missing: 0,
    ambiguous: 0,
    expectedOpen: 0,
    expectedHidden: 0,
    expectedStages: 0,
    expectedDamaged: 0,
    expectedAuthored: 0,
    stageMatched: 0,
    missingStages: 0,
    unknownStages: 0,
    stageMismatches: 0,
    agreed: 0,
    disagreed: 0,
    unknown: null,
    tracks: [],
    omittedTrackDetails: 0,
  };
  if (tracks === undefined || (Array.isArray(tracks) && !tracks.length))
    return { ...report, status: 'no-recorded-evidence', recorded: 0, unknown: 0 };
  if (!validMapDoors(tracks, lastTick) || !Number.isFinite(tick) || tick < 0 || tick > lastTick)
    return { ...report, reason: 'invalid-recording-or-tick' };
  report.recorded = tracks.length;
  const matches =
    complete &&
    uniqueDoorNodes(new Set(tracks.map(doorKey)), (accept) => {
      for (const node of observation.nodes) accept(node, node);
    });
  for (const track of tracks) {
    const key = doorKey(track),
      candidate = matches && matches.get(key);
    const binding = !complete
      ? 'unavailable'
      : candidate === undefined
        ? 'missing'
        : candidate === null || !doorAnglesMatch(track.angles, candidate.angles)
          ? 'ambiguous'
          : 'matched';
    if (complete) report[binding]++;
    const node = binding === 'matched' ? candidate : null;
    const hidden = track.hidden.some(([start, end]) => start <= tick && tick < end);
    const yaw = hidden ? null : expectedYaw(track.samples, tick);
    const recordedModel = track.models?.findLast(([time]) => time <= tick)?.[1] ?? null;
    const expected = hidden || !track.models ? null : (recordedModel ?? track.modelId);
    const stage = compareStage(node, expected);
    if (hidden) report.expectedHidden++;
    if (yaw !== null && Math.abs(angleDelta(yaw, 0)) > 0.01) report.expectedOpen++;
    if (expected !== null) {
      report.expectedStages++;
      if (recordedModel !== null && recordedModel !== track.modelId) report.expectedDamaged++;
      if (recordedModel === null) report.expectedAuthored++;
      if (stage.status === 'matched') report.stageMatched++;
      else if (stage.status === 'missing') report.missingStages++;
      else if (stage.status === 'mismatch') report.stageMismatches++;
      else report.unknownStages++;
    }
    const visible = typeof node?.visible === 'boolean' ? node.visible : null;
    const actualYaw = visible && Number.isFinite(node?.yaw) ? node.yaw : null;
    const poseMatches =
      yaw === null || actualYaw === null ? null : Math.abs(angleDelta(yaw, actualYaw)) <= 0.02;
    const disagrees =
      (visible !== null && visible === hidden) ||
      poseMatches === false ||
      stage.status === 'mismatch';
    const agrees =
      !disagrees &&
      visible !== null &&
      (hidden ||
        ((yaw !== null || expected !== null) &&
          (yaw === null || poseMatches === true) &&
          (expected === null || stage.status === 'matched')));
    if (disagrees) report.disagreed++;
    if (agrees) report.agreed++;
    report.tracks.push({
      key,
      binding,
      hammerId: node?.hammerId ?? null,
      hidden,
      visible,
      yaw,
      actualYaw,
      model: expected,
      modelSource:
        expected === null ? null : recordedModel === null ? 'authored-fallback' : 'recorded',
      actualModel: stage.actual,
      stage: stage.status,
      agrees: disagrees ? false : agrees ? true : null,
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
  if (!complete) report.reason ??= 'map-observation-unavailable';
  if (report.tracks.length > 16) {
    report.omittedTrackDetails = report.tracks.length - 16;
    report.tracks = [
      ...report.tracks.filter((v) => v.agrees !== true),
      ...report.tracks.filter((v) => v.agrees === true),
    ].slice(0, 16);
  }
  return report;
}
