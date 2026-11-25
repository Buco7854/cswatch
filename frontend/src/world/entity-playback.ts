import { Matrix4 } from 'three';
import {
  breakableKey,
  doorKey,
  doorAnglesMatch,
  uniqueBreakableNodes,
  uniqueDoorNodes,
  uniqueVisibilityNodes,
  type MapBreakable,
  type MapDoor,
  type MapVisibility,
} from '../../../shared/map-breakables.mjs';
import { modelResourceId } from '../../../shared/model-resource-id.mjs';
import type { Manifest } from './format';
import { sourceToViewer, viewerToSource } from './space';
import { asVector } from './probe-grid';
type Update = (id: number, transform: Matrix4, visible: boolean) => void;
function at<T extends readonly [number, ...unknown[]]>(entries: T[], tick: number) {
  let low = 0,
    high = entries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (entries[mid][0] <= tick) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}
function active(entries: [number, number][], tick: number) {
  const span = entries[at(entries, tick)];
  return !!span && tick < span[1];
}
export function entityPlayback(
  entities: Manifest['entities'],
  breakables: MapBreakable[] = [],
  doors: MapDoor[] = [],
  visibility: MapVisibility[] = [],
  render: Update,
  refit: Update,
) {
  const identity = new Matrix4(),
    viewer = new Matrix4();
  const tags = entities.map((e) => ({
    hammerId: e.hammeruniqueid,
    model: e.model,
    modelId: modelResourceId(e.model ?? ''),
    className: e.classname,
    origin: asVector(e.origin),
    angles: asVector(e.angles),
  }));
  const visit = (accept: (id: number, tag: unknown) => void) =>
    tags.forEach((tag, id) => {
      if (entities[id].parentEntity === undefined) accept(id, tag);
    });
  const steps: ((tick: number) => void)[] = [];
  function setter(id: number) {
    let previousVisible = entities[id].initialVisibility;
    const previous = new Matrix4();
    return (transform: Matrix4, visible: boolean) => {
      if (previousVisible === visible && previous.equals(transform)) return;
      previous.copy(transform);
      previousVisible = visible;
      render(id, transform, visible);
      refit(
        id,
        viewer.multiplyMatrices(sourceToViewer, transform).multiply(viewerToSource),
        visible,
      );
    };
  }
  const fragments = uniqueBreakableNodes(breakables, visit);
  for (const track of breakables) {
    const id = fragments.get(breakableKey(track)!);
    if (id == null) continue;
    const set = setter(id);
    steps.push((tick) =>
      set(identity, entities[id].initialVisibility && !active(track.hidden, tick)),
    );
  }
  const brushes = uniqueVisibilityNodes<number>(visibility, (accept) =>
    visit((id, tag) => {
      if (!entities[id].initialVisibility) accept(id, tag);
    }),
  );
  for (const track of visibility) {
    const id = brushes.get(breakableKey(track)!);
    if (id == null) continue;
    const set = setter(id);
    steps.push((tick) => set(identity, active(track.visible, tick)));
  }
  const matches = uniqueDoorNodes(new Map(doors.map((row) => [doorKey(row), row])), visit);
  for (const track of doors) {
    const id = matches.get(doorKey(track)!);
    if (id == null || !doorAnglesMatch(track.angles, tags[id].angles)) continue;
    const [x, y, z] = tags[id].origin,
      hinge = new Matrix4().makeTranslation(x, y, z),
      inverse = new Matrix4().makeTranslation(-x, -y, -z),
      transform = new Matrix4();
    const stages = entities.flatMap((e, i) =>
      e.parentEntity === id || i === id ? [{ model: tags[i].modelId, set: setter(i) }] : [],
    );
    steps.push((tick) => {
      const index = at(track.samples, tick),
        sample = track.samples[index],
        next = track.samples[index + 1];
      let angle = sample?.[1] ?? 0;
      if (sample?.[1] != null && next?.[1] != null && next[0] === sample[0] + 1)
        angle += (((((next[1] - angle + 180) % 360) + 360) % 360) - 180) * (tick - sample[0]);
      transform
        .makeRotationZ((angle * Math.PI) / 180)
        .premultiply(hinge)
        .multiply(inverse);
      const models = track.models ?? [],
        model = models[at(models, tick)]?.[1];
      const selected = stages.some((s) => s.model === model) ? model : tags[id].modelId;
      const visible = entities[id].initialVisibility && !active(track.hidden, tick);
      for (const stage of stages) stage.set(transform, visible && stage.model === selected);
    });
  }
  return (tick: number) => {
    if (Number.isFinite(tick)) for (const step of steps) step(tick);
  };
}
