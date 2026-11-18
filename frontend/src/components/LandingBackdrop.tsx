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

/** Optional operator artwork. Entry remains usable before it loads or when absent. */
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
    void api<unknown>('/api/map-preview', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setReadyImage('');
          setPreview(localPreview(value));
        }
      })
      .catch(() => {});
    return () => controller.abort();
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
        fetchPriority="low"
        draggable={false}
        onLoad={() => setReadyImage(preview.image)}
        onError={() => {
          setPreview((current) => (current?.image === preview.image ? null : current));
        }}
      />
    </div>
  );
}
