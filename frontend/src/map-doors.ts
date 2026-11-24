import { type Object3D } from 'three';
import {
  doorKey,
  doorAnglesMatch,
  uniqueDoorNodes,
  type MapDoor,
} from '../../shared/map-breakables.mjs';
import { mapDoorPose } from './map-door-pose';

const angleDiff = (a: number, b: number) => ((((a - b + 180) % 360) + 360) % 360) - 180;
/** Last sample at or before the selected tick, including on backwards seeks. */
function atTick<T extends readonly [number, ...unknown[]]>(rows: readonly T[], tick: number) {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid][0] <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

const resourceId = /^[1-9]\d{0,19}$/;
function stageTag(node: Object3D) {
  const tag = node.userData.cswatchDoorStage;
  if (
    node.parent?.userData.cswatchDoor?.className !== 'prop_door_rotating' ||
    !Number.isInteger(tag?.stage) ||
    tag.stage < 0 ||
    tag.stage > 4 ||
    typeof tag.modelId !== 'string' ||
    !resourceId.test(tag.modelId)
  )
    return;
  return tag as { stage: number; modelId: string };
}

/** glTF encodes unused variants at zero scale. Hide those draws in the
 * viewer-local clone and retain their unit-size mesh for a later recorded switch. */
export function prepareDoorStage(node: Object3D) {
  const stage = stageTag(node);
  if (!stage || stage.stage === 0 || node.scale.lengthSq() !== 0) return;
  node.visible = false;
  node.scale.setScalar(1);
  node.updateMatrix();
}

function doorStages(door: Object3D, intact: string) {
  const models = new Map<string, Object3D>(),
    numbers = new Set<number>();
  for (const child of door.children) {
    const stage = stageTag(child);
    if (!stage) continue;
    if (
      models.has(stage.modelId) ||
      numbers.has(stage.stage) ||
      (stage.stage === 0) !== (stage.modelId === intact) ||
      (stage.stage === 0) !== child.visible
    )
      return;
    models.set(stage.modelId, child);
    numbers.add(stage.stage);
  }
  if (!models.has(intact) || models.size < 2) return;
  let current = models.get(intact)!;
  return (id: string | null) => {
    const target = (id && models.get(id)) || models.get(intact)!;
    if (target === current) return false;
    current.visible = false;
    target.visible = true;
    current = target;
    return true;
  };
}

export function bindMapDoors(root: Object3D, tracks: MapDoor[] | undefined) {
  if (!tracks?.length) return [];
  const wanted = new Map(tracks.map((track) => [doorKey(track), track]));
  const matches = uniqueDoorNodes<Object3D>(wanted, (accept) =>
    root.traverse((node) => accept(node, node.userData.cswatchDoor)),
  );
  const doors = [];
  for (const [key, node] of matches) {
    if (!node) continue;
    const track = wanted.get(key)!;
    const tag = node.userData.cswatchDoor;
    if (!doorAnglesMatch(track.angles, tag.angles)) continue;
    const pose = mapDoorPose(root, node, tag.origin);
    if (!pose) continue;
    const initial = node.visible;
    const setStage = doorStages(node, track.modelId);
    const modelSamples = track.models ?? [];
    let model: string | null = null;
    const samples = track.samples,
      hidden = track.hidden;
    let from = Infinity,
      to = -Infinity,
      angle = 0,
      perTick = 0,
      anchor = 0,
      visible = initial;
    let previousAngle = 0;
    doors.push({
      node,
      initial,
      seek(tick: number) {
        if (tick < from || tick >= to) {
          const at = atTick(samples, tick),
            removed = atTick(hidden, tick);
          const sample = samples[at],
            next = samples[at + 1];
          const modelIndex = atTick(modelSamples, tick);
          const recordedModel = modelSamples[modelIndex];
          model = recordedModel?.[1] ?? null;
          const interval = hidden[removed];
          const absent = interval && tick < interval[1];
          visible = initial && !absent;
          from = Math.max(
            recordedModel?.[0] ?? -Infinity,
            sample?.[0] ?? -Infinity,
            interval ? (absent ? interval[0] : interval[1]) : -Infinity,
          );
          to = Math.min(
            modelSamples[modelIndex + 1]?.[0] ?? Infinity,
            next?.[0] ?? Infinity,
            absent ? interval[1] : (hidden[removed + 1]?.[0] ?? Infinity),
          );
          angle = sample?.[1] ?? 0;
          anchor = sample?.[0] ?? 0;
          perTick =
            sample && next && sample[1] !== null && next[1] !== null && next[0] === anchor + 1
              ? angleDiff(next[1], angle)
              : 0;
        }
        let changed = (visible && setStage?.(model)) || false;
        if (node.visible !== visible) {
          node.visible = visible;
          changed = true;
        }
        const current = angle + perTick * (tick - anchor);
        if (current !== previousAngle && visible) {
          changed = pose.set(current) || changed;
          previousAngle = current;
        }
        return changed;
      },
      dispose() {
        node.visible = initial;
        setStage?.(null);
        pose.dispose();
      },
    });
  }
  return doors;
}
