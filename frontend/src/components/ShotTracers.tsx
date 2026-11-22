import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Group, Vector2, Vector3, type InterleavedBufferAttribute } from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { frameAt } from '../playback';
import { playerPose } from '../player-pose';
import { firstPersonView, povProjection } from '../pov-camera';
import { recentWeaponShot } from '../weapon-fire';
import { createShotRayCache, shotTracerSpan, tracerLifetime, tracerReach } from '../shot-tracer';
import type { followObstruction } from '../follow-obstruction';
import type { Playback } from '../types';
import { useTracerEvidence } from './EquipmentFire';

const maxStreaks = 12;

function viewAt(data: Playback, id: string, at: number) {
  const { frame, next, alpha } = frameAt(data, at);
  const from = frame.players.find((player) => player.id === id);
  if (!from?.alive) return;
  return firstPersonView(
    playerPose(
      from,
      next.players.find((player) => player.id === id),
      alpha,
      {
        fromTick: frame.tick,
        nextTick: next.tick,
        tickRate: data.tickRate,
        roundBoundary: data.rounds.some(
          (round) => round.tick > frame.tick && round.tick <= next.tick,
        ),
      },
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
  trace: ReturnType<ReturnType<typeof followObstruction>['fork']>;
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
    () => createShotRayCache<{ origin: Vector3; direction: Vector3; stop: number } | null>(),
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
  const vectors = useMemo(
    () => ({
      eye: new Vector3(),
      direction: new Vector3(),
      right: new Vector3(),
      up: new Vector3(),
      origin: new Vector3(),
      tip: new Vector3(),
      anchor: new Vector3(),
      currentEye: new Vector3(),
      currentDirection: new Vector3(),
      currentRight: new Vector3(),
      currentUp: new Vector3(),
    }),
    [],
  );

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
    const {
      eye,
      direction,
      right,
      up,
      origin,
      tip,
      anchor,
      currentEye,
      currentDirection,
      currentRight,
      currentUp,
    } = vectors;
    pool.resolution.set(size.width, size.height);
    for (let i = 0; i < pool.lines.length; i++) {
      const shot = active[i];
      const { mesh, buffer } = pool.lines[i];
      const positions = buffer.array;
      mesh.visible = false;
      if (!shot) continue;
      const ray = rays.resolve(shot.id, shot.tick, () => {
        const view = viewAt(data, shot.id, shot.tick);
        if (!view) return null;
        eye.fromArray(view.position);
        direction.fromArray(view.target).sub(eye).normalize();
        right.set(-direction.z, 0, direction.x).normalize();
        up.crossVectors(right, direction).normalize();
        const firstPerson = shot.id === pov;
        const hasAnchor = evidence?.muzzles?.get(shot.id)?.read(anchor);
        // The visual weapon anchor may move since release. Keep its hand offset
        // in the shot's recorded eye basis, with a bounded proxy for missing packs.
        origin
          .copy(eye)
          .addScaledVector(direction, 0.68)
          .addScaledVector(right, 0.17)
          .addScaledVector(up, -0.18);
        const currentView = hasAnchor ? (viewAt(data, shot.id, tick) ?? view) : null;
        if (
          currentView &&
          anchor.distanceToSquared(currentEye.fromArray(currentView.position)) < 2.25
        ) {
          currentDirection.fromArray(currentView.target).sub(currentEye).normalize();
          currentRight.set(-currentDirection.z, 0, currentDirection.x).normalize();
          currentUp.crossVectors(currentRight, currentDirection).normalize();
          anchor.sub(currentEye);
          let lateralScale = 1;
          if (firstPerson && 'fov' in camera && typeof camera.fov === 'number') {
            const lens = povProjection(size.width / size.height);
            lateralScale =
              Math.tan((camera.fov * Math.PI) / 360) / Math.tan((lens.fov * Math.PI) / 360);
          }
          origin
            .copy(eye)
            .addScaledVector(direction, anchor.dot(currentDirection))
            .addScaledVector(right, anchor.dot(currentRight) * lateralScale)
            .addScaledVector(up, anchor.dot(currentUp) * lateralScale);
        }
        // Also test eye-to-muzzle so a pose overlapping a wall cannot emit out of its far side.
        const originPosition = origin.toArray();
        if (trace({ target: view.position, position: originPosition }) !== originPosition)
          return null;
        tip.copy(origin).addScaledVector(direction, tracerReach);
        tip.fromArray(trace({ target: originPosition, position: tip.toArray() }));
        const stop = tip.sub(origin).dot(direction);
        return { origin: origin.clone(), direction: direction.clone(), stop };
      });
      if (!ray) continue;
      const span = shotTracerSpan(shot.age, ray.stop);
      if (!span) continue;
      const { head, tail } = span;
      for (let axis = 0; axis < 3; axis++) {
        positions[axis] = ray.origin.getComponent(axis) + ray.direction.getComponent(axis) * tail;
        positions[axis + 3] =
          ray.origin.getComponent(axis) + ray.direction.getComponent(axis) * head;
      }
      // instanceStart and instanceEnd share the same interleaved buffer.
      buffer.needsUpdate = true;
      mesh.material.opacity = 0.84 * (1 - shot.age / tracerLifetime);
      mesh.visible = true;
    }
  });

  return <primitive object={pool.group} />;
}
