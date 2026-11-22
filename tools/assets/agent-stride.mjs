import contract from '../../shared/agent-animation.json' with { type: 'json' };

export function agentStride(role, feet, frames, duration, rootDelta) {
  const direction = contract.directions.indexOf(role.split('-').at(-1));
  if (
    direction < 0 ||
    feet.length !== frames.length ||
    feet.some((pair) => pair.some((foot) => !foot))
  )
    throw Error('Directional animation requires authored left and right foot tracks.');
  // S2V has the actor facing +Z. Its +X is the actor's left (Valve west).
  const angle = (direction * Math.PI) / 4;
  const forward = [Math.sin(angle), Math.cos(angle)];
  const project = ([x, , z]) => x * forward[0] + z * forward[1];
  const rates = [];
  let dx = 0,
    dz = 0,
    cos = 0,
    sin = 0;
  for (let i = 1; i < frames.length; i++) {
    const elapsed = frames[i] - frames[i - 1];
    const midpoint = (frames[i] + frames[i - 1]) / 2;
    const phase = (midpoint * 2 * Math.PI) / duration;
    const separation = project(feet[i][0]) - project(feet[i][1]);
    cos += separation * elapsed * Math.cos(phase);
    sin += separation * elapsed * Math.sin(phase);

    const height = (side) => (feet[i][side][1] + feet[i - 1][side][1]) / 2;
    const side = height(0) < height(1) ? 0 : 1;
    const a = feet[i - 1][side],
      b = feet[i][side];
    // Relative to the actor, the planted foot is carried backwards by the ground.
    dx += a[0] - b[0];
    dz += a[2] - b[2];
    const rate = (project(a) - project(b)) / elapsed;
    if (rate > 0.15) rates.push(rate);
  }
  const rootDistance = Math.hypot(rootDelta[0], rootDelta[2]);
  const authoredRoot = rootDistance > 0.1;
  if (authoredRoot) [dx, , dz] = rootDelta;
  const alignment = (dx * forward[0] + dz * forward[1]) / Math.hypot(dx, dz);
  if (!(alignment > 0.85) || (!authoredRoot && rates.length < frames.length / 3))
    throw Error(`Authored motion direction does not match ${role} (${alignment.toFixed(3)}).`);
  rates.sort((a, b) => a - b);
  const strideMeters = authoredRoot ? rootDistance : rates[Math.floor(rates.length / 2)] * duration;
  if (
    !(strideMeters >= 0.1 && strideMeters <= contract.limits.maxStrideMeters) ||
    strideMeters / duration > contract.limits.maxSpeedMetersPerSecond
  )
    throw Error(`Authored stride is outside the supported range for ${role}.`);
  return {
    strideMeters,
    phaseOffset: (Math.atan2(sin, cos) / (2 * Math.PI) + 1) % 1,
    strideSource: authoredRoot ? 'root' : 'plant',
    directionAlignment: alignment,
  };
}
