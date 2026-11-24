import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const probe = await readFile(new URL('./viewer-probe.js', import.meta.url), 'utf8');
const cadence = (count, first = 20) => Array.from({ length: count }, (_, i) => first + 20 * i);

// Drive the shipped observer through its Three scene, pointer, DOM and render interfaces.
async function measure({ frames, mode = 'pov', allowTurn = true, onFrame }) {
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
  const gl = { domElement: canvas, render() {}, getRenderTarget: () => null };
  const state = { scene, gl, camera: { quaternion } };
  scene.__r3f = { root: { getState: () => state } };
  const window = {};
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
        onFrame?.(index, dataset);
        observe();
        gl.render();
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
    { seconds: 3, mode, maxP95Ms: 33.3, minIntervals: 20 },
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
