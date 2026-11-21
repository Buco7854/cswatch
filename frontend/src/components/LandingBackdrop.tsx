import { useEffect, useState } from 'react';
import type { MapPreview } from '../../../shared/map-assets';
import previewRegistry from '../../../shared/map-previews.json';
import { api } from '../api';

const maps = new Set<string>(previewRegistry.maps);
type AvailablePreview = Extract<MapPreview, { image: string }>;
function localPreview(value: unknown): AvailablePreview | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AvailablePreview>;
  return candidate.map &&
    maps.has(candidate.map) &&
    candidate.image === `/api/map-preview/${candidate.map}.png`
    ? { image: candidate.image, map: candidate.map }
    : null;
}

/** Discovery is read-only. A separate isolated worker may prepare artwork after entry opens. */
export default function LandingBackdrop({ enabled }: { enabled: boolean }) {
  const [preview, setPreview] = useState<AvailablePreview | null>(null);
  const [readyImage, setReadyImage] = useState('');
  useEffect(() => {
    if (!enabled) {
      setPreview(null);
      setReadyImage('');
      return;
    }
    const controller = new AbortController();
    const started = Date.now(),
      delays = [2000, 5000, 15000, 30000, 60000];
    let timer: ReturnType<typeof setTimeout> | undefined,
      attempts = 0,
      errors = 0;
    const schedule = () => {
      if (controller.signal.aborted || attempts >= 64 || Date.now() - started >= 45 * 60 * 1000)
        return;
      timer = setTimeout(() => void discover(), delays[Math.min(attempts - 1, delays.length - 1)]);
    };
    const discover = async () => {
      if (controller.signal.aborted || attempts >= 64 || Date.now() - started >= 45 * 60 * 1000)
        return;
      attempts++;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
        const value = await api<unknown>('/api/map-preview', { signal, cache: 'no-store' });
        if (controller.signal.aborted) return;
        const available = localPreview(value);
        setReadyImage('');
        setPreview(available);
        errors = 0;
        // Malformed/untrusted descriptors stay rejected. Only the explicit
        // empty catalog authorizes another bounded availability check.
        if (
          !available &&
          value &&
          typeof value === 'object' &&
          (value as MapPreview).image === null &&
          (value as MapPreview).map === null
        )
          schedule();
      } catch {
        if (!controller.signal.aborted && ++errors < 5) schedule();
      }
    };
    void discover();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled]);
  if (!enabled || !preview) return null;
  return (
    <div
      className="landing-backdrop"
      aria-hidden="true"
      data-map-preview={preview.map}
      data-ready={readyImage === preview.image}
    >
      <img
        key={preview.image}
        className="landing-backdrop-image"
        src={preview.image}
        alt=""
        decoding="async"
        draggable={false}
        onLoad={(event) => {
          const image = event.currentTarget;
          void image.decode().then(
            () => {
              if (image.isConnected) setReadyImage(preview.image);
            },
            () => {
              if (image.isConnected)
                setPreview((current) => (current?.image === preview.image ? null : current));
            },
          );
        }}
        onError={() => {
          setPreview((current) => (current?.image === preview.image ? null : current));
        }}
      />
    </div>
  );
}
