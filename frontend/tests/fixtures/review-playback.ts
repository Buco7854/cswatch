import type { Playback } from '../../../shared/playback';
export const actor = '76561198000000001',
  target = '76561198000000002';
/** Original protocol-shaped fixture, never a user's match or claimed Source 2 artwork. */
export function recordedReplay(): Playback {
  return {
    map: 'de_review_prompts_fixture',
    sample: false,
    tickRate: 64,
    players: [
      { id: actor, name: 'Duplicate name', team: 3 },
      { id: target, name: 'Duplicate name', team: 2 },
    ],
    frames: [0, 256, 512, 768, 1024, 1536].map((tick) => ({
      tick,
      players: [actor, target].map((id, index) => ({
        id,
        x: index ? 300 : -100,
        y: index ? 100 : -100,
        z: 0,
        yaw: index ? 180 : 0,
        pitch: 0,
        health: index && tick >= 768 ? 0 : 100,
        alive: !(index && tick >= 768),
        team: index ? 2 : 3,
        weapon: index ? 'awp' : 'ak47',
      })),
    })),
    rounds: [{ number: 1, tick: 0, liveTick: 64, endTick: 1280 }],
    events: [
      {
        type: 'grenade_thrown',
        tick: 256,
        user_steamid: actor,
        user_name: 'Duplicate name',
        weapon: 'smokegrenade',
        entityid: 73,
      },
      {
        type: 'smokegrenade_detonate',
        tick: 512,
        user_steamid: actor,
        user_name: 'Duplicate name',
        x: 320,
        y: 0,
        z: 0,
        entityid: 73,
      },
      {
        type: 'player_death',
        tick: 768,
        attacker_steamid: actor,
        user_steamid: target,
        attacker_name: 'Duplicate name',
        user_name: 'Duplicate name',
        weapon: 'ak47',
      },
    ],
    grenades: [
      {
        id: '73-256',
        kind: 'CSmokeGrenadeProjectile',
        points: [
          { tick: 256, x: 64, y: 0, z: 80 },
          { tick: 384, x: 192, y: 80, z: 180 },
          { tick: 512, x: 320, y: 0, z: 0 },
        ],
      },
    ],
    worldBounds: { minX: -500, maxX: 500, minY: -500, maxY: 500, minZ: 0, maxZ: 200 },
  };
}
