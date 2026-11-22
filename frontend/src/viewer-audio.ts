import { useEffect, useMemo, useSyncExternalStore } from 'react';

export type ListenerPose = {
  position: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
};
type ViewerAudioState = 'locked' | 'running' | 'unavailable' | 'closed';
const volume = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

/** One lazy context per viewer identity. Voice and gameplay own separate gains,
 * but share autoplay, master volume, listener and a bounded source budget. */
export class ViewerAudio {
  context: AudioContext | null = null;
  private master: GainNode | null = null;
  private channels = new Set<GainNode>();
  private sources = new Map<AudioBufferSourceNode, () => void>();
  private listeners = new Set<() => void>();
  private resets = new Set<() => void>();
  private state: ViewerAudioState = 'locked';
  private closed = false;
  private pending: Promise<boolean> | null = null;
  private masterVolume = 1;
  private muted = false;
  private leases = 0;
  retain() {
    this.leases++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.leases--;
      this.suspend();
      // React's development effect replay can reacquire this same memoized
      // scope before the microtask. Real unmounts still stop audio immediately.
      queueMicrotask(() => {
        if (!this.leases) this.close();
      });
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.state;
  onFlush(reset: () => void) {
    this.resets.add(reset);
    return () => this.resets.delete(reset);
  }
  flush() {
    for (const reset of this.resets) reset();
    for (const stop of [...this.sources.values()]) stop();
  }
  private publish(state: ViewerAudioState) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  unlock(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.pending) return this.pending;
    if (typeof AudioContext === 'undefined') {
      this.publish('unavailable');
      return Promise.resolve(false);
    }
    // Construction and resume happen synchronously inside the initiating user
    // gesture. Fetching/decoding is deliberately never part of this gate.
    if (!this.context) {
      try {
        this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        this.master = this.context.createGain();
        this.master.gain.value = this.muted ? 0 : this.masterVolume;
        this.master.connect(this.context.destination);
        this.context.onstatechange = () => {
          if (!this.closed) this.publish(this.context?.state === 'running' ? 'running' : 'locked');
        };
      } catch {
        void this.context?.close().catch(() => {});
        this.context = null;
        this.master = null;
        this.publish('unavailable');
        return Promise.resolve(false);
      }
    }
    const context = this.context;
    this.pending = context
      .resume()
      .then(() => {
        if (this.closed) return false;
        const running = context.state === 'running';
        this.publish(running ? 'running' : 'locked');
        return running;
      })
      .catch(() => {
        if (!this.closed) this.publish('locked');
        return false;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  setMaster(value: number, muted: boolean) {
    this.masterVolume = volume(value);
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.masterVolume;
  }
  channel(): GainNode | null {
    if (this.closed || !this.context || !this.master || this.channels.size >= 4) return null;
    const gain = this.context.createGain();
    gain.connect(this.master);
    this.channels.add(gain);
    return gain;
  }
  releaseChannel(gain: GainNode | null) {
    gain?.disconnect();
    if (gain) this.channels.delete(gain);
  }
  /** Returns a private stop lease, or rejects admission without retaining nodes. */
  track(source: AudioBufferSourceNode, ended: () => void): (() => void) | null {
    if (this.closed || this.state !== 'running' || this.sources.size >= 256) return null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      source.removeEventListener('ended', finish);
      this.sources.delete(source);
      source.disconnect();
      ended();
    };
    const stop = () => {
      try {
        source.stop();
      } catch {}
      finish();
    };
    source.addEventListener('ended', finish, { once: true });
    this.sources.set(source, stop);
    return stop;
  }
  setListener(pose: ListenerPose) {
    const context = this.context;
    if (!context || this.closed || context.state !== 'running') return;
    if (
      ![...pose.position, ...pose.forward, ...pose.up].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 1e7,
      )
    )
      return;
    const listener = context.listener;
    [listener.positionX, listener.positionY, listener.positionZ].forEach((value, index) => {
      value.value = pose.position[index];
    });
    [listener.forwardX, listener.forwardY, listener.forwardZ].forEach((value, index) => {
      value.value = pose.forward[index];
    });
    [listener.upX, listener.upY, listener.upZ].forEach((value, index) => {
      value.value = pose.up[index];
    });
  }
  suspend() {
    const resume = this.state === 'running';
    this.flush();
    this.publish('locked');
    void this.context?.suspend().catch(() => {});
    return resume;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    this.resets.clear();
    for (const channel of this.channels) channel.disconnect();
    this.channels.clear();
    this.master?.disconnect();
    if (this.context) {
      this.context.onstatechange = null;
      void this.context.close().catch(() => {});
    }
    this.context = null;
    this.master = null;
    this.publish('closed');
    this.listeners.clear();
  }
}
export function useViewerAudio(identity: string) {
  const audio = useMemo(() => new ViewerAudio(), [identity]);
  useEffect(() => {
    const release = audio.retain();
    let resume = false;
    const visibility = () => {
      if (document.hidden) resume = audio.suspend();
      else if (resume) {
        resume = false;
        void audio.unlock();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      release();
    };
  }, [audio]);
  return audio;
}
export function useViewerAudioState(audio: ViewerAudio) {
  return useSyncExternalStore(audio.subscribe, audio.snapshot, audio.snapshot);
}
