/** Trusted operator-prepared native cycles, not recorded player bone animation. */
export type AgentAnimationRole = 'idle' | 'walk' | 'run' | 'crouch-idle' | 'crouch-walk';
export type AgentAnimationName = `cswatch:${AgentAnimationRole}`;
export interface PreparedAgentAnimationMetadata {
  kind: 'native-locomotion';
  schemaVersion: 1;
  role: AgentAnimationRole;
  /** The clip never adds travel or yaw already supplied by the recording. */
  rootMotion: 'recorded-position';
}
export interface PreparedAgentAnimationSummary {
  role: AgentAnimationRole;
  name: AgentAnimationName;
  clip: string;
  duration: number;
  samples: number;
  mappedBones: number;
  /** Measured planar S2V root travel. Zero means no authored stride speed. */
  nativeGroundDistance: number;
  nativeGroundSpeed: number;
}
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
