/** A cache owns resources, while scopes protect both the view and asynchronous renderer teardown. */
export type ModelResource = { key: object; bytes: number; dispose?: () => void };
export type ModelLoadCallbacks<T> = {
  loaded: (value: T) => void;
  failed: (error: unknown) => void;
  progress?: (event: ProgressEvent) => void;
  downloaded?: () => void;
};
type ModelProgress = number | 'preparing' | undefined;
export type ModelProgressSource = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => ModelProgress;
};
type Entry<T> = {
  url: string;
  refs: number;
  status: 'empty' | 'queued' | 'loading' | 'ready' | 'error';
  retired: boolean;
  running: boolean;
  used: number;
  value?: T;
  resources?: ModelResource[];
  callbacks: ModelLoadCallbacks<T>[];
  progress?: ModelProgress;
  progressListeners?: Set<() => void>;
  abort?: () => void;
};
export type ModelScope = {
  acquire: () => () => void;
  invalidate: () => void;
  isCurrent: () => boolean;
  progress: ModelProgressSource;
};
type Options<T> = {
  load: (url: string, callbacks: ModelLoadCallbacks<T>) => (() => void) | void;
  inspect: (value: T) => ModelResource[];
  clear: (url: string) => void;
  inactiveBytes: (active: boolean) => number;
  /** Optional hard retained CPU budget, including active assets. New assets fail independently. */
  residentBytes?: () => number;
  maxUnused?: number;
  maxConcurrent?: number;
};

export class ModelCache<T> {
  private current = new Map<string, Entry<T>>();
  private entries = new Set<Entry<T>>();
  private owners = new Map<object, { count: number; resource: ModelResource }>();
  private runningURLs = new Set<string>();
  private scheduled = false;
  private clock = 0;
  constructor(private readonly options: Options<T>) {}

  private entry(url: string): Entry<T> {
    let entry = this.current.get(url);
    if (!entry) {
      entry = {
        url,
        refs: 0,
        status: 'empty',
        retired: false,
        running: false,
        used: ++this.clock,
        callbacks: [],
      };
      this.current.set(url, entry);
      this.entries.add(entry);
      this.schedule();
    }
    return entry;
  }
  scope(url: string): ModelScope {
    let entry = this.entry(url);
    return {
      acquire: () => {
        if (entry.retired && !entry.refs) entry = this.entry(url);
        const held = entry;
        held.refs++;
        held.used = ++this.clock;
        this.schedule();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          held.refs--;
          if (!held.refs) held.used = ++this.clock;
          this.schedule();
        };
      },
      invalidate: () => this.retire(entry),
      isCurrent: () => this.current.get(url) === entry && !entry.retired,
      progress: {
        subscribe: (listener) => {
          const listeners = (entry.progressListeners ??= new Set());
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        snapshot: () => entry.progress,
      },
    };
  }
  /** Estimated GPU and CPU storage of every loaded asset, counted once per shared resource. */
  ownedBytes() {
    let bytes = 0;
    for (const { resource } of this.owners.values()) bytes += resource.bytes;
    return bytes;
  }
  /** Read an already-loaded asset without requesting or extending its lifetime. */
  peek(url: string) {
    const entry = this.current.get(url);
    return entry?.status === 'ready' ? entry.value : undefined;
  }
  request(url: string, callbacks: ModelLoadCallbacks<T>): void {
    const entry = this.entry(url);
    entry.used = ++this.clock;
    if (entry.status === 'ready') {
      callbacks.loaded(entry.value!);
      return;
    }
    if (entry.status === 'error') {
      callbacks.failed(new Error('Map model loading failed'));
      return;
    }
    entry.callbacks.push(callbacks);
    if (entry.status === 'empty') entry.status = 'queued';
    this.schedule();
  }
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.maintain();
    });
  }
  private maintain(): void {
    for (const entry of [...this.entries]) {
      if (!entry.refs && (entry.retired || entry.status !== 'ready')) this.retire(entry);
    }
    const unused = [...this.current.values()]
      .filter((entry) => !entry.refs && entry.status === 'ready')
      .sort((a, b) => a.used - b.used);
    const bytes = () => {
      const resources = new Map<object, number>();
      for (const entry of unused)
        for (const resource of entry.resources || [])
          resources.set(resource.key, Math.max(resources.get(resource.key) || 0, resource.bytes));
      return [...resources.values()].reduce((sum, size) => sum + size, 0);
    };
    const active = [...this.current.values()].some((entry) => entry.refs > 0);
    const inactiveLimit = this.options.inactiveBytes(active);
    while (unused.length > (this.options.maxUnused ?? 2) || bytes() > inactiveLimit)
      this.retire(unused.shift()!);
    for (const entry of this.current.values()) {
      if (this.runningURLs.size >= (this.options.maxConcurrent ?? 2)) break;
      if (entry.status !== 'queued' || !entry.refs || this.runningURLs.has(entry.url)) continue;
      entry.status = 'loading';
      entry.running = true;
      this.runningURLs.add(entry.url);
      try {
        const abort = this.options.load(entry.url, {
          loaded: (value) => this.loaded(entry, value),
          failed: (error) => this.failed(entry, error),
          progress: (event) => {
            if (entry.retired) return;
            const { loaded, total, lengthComputable } = event;
            this.reportProgress(
              entry,
              lengthComputable &&
                Number.isSafeInteger(loaded) &&
                Number.isSafeInteger(total) &&
                total > 0 &&
                loaded >= 0 &&
                loaded <= total
                ? Math.floor((loaded / total) * 100)
                : undefined,
            );
            for (const callback of entry.callbacks) callback.progress?.(event);
          },
          downloaded: () => this.reportProgress(entry, 'preparing'),
        });
        if (entry.running) entry.abort = abort || undefined;
      } catch (error) {
        this.failed(entry, error);
      }
    }
  }
  private reportProgress(entry: Entry<T>, progress: ModelProgress): void {
    if (entry.retired || !entry.running || progress === entry.progress) return;
    entry.progress = progress;
    for (const listener of entry.progressListeners || []) listener();
  }
  private retire(entry: Entry<T>): void {
    let changed = false;
    if (!entry.retired) {
      changed = true;
      entry.retired = true;
      entry.progressListeners?.clear();
      if (this.current.get(entry.url) === entry) {
        this.current.delete(entry.url);
        this.options.clear(entry.url);
      }
      const callbacks = entry.callbacks.splice(0);
      if (entry.running) entry.abort?.();
      for (const callback of callbacks) callback.failed(new Error('Map model loading cancelled'));
    }
    if (!entry.refs && !entry.running) {
      this.releaseResources(entry);
      changed = this.entries.delete(entry) || changed;
    }
    if (changed) this.schedule();
  }
  private finish(entry: Entry<T>): boolean {
    if (!entry.running) return false;
    entry.running = false;
    entry.abort = undefined;
    this.runningURLs.delete(entry.url);
    return true;
  }
  private resources(value: T): ModelResource[] {
    const unique = new Map<object, ModelResource>();
    for (const resource of this.options.inspect(value)) {
      const previous = unique.get(resource.key);
      if (!previous || resource.bytes > previous.bytes) unique.set(resource.key, resource);
    }
    return [...unique.values()];
  }
  private own(entry: Entry<T>, resources: ModelResource[]): void {
    entry.resources = resources;
    for (const resource of resources) {
      const owner = this.owners.get(resource.key);
      if (owner) {
        owner.count++;
        if (resource.bytes > owner.resource.bytes)
          owner.resource = { ...owner.resource, bytes: resource.bytes };
      } else this.owners.set(resource.key, { count: 1, resource });
    }
  }
  private releaseResources(entry: Entry<T>): void {
    for (const resource of entry.resources || []) {
      const owner = this.owners.get(resource.key);
      if (!owner) continue;
      owner.count--;
      if (!owner.count) {
        this.owners.delete(resource.key);
        try {
          owner.resource.dispose?.();
        } catch {
          /* Continue releasing independent resources after a driver disposal failure. */
        }
      }
    }
    entry.resources = undefined;
    entry.value = undefined;
  }
  private loaded(entry: Entry<T>, value: T): void {
    const finished = this.finish(entry);
    let resources: ModelResource[];
    try {
      resources = this.resources(value);
    } catch (error) {
      if (finished) {
        entry.status = 'error';
        const callbacks = entry.callbacks.splice(0);
        for (const callback of callbacks) callback.failed(error);
        if (entry.retired || !entry.refs) this.retire(entry);
      }
      this.schedule();
      return;
    }
    if (!finished) {
      const discarded = { ...entry, resources: undefined, value: undefined };
      this.own(discarded, resources);
      this.releaseResources(discarded);
      return;
    }
    if (entry.retired || !entry.refs) {
      const discarded = { ...entry, resources: undefined, value: undefined };
      this.own(discarded, resources);
      this.releaseResources(discarded);
      this.retire(entry);
      return;
    }
    const residentLimit = this.options.residentBytes?.();
    if (residentLimit !== undefined) {
      const retainedBytes = () => {
        let bytes = 0;
        for (const { resource } of this.owners.values()) bytes += resource.bytes;
        for (const resource of resources) {
          const owned = this.owners.get(resource.key)?.resource.bytes || 0;
          bytes += Math.max(0, resource.bytes - owned);
        }
        return bytes;
      };
      const unused = [...this.current.values()]
        .filter((other) => other !== entry && !other.refs && other.status === 'ready')
        .sort((a, b) => a.used - b.used);
      while (retainedBytes() > residentLimit && unused.length) this.retire(unused.shift()!);
      if (retainedBytes() > residentLimit) {
        const discarded = { ...entry, resources: undefined, value: undefined };
        this.own(discarded, resources);
        this.releaseResources(discarded);
        entry.status = 'error';
        const callbacks = entry.callbacks.splice(0);
        for (const callback of callbacks)
          callback.failed(new Error('Model resource budget exceeded'));
        if (!entry.refs) this.retire(entry);
        this.schedule();
        return;
      }
    }
    entry.value = value;
    entry.status = 'ready';
    entry.used = ++this.clock;
    this.own(entry, resources);
    const callbacks = entry.callbacks.splice(0);
    for (const callback of callbacks) {
      try {
        callback.loaded(value);
      } catch (error) {
        callback.failed(error);
      }
    }
    this.schedule();
  }
  private failed(entry: Entry<T>, error: unknown): void {
    if (!this.finish(entry)) return;
    entry.status = 'error';
    const callbacks = entry.callbacks.splice(0);
    for (const callback of callbacks) callback.failed(error);
    if (entry.retired || !entry.refs) this.retire(entry);
    else this.schedule();
  }
}
