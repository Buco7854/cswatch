// Playwright init script. Observe Three's normal renderer without changing the application bundle.
(() => {
  const devtools = new EventTarget(),
    scenes = new Set();
  window.__THREE_DEVTOOLS__ = devtools;
  devtools.addEventListener('observe', ({ detail }) => {
    if (detail.isScene) scenes.add(detail);
  });
  // Count composites which actually submitted a screen pass. A bare rAF counter
  // also advances while a demand-rendered world is idle. Keep this hook in QA.
  window.measureViewerPlayback = async (button, seconds) => {
    const element = document.querySelector('.scene'),
      canvas = element?.querySelector('canvas');
    const slider = document.querySelector('.timeline-slider');
    for (const scene of scenes) {
      const state = scene.__r3f?.root.getState();
      if (!state || state.scene !== scene || state.previousRoot || state.gl.domElement !== canvas)
        continue;
      const renderer = state.gl,
        original = renderer.render;
      const times = [];
      let stamp;
      renderer.render = function (...args) {
        const result = original.apply(this, args);
        if (!this.getRenderTarget()) {
          // Several screen passes can contribute to one browser animation frame.
          const frame = document.timeline.currentTime;
          if (frame !== stamp) {
            stamp = frame;
            times.push(performance.now());
          } else times[times.length - 1] = performance.now();
        }
        return result;
      };
      const startTick = Number(slider.value),
        started = performance.now();
      try {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      } finally {
        renderer.render = original;
      }
      const elapsedMs = performance.now() - started,
        endTick = Number(slider.value);
      const intervals = times
        .slice(1)
        .map((end, i) => end - times[i])
        .sort((a, b) => a - b);
      const percentile = (p) =>
        intervals.length ? intervals[Math.ceil(p * intervals.length) - 1] : null;
      return {
        cameraMode: element.dataset.cameraMode,
        startTick,
        endTick,
        elapsedMs,
        submittedFrames: times.length,
        firstFrameMs: times.length ? times[0] - started : null,
        lastFrameMs: times.length ? times.at(-1) - started : null,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: intervals.at(-1) ?? null,
        measurement: 'wall-clock intervals between screen submissions during playback',
      };
    }
    throw Error('Production renderer unavailable for playback timing');
  };
  window.captureViewerCanvas = async () => {
    const element = document.querySelector('.scene');
    const canvas = element?.querySelector('canvas');
    // Read only the committed Scene props from the pinned production React tree.
    // Detached/alternate fibers may describe the previous player after a seek.
    let fiber = element?.[Object.keys(element ?? {}).find((k) => k.startsWith('__reactFiber$'))];
    let top = fiber;
    while (top?.return) top = top.return;
    if (top !== top?.stateNode?.current) fiber = fiber?.alternate;
    let sceneProps;
    for (let p = fiber; p; p = p.return) {
      const v = p.memoizedProps;
      if (
        v?.data?.frames &&
        v.mapAssets &&
        v.settings &&
        typeof v.selected === 'string' &&
        Number.isFinite(v.tick)
      ) {
        sceneProps = v;
        break;
      }
    }
    if (!sceneProps || sceneProps.playing || sceneProps.mode !== 'pov' || sceneProps.data.sample)
      throw Error('Recorded paused POV is unavailable');
    for (const scene of scenes) {
      const state = scene.__r3f?.root.getState();
      if (!state || state.scene !== scene || state.previousRoot || state.gl.domElement !== canvas)
        continue;
      const renderer = state.gl,
        render = renderer.render,
        gl = renderer.getContext();
      let camera,
        equipmentProjection = null,
        screenPass = null,
        nativePovModel = null;
      renderer.render = function (pass, lens) {
        const result = render.call(this, pass, lens);
        if (pass === scene && lens === state.camera) {
          camera = {
            eye: lens.position.toArray(),
            direction: lens.getWorldDirection(lens.position.clone()).toArray(),
            projectionMatrix: lens.projectionMatrix.toArray(),
            worldMatrix: lens.matrixWorld.toArray(),
            fov: lens.fov,
            aspect: lens.aspect,
            near: lens.near,
            far: lens.far,
          };
        } else if (lens.isPerspectiveCamera && lens.near === 0.025 && lens.far === 8) {
          equipmentProjection = lens.projectionMatrix.toArray();
          pass.traverseVisible((node) => {
            if (/^native-[a-z0-9]+-viewmodel$/.test(node.name)) nativePovModel = node.name;
          });
        }
        if (!this.getRenderTarget())
          screenPass = lens.isOrthographicCamera
            ? 'orthographic-output'
            : pass === scene
              ? 'world'
              : 'perspective-output';
        return result;
      };
      try {
        state.invalidate();
        // In the same animation frame as the final grade, before browser compositing clears a transient buffer.
        return await new Promise((resolve, reject) =>
          requestAnimationFrame(() => {
            try {
              if (!camera || !screenPass || gl.isContextLost())
                throw Error('Incomplete production render');
              const ext = gl.getExtension('WEBGL_debug_renderer_info');
              const sceneElement = canvas.closest('.scene');
              const status = {};
              for (const key of [
                'quality',
                'mapTier',
                'cameraMode',
                'renderResolution',
                'liveShadows',
                'environmentState',
                'skylightState',
                'landscapeState',
                'agentModelState',
                'agentReadyCount',
                'agentFallbackCount',
                'agentErrorCount',
                'equipmentModelState',
                'equipmentReadyCount',
                'equipmentUnavailableCount',
                'equipmentErrorCount',
                'smokeState',
              ])
                status[key] = sceneElement.dataset[key] ?? null;
              resolve({
                theme: document.documentElement.dataset.theme,
                camera,
                equipmentProjection,
                nativePovModel,
                status,
                screenPass,
                viewport: { width: innerWidth, height: innerHeight },
                buffer: [canvas.width, canvas.height],
                canvasSize: [canvas.clientWidth, canvas.clientHeight],
                committed: {
                  tick: sceneProps.tick,
                  player: sceneProps.selected,
                  map: sceneProps.data.map,
                  settings: sceneProps.settings,
                },
                colorSpace: renderer.outputColorSpace,
                toneMapping: renderer.toneMapping,
                exposure: renderer.toneMappingExposure,
                gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
              });
            } catch (err) {
              reject(err);
            }
          }),
        );
      } finally {
        renderer.render = render;
      }
    }
    throw Error('Production viewer canvas is unavailable');
  };
})();
