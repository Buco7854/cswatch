export type AgentWeaponClass = 'rifle' | 'pistol' | 'knife';
export type AgentDirection = 'n' | 'nw' | 'w' | 'sw' | 's' | 'se' | 'e' | 'ne';
export type AgentGait = 'walk' | 'run' | 'crouch';
export type AgentAction = 'fire' | 'reload' | 'draw';
export type AgentDeath = 'death-a' | 'death-b';
export type DirectionalAgentRole =
  | `${AgentWeaponClass}-${'idle' | 'crouch-idle' | AgentAction}`
  | `${AgentWeaponClass}-${AgentGait}-${AgentDirection}`
  | AgentDeath;
export interface DirectionalAgentMetadata {
  kind: 'native-agent';
  schemaVersion: 2;
  role: DirectionalAgentRole;
  rootMotion: 'recorded-position';
  /** Upper-body tracks are masked against the native rig at playback. */
  strideMeters?: number;
  phaseOffset?: number;
}
