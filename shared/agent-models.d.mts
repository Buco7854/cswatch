export type OfficialAgentModel = {
  /** Decimal model resource handle recorded by the demo. */
  handle: string;
  /** `<folder>/<model>` under characters/models and agents/models. */
  entry: string;
  team: 'ct' | 't';
  /** Pinned depot resource holding geometry and physics. */
  resource: string;
};
export const agentModelLimits: Readonly<{
  perDemo: number;
  catalogue: number;
  requestBytes: number;
}>;
export function agentModelHandle(value: unknown): value is string;
export const officialAgentModels: ReadonlyMap<string, OfficialAgentModel>;
export const officialAgentManifest: string;
