// Playwright init script. Observe Three's normal renderer without changing the application bundle.
(() => {
  const devtools = new EventTarget(),
    scenes = new Set();
  window.__THREE_DEVTOOLS__ = devtools;
  devtools.addEventListener('observe', ({ detail }) => {
    if (detail.isScene) scenes.add(detail);
  });
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
