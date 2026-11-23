export type MatchDemo = {
  id: string;
  status: string;
  map?: string | null;
  score?: number[] | null;
};

export type MatchActivityRow = {
  busy?: 'details' | 'download';
  files?: { id: string; file: number; demo: MatchDemo | null }[];
  error?: string;
  unavailable?: boolean;
  added?: MatchDemo;
};

/** Lives with the signed-in session, including while the viewer is open. */
export class MatchActivity {
  private rows = new Map<string, MatchActivityRow>();
  private listeners = new Set<() => void>();
  private completedImports = 0;
  completed = () => this.completedImports;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = (id: string) => this.rows.get(id);
  set(id: string, value: MatchActivityRow) {
    if (value.added && value.added.id !== this.rows.get(id)?.added?.id) this.completedImports++;
    this.rows.delete(id);
    this.rows.set(id, value);
    if (this.rows.size > 256) {
      for (const [key, row] of this.rows) {
        if (row.busy || key === id) continue;
        this.rows.delete(key);
        break;
      }
    }
    for (const listener of this.listeners) listener();
  }
}
