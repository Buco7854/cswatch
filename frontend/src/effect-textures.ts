import { useEffect, useState } from 'react';
import { LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three';
import type { EffectTextureCatalog, EffectTextureSheet } from '../../shared/effect-textures';

export type EffectTexture = { texture: Texture; sheet: EffectTextureSheet };
export type EffectTextures = Readonly<Record<string, EffectTexture>>;

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Load the prepared official particle atlases once per viewer. Each payload must
 * match its catalog hash. Missing or failed atlases leave the analytic effects. */
export function useEffectTextures(enabled: boolean, wanted: readonly string[]) {
  const [textures, setTextures] = useState<EffectTextures>({});
  const key = wanted.join(',');
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const loaded: Texture[] = [];
    let active = true;
    (async () => {
      const response = await fetch('/api/effect-assets', {
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!response.ok) return;
      const catalog = (await response.json()) as EffectTextureCatalog;
      if (catalog?.schemaVersion !== 1 || typeof catalog.items !== 'object') return;
      const result: Record<string, EffectTexture> = {};
      for (const id of key.split(',')) {
        const item = catalog.items[id];
        if (!item || item.url !== `/api/effect-assets/${id}.png`) continue;
        // The service serves two atlases at a time; a busy reply names when to retry.
        let payload = await fetch(item.url, {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        for (let attempt = 0; payload.status === 429 && attempt < 5; attempt++) {
          const wait = Math.min(5, Math.max(1, Number(payload.headers.get('retry-after')) || 2));
          await new Promise((done) => setTimeout(done, wait * 1000));
          if (!active) return;
          payload = await fetch(item.url, {
            credentials: 'same-origin',
            signal: controller.signal,
          });
        }
        if (!payload.ok) continue;
        const bytes = await payload.arrayBuffer();
        if (bytes.byteLength !== item.bytes || !crypto?.subtle) continue;
        if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== item.sha256) continue;
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none',
        });
        if (image.width !== item.width || image.height !== item.height) {
          image.close();
          continue;
        }
        const texture = new Texture(image);
        texture.colorSpace = SRGBColorSpace;
        texture.minFilter = LinearMipmapLinearFilter;
        texture.flipY = false;
        texture.needsUpdate = true;
        loaded.push(texture);
        result[id] = { texture, sheet: item };
      }
      if (active) setTextures(result);
    })().catch(() => {});
    return () => {
      active = false;
      controller.abort();
      for (const texture of loaded) {
        (texture.image as ImageBitmap | undefined)?.close?.();
        texture.dispose();
      }
      setTextures({});
    };
  }, [enabled, key]);
  return textures;
}
