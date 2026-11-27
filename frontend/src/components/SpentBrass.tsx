import { Component, Suspense, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Euler,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import type { Playback, Position } from '../types';
import { frameAt } from '../playback';
import {
  brassFlight,
  brassLanding,
  brassSpin,
  brassSystems,
  brassVelocity,
  weaponBrass,
} from '../brass';
import { useEquipmentGLTF, useEquipmentScope } from '../equipment-loader';
import { EquipmentModels } from './RenderEquipment';
import { useTracerEvidence, type EjectPort } from './EquipmentFire';

const INCH = 0.0254;
// The newest casings drawn across all shooters.
const maxShells = 48;
const models = [...new Set(Object.values(brassSystems).map((system) => system.model))];

const rotation = new Euler(0, 0, 0, 'YXZ');
/** A rigid frame at the recorded eye. Any consistent frame works: the port is carried from the
 * current eye frame to the eye frame of the shot. */
function eyeFrame(
  out: Matrix4,
  player: Pick<Position, 'x' | 'y' | 'z' | 'yaw' | 'pitch'> & {
    eyeOffset?: readonly number[];
  },
) {
  const eye = player.eyeOffset?.at(-1) ?? 64;
  rotation.set(-((player.pitch ?? 0) * Math.PI) / 180, ((player.yaw ?? 0) * Math.PI) / 180, 0);
  return out
    .makeRotationFromEuler(rotation)
    .setPosition(player.x * INCH, (player.z + eye) * INCH, -player.y * INCH);
}

type Shell = { model: string; matrix: Matrix4 };

const scratch = {
  now: new Matrix4(),
  shot: new Matrix4(),
  port: new Matrix4(),
  relative: new Matrix4(),
  spawn: new Matrix4(),
  position: new Vector3(),
  quaternion: new Quaternion(),
  scale: new Vector3(),
  velocity: new Vector3(),
  spin: new Quaternion(),
  axis: new Vector3(0, 0, -1),
};

/** Casings alive at `tick`, newest first. Each is placed from the shot's recorded eye frame and
 * the port's current offset from the shooter's eye, so a seek gives the same answer. */
function liveShells(
  data: Playback,
  tick: number,
  index: ReadonlyMap<string, readonly { tick: number; weapon: string }[]>,
  ejects: ReadonlyMap<string, EjectPort>,
) {
  const shells: Shell[] = [];
  const rate = data.tickRate;
  if (!data.frames.length) return shells;
  const current = frameAt(data, tick).frame;
  const candidates: { player: Position; shot: { tick: number; weapon: string } }[] = [];
  for (const player of current.players) {
    const shots = index.get(player.id);
    const port = ejects.get(player.id);
    if (!shots || !port || !player.alive) continue;
    for (let i = shots.length - 1; i >= 0; i--) {
      const shot = shots[i];
      if (shot.tick > tick) continue;
      if ((tick - shot.tick) / rate > 6) break;
      candidates.push({ player, shot });
    }
  }
  candidates.sort((a, b) => b.shot.tick - a.shot.tick);
  const relative = new Map<string, Matrix4 | null>();
  for (const { player, shot } of candidates) {
    if (shells.length >= maxShells) break;
    const brass = weaponBrass[shot.weapon];
    if (!brass) continue;
    const system = brassSystems[brass.system];
    const age = (tick - shot.tick) / rate - brass.at - system.delay;
    if (age < 0 || age >= system.life) continue;
    // The port relative to the shooter's current eye.
    if (!relative.has(player.id)) {
      const port = ejects.get(player.id)!;
      relative.set(
        player.id,
        port.read(scratch.port)
          ? new Matrix4().copy(eyeFrame(scratch.now, player)).invert().multiply(scratch.port)
          : null,
      );
    }
    const offset = relative.get(player.id);
    if (!offset) continue;
    const then = frameAt(data, shot.tick).frame.players.find((p) => p.id === player.id);
    if (!then?.alive) continue;
    scratch.spawn.multiplyMatrices(eyeFrame(scratch.shot, then), offset);
    scratch.spawn.decompose(scratch.position, scratch.quaternion, scratch.scale);
    const seed = Math.imul(shot.tick | 0, 7919) ^ hash(player.id);
    // Launch speed in the port's own axes, then Source inches with Z up for the fall.
    const local = brassVelocity(system, seed);
    scratch.velocity.set(local[0], local[1], local[2]).applyQuaternion(scratch.quaternion);
    const velocity = [scratch.velocity.x, -scratch.velocity.z, scratch.velocity.y] as const;
    const drop = Math.max(0, scratch.position.y / INCH - then.z);
    const landing = brassLanding(velocity[2], drop, system.life);
    const flight = brassFlight(velocity, age, drop, landing);
    scratch.position.x += flight.offset[0] * INCH;
    scratch.position.y += flight.offset[2] * INCH;
    scratch.position.z -= flight.offset[1] * INCH;
    scratch.spin.setFromAxisAngle(
      scratch.axis,
      brassSpin(system, seed, landing === undefined ? age : Math.min(age, landing)),
    );
    // C_OP_FadeOut over the last quarter of the life; a solid casing shrinks instead.
    const remaining = Math.min(1, (system.life - age) / (0.25 * system.life));
    shells.push({
      model: system.model,
      matrix: new Matrix4().compose(
        scratch.position,
        scratch.quaternion.multiply(scratch.spin),
        scratch.scale.setScalar(remaining),
      ),
    });
  }
  return shells;
}

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h;
}

/** One instanced draw per official casing model; SpentBrass writes its instances. */
function CasingInstances({
  url,
  model,
  meshes,
}: {
  url: string;
  model: string;
  meshes: Map<string, InstancedMesh>;
}) {
  const gltf = useEquipmentGLTF(url);
  const mesh = useMemo(() => {
    let found: Mesh | undefined;
    gltf.scene.updateWorldMatrix(true, true);
    gltf.scene.traverse((object) => {
      if (!found && object instanceof Mesh) found = object;
    });
    if (!found) return undefined;
    const geometry = (found.geometry as BufferGeometry).clone().applyMatrix4(found.matrixWorld);
    const instances = new InstancedMesh(geometry, found.material as Material, maxShells);
    instances.name = 'spent-brass:' + model;
    instances.frustumCulled = false;
    instances.count = 0;
    instances.visible = false;
    return instances;
  }, [gltf, model]);
  useEffect(() => {
    if (!mesh) return;
    meshes.set(model, mesh);
    return () => {
      meshes.delete(model);
      mesh.geometry.dispose();
    };
  }, [mesh, meshes, model]);
  return mesh ? <primitive object={mesh} /> : null;
}

/** A casing model that fails to load leaves the other casings drawn. */
class CasingBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Leases the casing model in the shared equipment cache, then loads it. */
function CasingModel({
  url,
  model,
  meshes,
  identity,
}: {
  url: string;
  model: string;
  meshes: Map<string, InstancedMesh>;
  identity: object;
}) {
  useEquipmentScope(url, identity);
  return (
    <CasingBoundary>
      <Suspense fallback={null}>
        <CasingInstances url={url} model={model} meshes={meshes} />
      </Suspense>
    </CasingBoundary>
  );
}

/** Spent casings from recorded shots, thrown from each weapon's authored ejection port. */
export default function SpentBrass({ data, tick }: { data: Playback; tick: number }) {
  const evidence = useTracerEvidence();
  const equipment = useContext(EquipmentModels);
  const catalog = equipment?.catalog;
  const ejects = evidence?.ejects;
  const index = evidence?.index;
  const meshes = useMemo(() => new Map<string, InstancedMesh>(), []);
  const latest = useRef({ data, tick });
  latest.current = { data, tick };
  // Ports appear as weapons mount, so the casings are resolved every rendered frame.
  useFrame(() => {
    if (!index || !ejects) return;
    const shells = liveShells(latest.current.data, latest.current.tick, index, ejects);
    for (const [model, mesh] of meshes) {
      let count = 0;
      for (const shell of shells)
        if (shell.model === model) mesh.setMatrixAt(count++, shell.matrix);
      mesh.count = count;
      mesh.visible = count > 0;
      if (count) mesh.instanceMatrix.needsUpdate = true;
    }
  });
  if (!catalog || !ejects) return null;
  return (
    <group name="spent-brass">
      {models.map((model) => {
        const item = catalog.items[model];
        return item && equipment ? (
          <CasingModel
            key={model}
            url={item.model}
            model={model}
            meshes={meshes}
            identity={equipment.identity}
          />
        ) : null;
      })}
    </group>
  );
}
