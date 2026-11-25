import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Group, Vector2, Vector3, type InterleavedBufferAttribute } from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { frameAt, poseTimingAt } from '../playback';
import { playerPose } from '../player-pose';
import { firstPersonView } from '../pov-camera';
import { recentWeaponShot } from '../weapon-fire';
import {
  createShotRayCache,
  povMuzzleScale,
  shotMuzzleWeight,
  shotTracerSpan,
  tracerLifetime,
  traceRecordedShot,
} from '../shot-tracer';
import type { SceneTrace } from '../world/queries';
import type { Playback } from '../types';
import { useTracerEvidence } from './EquipmentFire';

const maxStreaks = 12;

function viewAt(data: Playback, id: string, at: number) {
  const span = frameAt(data, at);
  const from = span.frame.players.find((player) => player.id === id);
  if (!from?.alive) return;
  return firstPersonView(
    playerPose(
      from,
      span.next.players.find((player) => player.id === id),
      span.alpha,
      poseTimingAt(data, span, id),
    ),
  );
}

export default function ShotTracers({
  data,
  tick,
  pov,
  trace,
}: {
  data: Playback;
  tick: number;
  pov?: string;
  trace: ReturnType<SceneTrace['fork']>;
}) {
  const evidence = useTracerEvidence();
  const invalidate = useThree((state) => state.invalidate);
  const active = useMemo(() => {
    if (!evidence || evidence.reducedMotion || !data.frames.length) return [];
    const current = frameAt(data, tick).frame;
    const result = [];
    for (const pawn of current.players) {
      const shot = recentWeaponShot(evidence.index, pawn, tick, data.tickRate, tracerLifetime);
      if (!shot || shot.tick < data.frames[0].tick) continue;
      result.push({ id: pawn.id, tick: shot.tick, age: shot.age });
    }
    return result
      .sort((a, b) => Number(b.id === pov) - Number(a.id === pov) || a.age - b.age)
      .slice(0, maxStreaks);
  }, [data, evidence?.index, evidence?.reducedMotion, pov, tick]);

  const rays = useMemo(
    () => createShotRayCache<ReturnType<typeof traceRecordedShot>>(),
    [trace, evidence?.index],
  );
  const pool = useMemo(() => {
    const group = new Group();
    const resolution = new Vector2();
    group.name = 'presentation-shot-tracers';
    const lines = Array.from({ length: maxStreaks }, () => {
      const geometry = new LineSegmentsGeometry().setPositions(new Float32Array(6));
      const buffer = (geometry.getAttribute('instanceStart') as InterleavedBufferAttribute).data;
      const material = new LineMaterial({
        color: '#ffe4ac',
        linewidth: 2.2,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new LineSegments2(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;
      mesh.visible = false;
      mesh.onBeforeRender = () => material.resolution.copy(resolution);
      group.add(mesh);
      return { mesh, geometry, buffer };
    });
    return { group, lines, resolution };
  }, []);
  const anchor = useMemo(() => new Vector3(), []);

  useEffect(() => invalidate(), [active, invalidate]);
  useEffect(
    () => () => {
      for (const { mesh, geometry } of pool.lines) {
        geometry.dispose();
        mesh.material.dispose();
      }
    },
    [pool],
  );
  useFrame(({ camera, size }) => {
    pool.resolution.set(size.width, size.height);
    for (let i = 0; i < pool.lines.length; i++) {
      const shot = active[i];
      const { mesh, buffer } = pool.lines[i];
      const positions = buffer.array;
      mesh.visible = false;
      if (!shot) continue;
      const ray = rays.resolve(shot.id, shot.tick, () => {
        const view = viewAt(data, shot.id, shot.tick);
        return view ? traceRecordedShot(view, trace) : null;
      });
      if (!ray) continue;
      const span = shotTracerSpan(shot.age, ray.stop);
      if (!span) continue;
      const { head, tail } = span;
      const tailWeight = shotMuzzleWeight(tail, ray.stop);
      const headWeight = shotMuzzleWeight(head, ray.stop);
      const hasAnchor = tailWeight > 0 && evidence?.muzzles?.get(shot.id)?.read(anchor);
      if (
        hasAnchor &&
        Math.hypot(anchor.x - ray.origin[0], anchor.y - ray.origin[1], anchor.z - ray.origin[2]) <
          1.5
      ) {
        if (shot.id === pov && 'fov' in camera && typeof camera.fov === 'number') {
          camera.worldToLocal(anchor);
          const scale = povMuzzleScale(size.width / size.height, camera.fov);
          anchor.x *= scale;
          anchor.y *= scale;
          camera.localToWorld(anchor);
        }
        anchor.set(anchor.x - ray.origin[0], anchor.y - ray.origin[1], anchor.z - ray.origin[2]);
      } else {
        anchor.set(0, 0, 0);
      }
      for (let axis = 0; axis < 3; axis++) {
        const from = ray.origin[axis];
        const component = ray.direction[axis];
        const muzzleOffset = anchor.getComponent(axis);
        positions[axis] = from + component * tail + muzzleOffset * tailWeight;
        positions[axis + 3] = from + component * head + muzzleOffset * headWeight;
      }
      // instanceStart and instanceEnd share the same interleaved buffer.
      buffer.needsUpdate = true;
      mesh.material.opacity = 0.84 * (1 - shot.age / tracerLifetime);
      mesh.visible = true;
    }
  });

  return <primitive object={pool.group} />;
}
