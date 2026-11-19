import { useEffect, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import type { CubeTexture, Texture } from 'three';
import { createMapSkyLighting } from './map-ibl';

/** A mounted renderer owns its filtered sky. A missing/unsupported optional
 * filter keeps ordinary lighting, without failing the map or backdrop. */
export function useMapSkyLighting(cube: CubeTexture | null, low: boolean): Texture | null {
  const { gl, invalidate } = useThree(),
    request = useMemo(() => ({ gl, cube, low }), [gl, cube, low]),
    [filtered, setFiltered] = useState<{
      request: typeof request;
      lease: { active: boolean; texture: Texture };
    }>();
  useEffect(() => {
    if (!cube) return;
    let resource: ReturnType<typeof createMapSkyLighting> | undefined;
    let lease: { active: boolean; texture: Texture } | undefined;
    try {
      resource = createMapSkyLighting(gl, cube, low);
      lease = { active: true, texture: resource.texture };
      setFiltered({ request, lease });
      invalidate();
    } catch {
      // The native map remains useful when an optional GPU capability fails.
      invalidate();
    }
    return () => {
      if (lease) lease.active = false;
      resource?.dispose();
    };
  }, [request, invalidate]);
  return filtered?.request === request && filtered.lease.active ? filtered.lease.texture : null;
}
