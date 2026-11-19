export type PresentationKind = 'agents' | 'equipment' | 'equipment-models';
export type PresentationStatus = {
  schemaVersion: 1;
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
        animation?: 'native-locomotion' | 'native-idle';
        item?: string;
        counts?: { ready: number; unavailable: number; total: number };
        unsupported?: string[];
        code?:
          | 'interrupted'
          | 'timeout'
          | 'storage_limit'
          | 'source_mismatch'
          | 'steam_rate_limited'
          | 'preparation_failed';
      }
    >
  >;
};
