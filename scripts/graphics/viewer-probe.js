// Playwright init script. Observe Three's normal renderer without changing the application bundle.
(() => {
  const devtools = new EventTarget(),
    scenes = new Set();
  window.__THREE_DEVTOOLS__ = devtools;
  devtools.addEventListener('observe', ({ detail }) => {
    if (detail.isScene) scenes.add(detail);
  });
  // Read the production scene's mounted asset state, including intentionally missing artwork.
  window.viewerPlaybackReadiness = () => {
    const d = document.querySelector('.scene')?.dataset;
    if (!d) return null;
    const keys = [
      'cameraMode',
      'mapTier',
      'mapModelState',
      'quality',
      'renderResolution',
      'liveShadows',
      'environmentState',
      'landscapeState',
      'skylightState',
      'agentModelState',
      'agentReadyCount',
      'agentPendingCount',
      'agentErrorCount',
      'agentFallbackCount',
      'equipmentModelState',
      'equipmentPendingCount',
      'equipmentReadyCount',
      'equipmentReadyInstances',
      'equipmentErrorCount',
      'equipmentUnavailableCount',
    ];
    const state = Object.fromEntries(keys.map((key) => [key, d[key] ?? null]));
    const assetStates = [
      'environmentState',
      'landscapeState',
      'agentModelState',
      'equipmentModelState',
    ];
    state.settled =
      d.mapModelState === 'ready' &&
      Boolean(d.mapTier) &&
      ['low', 'high'].includes(d.quality) &&
      assetStates.every((key) => ['ready', 'missing', 'error'].includes(d[key])) &&
      d.agentPendingCount === '0' &&
      d.equipmentPendingCount === '0';
    state.errors = [
      'environmentState',
      'landscapeState',
      'skylightState',
      'agentModelState',
      'equipmentModelState',
    ].filter((key) => d[key] === 'error');
    for (const key of ['agentErrorCount', 'equipmentErrorCount']) {
      if (d[key] !== '0') state.errors.push(key);
    }
    return state;
  };

  // Several render passes may submit to the screen in one browser animation frame.
  window.measureViewerPlayback = async (
    button,
    { seconds, mode, maxP95Ms, minDisplayScale = null, minIntervals },
  ) => {
    const element = document.querySelector('.scene'),
      canvas = element?.querySelector('canvas');
    const slider = document.querySelector('.timeline-slider');
    for (const scene of scenes) {
      const state = scene.__r3f?.root.getState();
      if (!state || state.scene !== scene || state.previousRoot || state.gl.domElement !== canvas)
        continue;
      const renderer = state.gl,
        original = renderer.render;
      const times = [],
        rotate = mode === 'orbit';
      const initialOrientation = state.camera.quaternion.clone();
      let cameraTurned = false,
        stamp,
        animation;
      const entry = window.viewerPlaybackReadiness();
      const errors = new Set(entry?.errors);
      const resolutions = new Set([entry?.renderResolution]);
      let sameRoute = true;
      const observe = () => {
        const state = window.viewerPlaybackReadiness();
        sameRoute &&=
          document.querySelector('.scene') === element &&
          state?.cameraMode === mode &&
          state.mapTier === entry?.mapTier;
        resolutions.add(state?.renderResolution);
        if (state?.mapModelState !== 'ready') errors.add('mapModelState');
        for (const key of state?.errors ?? []) errors.add(key);
      };
      const observer = new MutationObserver(observe);
      observer.observe(element, {
        attributes: true,
        attributeFilter: [
          'data-camera-mode',
          'data-map-tier',
          'data-map-model-state',
          'data-render-resolution',
          'data-environment-state',
          'data-landscape-state',
          'data-skylight-state',
          'data-agent-model-state',
          'data-agent-error-count',
          'data-equipment-model-state',
          'data-equipment-error-count',
        ],
      });
      const bounds = canvas.getBoundingClientRect();
      const displayWidth = Math.round(bounds.width * window.devicePixelRatio);
      const displayHeight = Math.round(bounds.height * window.devicePixelRatio);
      // The WebGL canvas truncates fractional physical pixels, whereas the screenshot rounds.
      const minWidth = Math.floor(bounds.width * window.devicePixelRatio * (minDisplayScale ?? 0));
      const minHeight = Math.floor(
        bounds.height * window.devicePixelRatio * (minDisplayScale ?? 0),
      );
      let lowestWorldScale = Infinity,
        lowestScreenScale = Infinity,
        belowMinScale = false;
      const displayScale = (width, height) => {
        if (width < minWidth || height < minHeight) belowMinScale = true;
        return Math.min(width / displayWidth, height / displayHeight);
      };
      renderer.render = function (pass, lens) {
        const target = this.getRenderTarget();
        const result = original.call(this, pass, lens);
        if (pass === scene && lens === state.camera) {
          const output = target ?? canvas;
          lowestWorldScale = Math.min(lowestWorldScale, displayScale(output.width, output.height));
        }
        if (!target) {
          lowestScreenScale = Math.min(
            lowestScreenScale,
            displayScale(canvas.width, canvas.height),
          );
          if (rotate && !cameraTurned)
            cameraTurned = initialOrientation.angleTo(state.camera.quaternion) > 0.01;
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
      const drag = (type, x) =>
        canvas.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: 'mouse',
            pointerId: 73,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: x,
            clientY: 120,
          }),
        );
      let ended, endTick, exit;
      try {
        button.click();
        if (rotate) {
          drag('pointerdown', 180);
          const turn = (time) => {
            const progress = Math.min(1, Math.max(0, (time - started) / (seconds * 1000)));
            drag('pointermove', 180 + 120 * Math.sin(progress * 2 * Math.PI));
            animation = requestAnimationFrame(turn);
          };
          animation = requestAnimationFrame(turn);
        }
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        ended = performance.now();
        endTick = Number(slider.value);
        exit = window.viewerPlaybackReadiness();
        observe();
      } finally {
        renderer.render = original;
        observer.disconnect();
        if (rotate) {
          cancelAnimationFrame(animation);
          drag('pointerup', 180);
        }
      }
      const elapsedMs = ended - started;
      const gaps = times
        .slice(1)
        .map((end, i) => end - times[i])
        .sort((a, b) => a - b);
      const percentile = (p) => (gaps.length ? gaps[Math.ceil(p * gaps.length) - 1] : null);
      const first = times.length ? times[0] - started : null;
      const terminal = times.length ? ended - times.at(-1) : elapsedMs;
      const windowGaps = (times.length ? [...gaps, first, terminal] : [elapsedMs]).sort(
        (a, b) => a - b,
      );
      // A gap spanning 90% of the window must carry 90% of the weight, even if
      // a burst of short intervals would hide it in the frame-count percentile.
      let covered = 0,
        timeWeightedP95Ms = windowGaps.at(-1);
      for (const gap of windowGaps) {
        covered += gap;
        if (covered >= 0.95 * elapsedMs) {
          timeWeightedP95Ms = gap;
          break;
        }
      }
      const moved =
        endTick > startTick &&
        times.length >= 2 &&
        sameRoute &&
        entry?.cameraMode === mode &&
        exit?.cameraMode === mode &&
        (!rotate || cameraTurned);
      const assetsVerified = Boolean(
        entry?.settled && exit?.settled && !errors.size && !exit.errors.length,
      );
      const p95Ms = percentile(0.95);
      const lowestScale =
        Number.isFinite(lowestScreenScale) && Number.isFinite(lowestWorldScale)
          ? Math.min(lowestScreenScale, lowestWorldScale)
          : null;
      let budgetVerdict = 'not-evaluated';
      if (maxP95Ms !== null || minDisplayScale !== null) {
        if (
          (minDisplayScale !== null && lowestScale === null) ||
          !moved ||
          !assetsVerified ||
          gaps.length < minIntervals
        )
          budgetVerdict = 'unverified';
        else if (
          (maxP95Ms !== null && (p95Ms > maxP95Ms || timeWeightedP95Ms > maxP95Ms)) ||
          belowMinScale
        )
          budgetVerdict = 'fail';
        else budgetVerdict = 'pass';
      }
      return {
        cameraMode: exit?.cameraMode,
        cameraTurned: rotate ? cameraTurned : null,
        startTick,
        endTick,
        elapsedMs,
        submittedFrames: times.length,
        firstFrameMs: first,
        lastFrameMs: times.length ? times.at(-1) - started : null,
        terminalGapMs: terminal,
        p50Ms: percentile(0.5),
        p95Ms,
        maxMs: gaps.at(-1) ?? null,
        timeWeightedP95Ms,
        windowMaxMs: windowGaps.at(-1),
        gapsOver100Ms: gaps.filter((ms) => ms > 100).length,
        gapsOver250Ms: gaps.filter((ms) => ms > 250).length,
        status: moved ? 'measured' : 'insufficient-data',
        assetsVerified,
        entry,
        exit,
        assetErrors: [...errors],
        renderResolutions: [...resolutions],
        displayPixels: [displayWidth, displayHeight],
        lowestDisplayScale: lowestScale,
        lowestWorldScale: Number.isFinite(lowestWorldScale) ? lowestWorldScale : null,
        lowestPresentationScale: Number.isFinite(lowestScreenScale) ? lowestScreenScale : null,
        minDisplayScale,
        requestedSeconds: seconds,
        minIntervals,
        maxP95Ms,
        budgetVerdict,
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
    // Read the installed map clone, including invisible descendants. This is an
    // offline capture of scene visibility; it makes no frustum or pixel claim.
    function observedMapGeometry(scene) {
      const text = (value, max) =>
        typeof value === 'string' && value.length <= max ? value : null;
      const triple = (value) =>
        Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : null;
      const nodes = [],
        doors = [];
      let breakableLimit = false,
        doorLimit = false;
      const unavailable = (reason) => ({
        observedBreakables: { reason },
        observedDoors: { reason },
      });
      const stack = [{ node: scene, inMap: null, shown: true }];
      let groups = 0,
        visited = 0;
      while (stack.length) {
        const { node, inMap, shown } = stack.pop();
        if (++visited + stack.length + node.children.length > 65536)
          return unavailable('node-limit');
        const group =
          typeof node.immutableDescendants === 'boolean' &&
          typeof node.canTrackRigCasters === 'boolean';
        if (group && ++groups > 1) return unavailable('multiple-map-groups');
        const inside = group ? node : inMap;
        const visible = shown && node.visible;
        const tag = inside && node.userData.cswatchBreakable;
        if (tag && nodes.length >= 512) breakableLimit = true;
        else if (tag) {
          nodes.push({
            className: text(tag.className, 64),
            hammerId: text(tag.hammerId, 128),
            model: text(tag.model, 256),
            modelId: text(tag.modelId, 20),
            origin: triple(tag.origin),
            angles: triple(tag.angles),
            visible,
          });
        }
        const door = inside && node.userData.cswatchDoor;
        if (door && doors.length >= 256) doorLimit = true;
        else if (door) {
          // The cloned node's TRS is its authored pose. Door motion is written
          // to its matrix. Compare in the static map's coordinate system so
          // this also works for baked Compact vertices and nested transforms.
          const parentToMap = inside.matrixWorld.clone().invert().multiply(node.parent.matrixWorld);
          const rest = parentToMap
            .clone()
            .multiply(node.matrix.clone().compose(node.position, node.quaternion, node.scale));
          const delta =
            Math.abs(rest.determinant()) > 1e-12
              ? parentToMap.multiply(node.matrix).multiply(rest.invert()).elements
              : null;
          let yaw = null;
          const origin = triple(door.origin);
          if (origin && delta && delta.every(Number.isFinite)) {
            const [x, y, z] = [origin[1], origin[2], origin[0]].map((v) => v * 0.0254);
            // A matching angle applied around another point visibly displaces the door.
            const pivotError = Math.hypot(
              delta[0] * x + delta[4] * y + delta[8] * z + delta[12] - x,
              delta[1] * x + delta[5] * y + delta[9] * z + delta[13] - y,
              delta[2] * x + delta[6] * y + delta[10] * z + delta[14] - z,
            );
            const a = Math.atan2(delta[8], delta[0]),
              c = Math.cos(a),
              s = Math.sin(a);
            if (
              pivotError < 0.0003 &&
              [
                [0, c],
                [1, 0],
                [2, -s],
                [4, 0],
                [5, 1],
                [6, 0],
                [8, s],
                [9, 0],
                [10, c],
              ].every(([i, v]) => Math.abs(delta[i] - v) < 0.0001)
            )
              yaw = (a * 180) / Math.PI;
          }
          let stages = [];
          for (const child of node.children) {
            const stage = child.userData.cswatchDoorStage;
            if (!stage) continue;
            if (stages.length >= 5) {
              stages = null;
              break;
            }
            stages.push({
              stage: stage.stage,
              modelId: text(stage.modelId, 20),
              visible: Boolean(
                visible &&
                child.visible &&
                child.scale.toArray().every((v) => Number.isFinite(v) && v !== 0),
              ),
            });
          }
          doors.push({
            className: text(door.className, 64),
            hammerId: text(door.hammerId, 128),
            model: text(door.model, 256),
            modelId: text(door.modelId, 20),
            origin: triple(door.origin),
            angles: triple(door.angles),
            visible,
            yaw,
            stages,
          });
        }
        for (const child of node.children)
          stack.push({ node: child, inMap: inside, shown: visible });
      }
      if (groups !== 1) return unavailable('map-group-unavailable');
      return {
        observedBreakables: breakableLimit ? { reason: 'tag-limit' } : { nodes },
        observedDoors: doorLimit ? { reason: 'tag-limit' } : { nodes: doors },
      };
    }
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
                'agentPendingCount',
                'agentFallbackCount',
                'agentErrorCount',
                'equipmentModelState',
                'equipmentReadyCount',
                'equipmentPendingCount',
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
                ...observedMapGeometry(scene),
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
