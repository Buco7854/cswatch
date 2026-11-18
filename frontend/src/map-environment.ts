import { useEffect, useMemo, useState } from 'react';
import { CubeTextureLoader, LoadingManager, SRGBColorSpace, type CubeTexture } from 'three';
import type { MapEnvironment } from '../../shared/map-assets';
import type { AssetStatus } from './map-assets';

export const daylightFallback = '#91a7b3';
export function mapEnvironmentKey(environment: MapEnvironment | null | undefined): string | null {
  return environment
    ? JSON.stringify([
        environment.assetVersion,
        environment.sky.brightness,
        ...environment.sky.faces,
        environment.fog || null,
      ])
    : null;
}
type EnvironmentResource = {
  identity: string | null;
  status: AssetStatus;
  texture: CubeTexture | null;
};

/** Each mounted 3D scene owns six fixed images, without mutating shared loader managers. */
export function useMapEnvironment(
  environment: MapEnvironment | null | undefined,
): EnvironmentResource {
  const identity = mapEnvironmentKey(environment);
  const request = useMemo(() => Symbol('map environment'), [identity]);
  const [resource, setResource] = useState<EnvironmentResource & { request: symbol }>();
  useEffect(() => {
    if (!identity || !environment) return;
    let active = true,
      settled = false,
      texture: CubeTexture | undefined;
    try {
      texture = new CubeTextureLoader(new LoadingManager()).load(
        environment.sky.faces,
        (loaded) => {
          if (!active || settled) {
            loaded.dispose();
            return;
          }
          if (
            loaded.images.length !== 6 ||
            loaded.images.some((image) => {
              const size = image as { width?: unknown; height?: unknown } | null;
              return (
                !size ||
                typeof size.width !== 'number' ||
                !Number.isFinite(size.width) ||
                size.width <= 0 ||
                typeof size.height !== 'number' ||
                !Number.isFinite(size.height) ||
                size.height <= 0
              );
            })
          ) {
            settled = true;
            loaded.dispose();
            setResource({ identity, request, status: 'error', texture: null });
            return;
          }
          settled = true;
          loaded.colorSpace = SRGBColorSpace;
          loaded.needsUpdate = true;
          setResource({ identity, request, status: 'ready', texture: loaded });
        },
        undefined,
        () => {
          if (!active || settled) return;
          settled = true;
          texture?.dispose();
          setResource({ identity, request, status: 'error', texture: null });
        },
      );
    } catch {
      settled = true;
      texture?.dispose();
      setResource({ identity, request, status: 'error', texture: null });
    }
    return () => {
      active = false;
      texture?.dispose();
    };
  }, [request]);
  if (!identity) return { identity: null, status: 'missing', texture: null };
  return resource?.request === request ? resource : { identity, status: 'pending', texture: null };
}
