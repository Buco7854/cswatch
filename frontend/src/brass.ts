/** Spent brass as the official casing particle systems throw it
 * (particles/weapons/cs_weapon_fx/weapon_shell_casing_*): one model particle per shot from the
 * weapon's `shell_eject` attachment, with a speed drawn in the attachment's own axes, gravity
 * -600 in/s², drag 0.05 and the system's lifetime. Each weapon's system and the moment it is
 * emitted come from the CNmParticleEvent (config `shell_eject`) of its official first-person fire
 * clip (manifest 5924479096069937098). The systems have no collision; here a casing comes to
 * rest on the shooter's floor, where Bounce.Shell plays. */

const INCH = 0.0254;
type V3 = readonly [number, number, number];

export type BrassSystem = {
  /** The official casing model, prepared as an equipment item. */
  model: string;
  speedMin: V3;
  speedMax: V3;
  life: number;
  /** C_OP_RotateVector rate range, degrees per second. */
  spin: readonly [number, number];
  /** Emission delay inside the system (C_OP_InstantaneousEmitter start time). */
  delay: number;
  sound: 'shell' | 'shotgun';
};

export const brassSystems = {
  rifle: {
    model: 'casingrifle',
    speedMin: [200, 15, 50],
    speedMax: [250, -5, 75],
    life: 3,
    spin: [300, 1500],
    delay: 0.04,
    sound: 'shell',
  },
  '9mm': {
    model: 'casing9mm',
    speedMin: [150, 15, 50],
    speedMax: [200, -5, 75],
    life: 2,
    spin: [3500, 4500],
    delay: 0.04,
    sound: 'shell',
  },
  awp: {
    model: 'casingawp',
    speedMin: [150, 15, 50],
    speedMax: [180, -5, 75],
    life: 5,
    spin: [300, 1500],
    delay: 0.04,
    sound: 'shell',
  },
  deagle: {
    model: 'casingdeagle',
    speedMin: [250, 15, 50],
    speedMax: [280, -5, 75],
    life: 3,
    spin: [3500, 4500],
    delay: 0.04,
    sound: 'shell',
  },
  '57': {
    model: 'casing57',
    speedMin: [200, 15, 50],
    speedMax: [250, -5, 75],
    life: 2,
    spin: [300, 1500],
    delay: 0.04,
    sound: 'shell',
  },
  '45acp': {
    model: 'casingdeagle',
    speedMin: [200, 15, 50],
    speedMax: [220, -5, 75],
    life: 2,
    spin: [3500, 4500],
    delay: 0.04,
    sound: 'shell',
  },
  shotgun: {
    model: 'casingxm1014',
    speedMin: [200, -15, 50],
    speedMax: [250, 5, 75],
    life: 5,
    spin: [300, 1500],
    delay: 0,
    sound: 'shotgun',
  },
  shotgun_mag7: {
    model: 'casingmag7',
    speedMin: [200, 15, 50],
    speedMax: [250, -5, 75],
    life: 5,
    spin: [300, 1500],
    delay: 0,
    sound: 'shotgun',
  },
  shotgun_nova: {
    model: 'casingnova',
    speedMin: [200, -15, -150],
    speedMax: [250, 5, -150],
    life: 5,
    spin: [300, 1500],
    delay: 0,
    sound: 'shotgun',
  },
} as const satisfies Record<string, BrassSystem>;
export type BrassSystemId = keyof typeof brassSystems;

/** Each firearm's casing system and when its fire clip emits it (seconds after the shot):
 * the event's normalised start time times the clip's duration. The revolver and Zeus emit none. */
export const weaponBrass: Readonly<Record<string, { system: BrassSystemId; at: number }>> = {
  ak47: { system: 'rifle', at: 0 },
  aug: { system: 'rifle', at: 0 },
  awp: { system: 'awp', at: 0.4375 * 1.6 },
  bizon: { system: '9mm', at: 0 },
  cz75a: { system: '9mm', at: 0 },
  deagle: { system: 'deagle', at: 0 },
  elite: { system: '9mm', at: 0 },
  famas: { system: 'rifle', at: 0 },
  fiveseven: { system: '57', at: 0 },
  g3sg1: { system: 'rifle', at: 0.06631 * 0.7333 },
  galilar: { system: 'rifle', at: 0 },
  glock: { system: '9mm', at: 0 },
  hkp2000: { system: '9mm', at: 0 },
  m249: { system: 'rifle', at: 0 },
  m4a1: { system: 'rifle', at: 0 },
  m4a1silencer: { system: 'rifle', at: 0 },
  mac10: { system: '9mm', at: 0 },
  mag7: { system: 'shotgun_mag7', at: 0.277778 * 1.2 },
  mp5sd: { system: '9mm', at: 0 },
  mp7: { system: '9mm', at: 0 },
  mp9: { system: '9mm', at: 0 },
  negev: { system: 'rifle', at: 0 },
  nova: { system: 'shotgun_nova', at: 0.416667 * 0.8 },
  p250: { system: '9mm', at: 0 },
  p90: { system: '57', at: 0 },
  sawedoff: { system: 'shotgun', at: 0.291667 * 0.8 },
  scar20: { system: 'rifle', at: 0.08 * 0.8333 },
  sg556: { system: 'rifle', at: 0 },
  ssg08: { system: 'awp', at: 0.48 * 1.6667 },
  tec9: { system: '9mm', at: 0 },
  ump45: { system: '45acp', at: 0 },
  uspsilencer: { system: '9mm', at: 0 },
  xm1014: { system: 'shotgun', at: 0.115385 * 0.8667 },
};

const unit = (a: number, b: number, c: number) => {
  let h =
    Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const drag = -30 * Math.log(1 - 0.05);
const gravity = -600;

/** The casing's launch velocity in Source inches per second, in the eject attachment's axes. */
export function brassVelocity(system: BrassSystem, seed: number): V3 {
  return [0, 1, 2].map((axis) =>
    lerp(system.speedMin[axis], system.speedMax[axis], unit(seed, 17, axis)),
  ) as unknown as V3;
}

/** Height (inches, relative to launch) and vertical speed after `t` seconds. */
function fall(vz: number, t: number) {
  const decay = Math.exp(-drag * t),
    terminal = gravity / drag;
  return {
    z: ((vz - terminal) * (1 - decay)) / drag + terminal * t,
    vz: (vz - terminal) * decay + terminal,
  };
}

/** Seconds after launch at which a casing launched `drop` inches above its floor with world
 * vertical speed `vz` reaches the floor (bisection on the closed-form fall). */
export function brassLanding(vz: number, drop: number, life: number) {
  if (!(drop > 0)) return 0;
  if (fall(vz, life).z > -drop) return undefined;
  let low = 0,
    high = life;
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2;
    if (fall(vz, middle).z > -drop) low = middle;
    else high = middle;
  }
  return high;
}

/** Offset (inches, world axes) `t` seconds after launch with world velocity `v`; after landing
 * (`landing` seconds) the casing rests where it touched down, `drop` inches below launch. */
export function brassFlight(v: V3, t: number, drop: number, landing: number | undefined) {
  const landed = landing !== undefined && t >= landing;
  const at = landed ? landing : t;
  const reach = (1 - Math.exp(-drag * at)) / drag;
  return {
    offset: [v[0] * reach, v[1] * reach, landed ? -drop : fall(v[2], at).z] as V3,
    landed,
  };
}

export const brassSpin = (system: BrassSystem, seed: number, t: number) =>
  (lerp(system.spin[0], system.spin[1], unit(seed, 23, 0)) * Math.PI * t) / 180;

export const metres = (inches: number) => inches * INCH;

/** Bounce.Shell (pl_shell1-3, volume 0.8) and Bounce.ShotgunShell (shotgun_shell1-3, volume 0.1):
 * the official landing events are the same on every surface. Each blocks itself for 0.4 s. */
export const brassSounds = {
  shell: {
    samples: ['weapon-4e38c04754d4', 'weapon-85714eca4cf9', 'weapon-67f2b4cc0ecb'],
    volume: 0.799805,
  },
  shotgun: {
    samples: ['weapon-4319ff920b59', 'weapon-3789a60a7a99', 'weapon-714c0acb6326'],
    volume: 0.099976,
  },
} as const;
const blockSeconds = 0.4;
const maxBrassCues = 4096;

type Shooter = { x: number; y: number; z: number; eyeOffset?: readonly number[] };

/** Derived landing cues: the casing leaves the port about eight inches below the recorded eye
 * with the system's mean upward speed and lands on the shooter's floor. */
export function brassCues(
  shots: readonly { tick: number; weapon: string; actor: string; seed: number }[],
  rate: number,
  locate: (actor: string, tick: number) => Shooter | undefined,
) {
  const cues: import('../../shared/gameplay-sounds').GameplaySoundCue[] = [];
  const blocked = new Map<string, number>();
  for (const shot of shots) {
    if (cues.length >= maxBrassCues) break;
    const brass = weaponBrass[shot.weapon];
    if (!brass) continue;
    const system = brassSystems[brass.system];
    const shooter = locate(shot.actor, shot.tick);
    if (!shooter) continue;
    const eye = shooter.eyeOffset?.at(-1) ?? 64;
    const vz = (system.speedMin[2] + system.speedMax[2]) / 2;
    const landing = brassLanding(vz, Math.max(1, eye - 8), system.life);
    if (landing === undefined) continue;
    const tick = Math.round(shot.tick + (brass.at + system.delay + landing) * rate);
    if ((blocked.get(shot.actor) ?? -Infinity) > tick) continue;
    blocked.set(shot.actor, tick + blockSeconds * rate);
    const sound = brassSounds[system.sound];
    cues.push({
      id: `brass-${shot.actor}-${shot.tick}`,
      tick,
      soundId: sound.samples[Math.floor(unit(shot.seed, 29, 0) * sound.samples.length)],
      category: 'weapon',
      evidence: 'recorded-state',
      selection: 'representative',
      eventName: system.sound === 'shell' ? 'Bounce.Shell' : 'Bounce.ShotgunShell',
      actor: shot.actor,
      position: { x: shooter.x, y: shooter.y, z: shooter.z },
      volume: sound.volume,
    });
  }
  return cues;
}
