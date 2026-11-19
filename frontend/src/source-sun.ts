import { DirectionalLight, Matrix4, Vector3, type Object3D } from 'three';

type Triplet = readonly [number, number, number];
export type SourceSun = Readonly<{
  /** Unit vector toward the light, in the supplied prepared map root's coordinates. */
  directionToSun: Triplet;
  /** Authored linear RGB, already decoded by GLTFLoader. */
  color: Triplet;
}>;

const maxNodes = 100_000;
const maxSunNodes = 16;
const maxDepth = 256;

function directionToSun(node: Object3D, root: Object3D): Vector3 | null {
  const matrix = new Matrix4(),
    local = new Matrix4();
  let current: Object3D | null = node;
  for (let depth = 0; current && depth < maxDepth; depth++) {
    if (current.matrixAutoUpdate)
      local.compose(current.position, current.quaternion, current.scale);
    else local.copy(current.matrix);
    if (!local.elements.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e12))
      return null;
    matrix.premultiply(local);
    if (current === root) {
      // KHR_lights_punctual rays follow local -Z. Translation does not affect
      // an infinite light, and the prepared root already includes S2V's +90 Y.
      const direction = new Vector3(0, 0, 1).transformDirection(matrix);
      return direction.toArray().every(Number.isFinite) && direction.lengthSq() > 0.99
        ? direction
        : null;
    }
    current = current.parent;
  }
  return null;
}

/** Retain native sun pose/color without enabling Source engine light energies.
 * Read prepared.main after its existing coordinate transform. Never mutate
 * cached objects/matrices, infer a sun from arbitrary names, or accept disagreeing
 * main/sky authoring. Missing/unsupported evidence leaves the viewer fallback.
 */
export function readSourceSun(root: Object3D): SourceSun | null {
  const pending = [root];
  let visited = 0,
    suns = 0,
    result: { direction: Vector3; color: Triplet } | null = null;
  while (pending.length) {
    if (++visited > maxNodes) return null;
    const node = pending.pop()!;
    if (node instanceof DirectionalLight && node.userData.name === 'light_environment') {
      if (++suns > maxSunNodes) return null;
      const color: Triplet = [node.color.r, node.color.g, node.color.b],
        direction = directionToSun(node, root);
      if (
        !direction ||
        !color.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
        !color.some((value) => value > 0)
      )
        return null;
      if (result) {
        if (
          result.direction.dot(direction) < 1 - 1e-6 ||
          result.color.some((value, index) => Math.abs(value - color[index]) > 1e-5)
        )
          return null;
      } else result = { direction, color };
    }
    if (visited + pending.length + node.children.length > maxNodes) return null;
    for (const child of node.children) pending.push(child);
  }
  return result
    ? Object.freeze({
        directionToSun: Object.freeze(result.direction.toArray()) as Triplet,
        color: Object.freeze(result.color),
      })
    : null;
}
