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
