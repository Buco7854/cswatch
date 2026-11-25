// Volume order and edge tests from ValveResourceFormat 21.1, Renderer/Scene.cs and envmap.slang (MIT).
// Copyright (c) 2015 ValveResourceFormat Contributors. See tools/cs2export/THIRD_PARTY_NOTICES.txt.
import { Euler, Matrix4 } from 'three';
import type { Entity } from './format';

export const asVector = (v: unknown): number[] =>
  typeof v === 'string' ? v.trim().split(/\s+/).map(Number) : (v as number[]);
export function probeGrid(entries: Entity[]) {
  const boxes = entries
    .map((e) => {
      const origin = asVector(e.origin),
        lo = asVector(e.box_mins),
        hi = asVector(e.box_maxs);
      // World bounds of the (possibly rotated) box, for cell assignment only.
      const [pitch, yaw, roll] = asVector(e.angles ?? [0, 0, 0]).map((a) => (a * Math.PI) / 180);
      const r = new Matrix4().makeRotationFromEuler(new Euler(roll, pitch, yaw, 'ZYX')).elements;
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (let corner = 0; corner < 8; corner++) {
        const local = [0, 1, 2].map((i) => (corner & (1 << i) ? hi[i] : lo[i]));
        for (let i = 0; i < 3; i++) {
          const world = origin[i] + r[i] * local[0] + r[4 + i] * local[1] + r[8 + i] * local[2];
          min[i] = Math.min(min[i], world);
          max[i] = Math.max(max[i], world);
        }
      }
      return {
        lo: min.map((x) => x - 0.1),
        hi: max.map((x) => x + 0.1),
        volume: lo.reduce((v, x, i) => v * (hi[i] - x), 1),
        priority: Number(e.indoor_outdoor_level),
        index: Number(e.array_index),
      };
    })
    .sort((a, b) => b.priority - a.priority || a.volume - b.volume || a.index - b.index);
  const min = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.lo[i]))),
    max = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.hi[i])));
  const size = [16, 16, 8],
    step = size.map((n, i) => (max[i] - min[i]) / n);
  const cells: number[][] = [];
  let longest = 1;
  for (let z = 0; z < size[2]; z++)
    for (let y = 0; y < size[1]; y++)
      for (let x = 0; x < size[0]; x++) {
        const ijk = [x, y, z],
          lo = min.map((m, i) => m + ijk[i] * step[i]);
        const ids = boxes
          .filter((b) => lo.every((low, i) => b.hi[i] >= low && b.lo[i] <= low + step[i]))
          .map((b) => b.index);
        cells.push(ids);
        longest = Math.max(longest, ids.length + 1);
      }
  const width = Math.ceil(longest / 4),
    data = new Float32Array(width * cells.length * 4).fill(-1);
  cells.forEach((cell, i) => data.set(cell, i * width * 4));
  return { width, height: cells.length, data, min, invStep: step.map((s) => 1 / s) };
}
