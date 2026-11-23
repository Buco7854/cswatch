import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('shared scene lighting leaves verified maps without a sun ambient-lit and keeps unverified map fill', async ({
  page,
}, info) => {
  const root = fileURLToPath(new URL('../../', import.meta.url)),
    bundle = await build({
      stdin: {
        contents: `
          export { createElement, StrictMode } from 'react';
          export { createRoot } from 'react-dom/client';
          export { Canvas, createPortal, useFrame } from '@react-three/fiber';
          export { default as SceneLighting } from './src/components/SceneLighting';
          export { prepareMapModel } from './src/map-model';
          export { mapSun } from './src/map-sun';
        `,
        resolveDir: root + 'frontend',
      },
      bundle: true,
      write: false,
      format: 'esm',
      external: ['three'],
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  await page.route('**/__qa_scene_lighting__/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'lighting.js')
      return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    if (name === 'three.module.js' || name === 'three.core.js')
      return route.fulfill({
        contentType: 'text/javascript',
        body: await readFile(root + 'frontend/node_modules/three/build/' + name),
      });
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><script type="importmap">{"imports":{"three":"./three.module.js"}}</script></head><body style="margin:0"></body></html>',
    });
  });
  await page.goto('/__qa_scene_lighting__/index.html');
  const report = await page.evaluate(async () => {
    const T = await import(
        /* @vite-ignore */ location.origin + '/__qa_scene_lighting__/three.module.js'
      ),
      Q = await import(/* @vite-ignore */ location.origin + '/__qa_scene_lighting__/lighting.js'),
      el = Q.createElement,
      host = document.createElement('div'),
      sky = new T.Scene(),
      pov = new T.Scene(),
      bounds = new T.Box3(new T.Vector3(-2, -1, -2), new T.Vector3(2, 2, 2));
    host.style.width = '256px';
    host.style.height = '192px';
    document.body.append(host);
    sky.background = new T.Color('#151719');
    pov.background = new T.Color('#151719');
    const root = Q.createRoot(host);
    let pending:
        | { id: number; resolve: (value: { pixels: Uint8Array[]; rigs: unknown[] }) => void }
        | undefined,
      frames = 0;
    // Entirely original analytical authoring, passed through the same map
    // preparation and sunlight fitting as native maps. No game artwork.
    const authored = (direction: number[], color: number[]) => {
      const source = new T.Group(),
        nativeSun = new T.DirectionalLight(),
        local = new T.Vector3(...direction)
          .normalize()
          .applyAxisAngle(new T.Vector3(0, 1, 0), -Math.PI / 2);
      nativeSun.userData.name = 'light_environment';
      nativeSun.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), local);
      nativeSun.color.setRGB(...color);
      nativeSun.intensity = 90_000;
      source.add(nativeSun);
      return Q.mapSun(Q.prepareMapModel(source).sun, bounds);
    };
    const first = authored([-0.8, 0.4, 0.4], [0.9, 0.4, 0.2]),
      directionChange = authored([0.8, 0.4, 0.4], [0.9, 0.4, 0.2]),
      colorChange = authored([0.8, 0.4, 0.4], [0.2, 0.45, 0.95]),
      phases = [
        { sun: null, skylight: false },
        { sun: first, skylight: false },
        { sun: directionChange, skylight: false },
        { sun: colorChange, skylight: false },
        { sun: null, skylight: false },
        { sun: first, skylight: true },
        { sun: first, skylight: false },
        { sun: null, skylight: false, fallbackSun: true },
      ];
    const sphere = () =>
      el(
        'mesh',
        null,
        el('sphereGeometry', { args: [0.9, 32, 24] }),
        el('meshStandardMaterial', { color: '#b9b9b9', metalness: 0.05, roughness: 0.5 }),
      );
    function Probe({ id }: { id: number }) {
      Q.useFrame((state: any) => {
        if (!pending || pending.id !== id) return;
        const { gl, scene, camera } = state,
          context = gl.getContext();
        // Observe the actual drawing buffer and projection after ResizeObserver,
        // then read pixels only after the corresponding committed scene render.
        if (
          context.drawingBufferWidth !== 256 ||
          context.drawingBufferHeight !== 192 ||
          Math.abs(camera.aspect - 256 / 192) > 1e-10
        ) {
          state.invalidate();
          return;
        }
        frames++;
        const pixels: Uint8Array[] = [],
          rigs: unknown[] = [];
        for (const pass of [scene, sky, pov]) {
          gl.render(pass, camera);
          const data = new Uint8Array(256 * 192 * 4);
          context.readPixels(0, 0, 256, 192, context.RGBA, context.UNSIGNED_BYTE, data);
          pixels.push(data);
          const lights: any[] = [];
          pass.traverse((node: any) => {
            if (node.isLight && node.visible) lights.push(node);
          });
          const sun = lights.find((node) => node.isDirectionalLight),
            ambient = lights.find((node) => node.isAmbientLight),
            hemisphere = lights.find((node) => node.isHemisphereLight),
            direction = sun
              .getWorldPosition(new T.Vector3())
              .sub(sun.target.getWorldPosition(new T.Vector3()))
              .normalize(),
            shadow = phases[id].sun?.shadow || {
              left: -45,
              right: 45,
              bottom: -45,
              top: 45,
              near: 0.5,
              far: 500,
            },
            projection = new T.OrthographicCamera(
              shadow.left,
              shadow.right,
              shadow.top,
              shadow.bottom,
              shadow.near,
              shadow.far,
            ).projectionMatrix.elements;
          rigs.push({
            lights: lights.length,
            directional: lights.filter((node) => node.isDirectionalLight).length,
            color: sun.color.toArray(),
            direction: direction.toArray(),
            intensity: sun.intensity,
            ambient: ambient.intensity,
            hemisphere: hemisphere.intensity,
            shadows: sun.castShadow,
            shadowProjectionError: Math.max(
              ...sun.shadow.camera.projectionMatrix.elements.map((value: number, index: number) =>
                Math.abs(value - projection[index]),
              ),
            ),
          });
        }
        const completed = pending;
        pending = undefined;
        completed.resolve({ pixels, rigs });
      }, 1);
      return null;
    }
    const captures = [];
    for (const [id, phase] of phases.entries()) {
      const capture = new Promise<{ pixels: Uint8Array[]; rigs: unknown[] }>((resolve) => {
        pending = { id, resolve };
      });
      root.render(
        el(
          Q.StrictMode,
          null,
          el(
            Q.Canvas,
            {
              frameloop: 'demand',
              dpr: 1,
              shadows: true,
              camera: { position: [0, 0, 4], fov: 45, near: 0.1, far: 20 },
              gl: { antialias: false, preserveDrawingBuffer: true },
            },
            el('color', { attach: 'background', args: ['#151719'] }),
            el(Q.SceneLighting, { ...phase, sample: false, shadows: true }),
            sphere(),
            Q.createPortal(
              el(Q.StrictMode, null, el(Q.SceneLighting, { ...phase, sample: false }), sphere()),
              sky,
            ),
            Q.createPortal(
              el(Q.StrictMode, null, el(Q.SceneLighting, { ...phase, sample: false }), sphere()),
              pov,
            ),
            el(Probe, { id }),
          ),
        ),
      );
      captures.push(await capture);
    }
    const changed = (a: Uint8Array, b: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < a.length; i += 4)
        if (Math.max(...[0, 1, 2].map((channel) => Math.abs(a[i + channel] - b[i + channel]))) > 3)
          count++;
      return count;
    };
    const result = {
      rigs: captures.map((capture) => capture.rigs),
      expected: phases.map((phase) => ({
        color: phase.sun?.color || [1, 1, 1],
        direction: phase.sun
          ? new T.Vector3(...phase.sun.position)
              .sub(new T.Vector3(...phase.sun.target))
              .normalize()
              .toArray()
          : new T.Vector3(-25, 40, 12).normalize().toArray(),
        ambient: phase.skylight ? 0.08 : 0.35,
        hemisphere: phase.skylight ? 0.12 : 0.6,
        directional: phase.sun || phase.fallbackSun ? 1.8 : 0,
      })),
      authoredPixels: changed(captures[0].pixels[0], captures[1].pixels[0]),
      directionPixels: changed(captures[1].pixels[0], captures[2].pixels[0]),
      colorPixels: changed(captures[2].pixels[0], captures[3].pixels[0]),
      fallbackResetPixels: changed(captures[0].pixels[0], captures[4].pixels[0]),
      fillPixels: changed(captures[1].pixels[0], captures[5].pixels[0]),
      fillResetPixels: changed(captures[1].pixels[0], captures[6].pixels[0]),
      unverifiedPixels: changed(captures[0].pixels[0], captures[7].pixels[0]),
      passDifferences: captures.map((capture) => [
        changed(capture.pixels[0], capture.pixels[1]),
        changed(capture.pixels[0], capture.pixels[2]),
      ]),
      frames,
    };
    root.unmount();
    return result;
  });
  await info.attach('original-scene-sunlight-evidence', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report.authoredPixels).toBeGreaterThan(1000);
  expect(report.directionPixels).toBeGreaterThan(1000);
  expect(report.colorPixels).toBeGreaterThan(1000);
  expect(report.fallbackResetPixels).toBe(0);
  expect(report.fillPixels).toBeGreaterThan(1000);
  expect(report.fillResetPixels).toBe(0);
  expect(report.unverifiedPixels).toBeGreaterThan(1000);
  for (const differences of report.passDifferences) expect(differences).toEqual([0, 0]);
  for (const [index, rigs] of report.rigs.entries())
    for (const [pass, rig] of (rigs as any[]).entries()) {
      expect(rig.lights).toBe(3);
      expect(rig.directional).toBe(1);
      expect(rig.intensity).toBe(report.expected[index].directional);
      expect(rig.shadows).toBe(pass === 0 && report.expected[index].directional > 0);
      expect(rig.ambient).toBe(report.expected[index].ambient);
      expect(rig.hemisphere).toBe(report.expected[index].hemisphere);
      expect(rig.shadowProjectionError).toBeLessThan(1e-10);
      for (let axis = 0; axis < 3; axis++) {
        expect(rig.color[axis]).toBeCloseTo(report.expected[index].color[axis], 10);
        expect(rig.direction[axis]).toBeCloseTo(report.expected[index].direction[axis], 10);
      }
    }
});
