import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const probe = await readFile(new URL('./viewer-probe.js', import.meta.url), 'utf8');
const cadence = (count, first = 20) => Array.from({ length: count }, (_, i) => first + 20 * i);

// Drive the shipped observer through its Three scene, pointer, DOM and render interfaces.
async function measure({
  frames,
  mode = 'pov',
  allowTurn = true,
  onFrame,
  minDisplayScale = null,
  cssWidth = 400,
  cssHeight = 300,
  deviceScale = 2,
  worldBuffer = null,
}) {
  let now = 0,
    animation,
    observe;
  const slider = { value: '100' };
  const dataset = {
    mapModelState: 'ready',
    mapTier: 'compact',
    quality: 'low',
    cameraMode: mode,
    renderResolution: '100',
    environmentState: 'missing',
    landscapeState: 'missing',
    skylightState: 'missing',
    agentModelState: 'missing',
    agentErrorCount: '0',
    agentPendingCount: '0',
    equipmentModelState: 'ready',
    equipmentErrorCount: '0',
    equipmentPendingCount: '0',
  };
  const quaternion = {
    yaw: 0,
    clone() {
      const initial = this.yaw;
      return { angleTo: (current) => Math.abs(initial - current.yaw) };
    },
  };
  const canvas = {
    width: Math.floor(cssWidth * deviceScale),
    height: Math.floor(cssHeight * deviceScale),
    getBoundingClientRect: () => ({ width: cssWidth, height: cssHeight }),
    dispatchEvent(event) {
      if (allowTurn && event.type === 'pointermove') quaternion.yaw = (event.clientX - 180) / 180;
    },
  };
  const element = { dataset, querySelector: () => canvas };
  const document = {
    timeline: {
      get currentTime() {
        return now;
      },
    },
    querySelector: (selector) => (selector === '.scene' ? element : slider),
  };
  const scene = { isScene: true };
  let target = null;
  const gl = { domElement: canvas, render() {}, getRenderTarget: () => target };
  const state = { scene, gl, camera: { quaternion } };
  scene.__r3f = { root: { getState: () => state } };
  const window = { devicePixelRatio: deviceScale };
  runInNewContext(probe, {
    window,
    document,
    EventTarget,
    performance: { now: () => now },
    PointerEvent: class {
      constructor(type, event) {
        this.type = type;
        Object.assign(this, event);
      }
    },
    MutationObserver: class {
      constructor(callback) {
        observe = callback;
      }
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(callback) {
      animation = callback;
      return 1;
    },
    cancelAnimationFrame() {
      animation = undefined;
    },
    setTimeout(done, duration) {
      for (const [index, time] of frames.entries()) {
        now = time;
        animation?.(now);
        slider.value = String(100 + Math.floor(now * 0.064));
        onFrame?.(index, dataset, canvas);
        observe();
        target = worldBuffer;
        gl.render(scene, state.camera);
        target = null;
        gl.render(); // Two passes in one animation frame still count as one submission.
      }
      now = duration;
      done();
    },
  });
  const event = new Event('observe');
  event.detail = scene;
  window.__THREE_DEVTOOLS__.dispatchEvent(event);
  return window.measureViewerPlayback(
    { click() {} },
    { seconds: 3, mode, maxP95Ms: 33.3, minDisplayScale, minIntervals: 20 },
  );
}

test('the full-window gate catches a frozen tail or a delayed first submission', async () => {
  for (const first of [20, 2580]) {
    const result = await measure({ frames: cadence(21, first) });
    assert.equal(result.submittedFrames, 21);
    assert.equal(result.p95Ms, 20);
    assert.equal(result.firstFrameMs, first);
    assert.equal(result.terminalGapMs, 3000 - first - 400);
    assert.equal(result.timeWeightedP95Ms, 2580);
    assert.equal(result.budgetVerdict, 'fail');
  }
});

test('Free measures visible camera movement and refuses a stationary free camera', async () => {
  for (const allowTurn of [true, false]) {
    const result = await measure({ frames: cadence(150), mode: 'orbit', allowTurn });
    assert.equal(result.submittedFrames, 150);
    assert.equal(result.assetsVerified, true);
    assert.equal(result.cameraTurned, allowTurn);
    assert.equal(result.timeWeightedP95Ms, 20);
    assert.equal(result.budgetVerdict, allowTurn ? 'pass' : 'unverified');
  }
});

test('errors during playback, pending exit models and a route change invalidate a budget', async () => {
  for (const [field, changed, restore] of [
    ['equipmentErrorCount', '1', '0'],
    ['agentPendingCount', '1', null],
    ['cameraMode', 'follow', 'pov'],
  ]) {
    const result = await measure({
      frames: cadence(150),
      onFrame(i, dataset) {
        if (i === 10) dataset[field] = changed;
        if (i === 20 && restore !== null) dataset[field] = restore;
      },
    });
    assert.equal(result.budgetVerdict, 'unverified', field);
    if (field === 'equipmentErrorCount') assert.ok(result.assetErrors.includes(field));
  }
  assert.equal((await measure({ frames: cadence(20) })).budgetVerdict, 'unverified');
});

test('a fast replay that drops below the requested display resolution fails the combined budget', async () => {
  const result = await measure({
    frames: cadence(150),
    minDisplayScale: 0.75,
    onFrame(i, _, canvas) {
      canvas.width = i === 40 ? 400 : 800;
    },
  });
  assert.equal(result.p95Ms, 20);
  assert.equal(result.lowestDisplayScale, 0.5);
  assert.equal(result.budgetVerdict, 'fail');
});

test('a full-resolution fractional DPR buffer meets a native display gate after integer rounding', async () => {
  const result = await measure({
    frames: cadence(150),
    minDisplayScale: 1,
    cssWidth: 391,
    cssHeight: 361,
    deviceScale: 1.5,
  });
  assert.ok(result.lowestDisplayScale < 1);
  assert.equal(result.budgetVerdict, 'pass');
});

test('the final fullscreen color pass cannot conceal a low-resolution world render target', async () => {
  const result = await measure({
    frames: cadence(150),
    minDisplayScale: 0.8,
    worldBuffer: { width: 400, height: 300 },
  });
  assert.equal(result.lowestWorldScale, 0.5);
  assert.equal(result.lowestPresentationScale, 1);
  assert.equal(result.budgetVerdict, 'fail');
});
