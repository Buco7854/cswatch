export type MatchRank = {
  mode: 'Premier' | 'Competitive' | 'Wingman';
  value: number;
  change?: number;
};
export type MatchPerformance = {
  kills?: number;
  deaths?: number;
  assists?: number;
  headshotKills?: number;
  rank?: MatchRank;
};
