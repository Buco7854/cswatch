type PreparationFailureCode =
  | 'interrupted'
  | 'timeout'
  | 'storage_limit'
  | 'source_mismatch'
  | 'steam_rate_limited'
  | 'preparation_failed';
export type PresentationKind = 'agents' | 'equipment' | 'equipment-models' | 'viewmodels';
export type PresentationRetry = { kind: PresentationKind; manifest: string; generation: string };
export type PresentationStatus = {
  schemaVersion: 3;
  categories: Partial<
    Record<
      PresentationKind,
      {
        manifest: string;
        generation: string;
        status: 'preparing' | 'ready' | 'preserved' | 'failed';
        attempts: number;
        updatedAt: number;
        retryAt?: number;
        stage?: 'acquiring' | 'converting' | 'publishing';
        item?: string;
        counts?: { ready: number; unavailable: number; total: number };
        unsupportedCode?: 'missing_official_resource';
        operatorPresent?: true;
        unsupported?: string[];
        code?: PreparationFailureCode;
        itemRetries?: Record<
          string,
          {
            attempts: number;
            generation: string;
            updatedAt: number;
            retryAt?: number;
            code?: PreparationFailureCode;
          }
        >;
      }
    >
  >;
};
