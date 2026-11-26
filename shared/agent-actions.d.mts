export type AgentActionBlend = 'upper' | 'full' | 'delta';
export type AgentActionRole = string;
export type AgentActionMetadata = {
  kind: 'native-agent-action';
  schemaVersion: number;
  role: AgentActionRole;
  blend: AgentActionBlend;
  rootMotion: 'clip' | 'recorded-position';
  travel: [number, number, number];
  climbMeters?: number;
};
export declare const agentActionRoles: readonly AgentActionRole[];
export declare function agentActionKind(role: string): AgentActionBlend | undefined;
export declare const agentActionContract: {
  schemaVersion: number;
  weapons: Record<string, [kind: 'rifle' | 'pistol', folder: string, name: string, shoot: string]>;
  weaponActions: string[];
  classes: string[];
  flinches: string[];
  deaths: string[];
  limits: { seconds: number; maxChannels: number; maxRoles: number };
};
export declare function agentActionDeclarations(
  animations: unknown,
): Map<AgentActionRole, AgentActionMetadata> | undefined;
