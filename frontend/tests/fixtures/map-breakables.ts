import type { Page } from '@playwright/test';
import type { Object3D, Scene } from 'three';

/** Inspect tagged instances only in the installed production map clone. */
export async function installMapBreakableProbe(page: Page) {
  await page.addInitScript(() => {
    const host = window as unknown as {
      __THREE_DEVTOOLS__: EventTarget;
      qaMapBreakables: () => Record<string, boolean>;
    };
    const devtools = new EventTarget(),
      scenes = new Set<Scene>();
    host.__THREE_DEVTOOLS__ = devtools;
    devtools.addEventListener('observe', (event) => {
      const item = (event as CustomEvent<Scene>).detail;
      if (item.isScene) scenes.add(item);
    });
    host.qaMapBreakables = () => {
      const result: Record<string, boolean> = {};
      for (const scene of scenes)
        scene.traverse((node) => {
          const tag = node.userData.cswatchBreakable;
          if (!tag) return;
          for (let parent: Object3D | null = node.parent; parent; parent = parent.parent) {
            if ('immutableDescendants' in parent) {
              result[tag.hammerId] = node.visible;
              break;
            }
          }
        });
      return result;
    };
  });
}
export function renderedMapBreakables(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { qaMapBreakables: () => Record<string, boolean> }).qaMapBreakables(),
  );
}
