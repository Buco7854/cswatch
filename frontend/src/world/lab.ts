import './lab.css';
import { loadManifest } from './format';
import { capabilities } from './textures';
import { createRenderer, type Pose } from './renderer';

const canvas = document.querySelector('canvas')!,
  stats = document.querySelector('output')!,
  select = document.querySelector('select')!;
const params = new URLSearchParams(location.search);
const french = (params.get('lang') ?? navigator.language).startsWith('fr');
const labels = french
  ? [
      'Éclairage final',
      'Albédo',
      'Normales',
      'Éclairage précalculé',
      'Réflexions',
      'Sans éclairage',
      'Sans post-traitement',
    ]
  : ['Final lighting', 'Albedo', 'Normals', 'Lightmap only', 'Cubemap only', 'Unlit', 'No post'];
labels.forEach((name, i) => select.add(new Option(name, String(i))));
if (french) {
  document.documentElement.lang = 'fr';
  select.ariaLabel = 'Mode de rendu';
  canvas.ariaLabel = 'Caméra libre Mirage';
  document.querySelector('aside')!.textContent =
    'ZQSD ou WASD · Glisser pour regarder · E pour monter';
  stats.textContent = 'Chargement…';
}
select.add(new Option(french ? 'Identifiant matériau' : 'Material ID', '7'));
if (params.get('view') === 'material-id') select.value = '7';
const parse = (text: string | null, fallback: number[]) => {
  const v = text?.split(',').map(Number);
  return v?.length === fallback.length && v.every(Number.isFinite) ? v : fallback;
};
const angle = Number(params.get('fov') ?? 73.74);
const pose: Pose = {
  pos: parse(params.get('pos'), [-820, -2300, -113]),
  ang: parse(params.get('ang'), [-1, 44]),
  fov: Math.max(15, Math.min(140, Number.isFinite(angle) ? angle : 73.74)),
};
async function start() {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw Error('WebGL2 unavailable');
  capabilities(gl);
  const url = params.get('map');
  if (!url) throw Error('Supply a map directory with ?map=');
  const dir = new URL(url.replace(/\/?$/, '/'), location.href),
    map = await loadManifest(dir);
  const render = await createRenderer(gl, dir, map);
  let raf = 0,
    last = performance.now(),
    tick = 0;
  const keys = new Set<string>();
  function frame(time: number) {
    raf = 0;
    const dt = Math.min(0.05, (time - last) / 1000);
    last = time;
    const yaw = (pose.ang[1] * Math.PI) / 180,
      forward = Number(keys.has('KeyW') || keys.has('KeyZ')) - Number(keys.has('KeyS')),
      right = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    const speed = dt * (keys.has('ShiftLeft') ? 1150 : 340);
    pose.pos[0] += (forward * Math.cos(yaw) + right * Math.sin(yaw)) * speed;
    pose.pos[1] += (forward * Math.sin(yaw) - right * Math.cos(yaw)) * speed;
    pose.pos[2] += (Number(keys.has('KeyE')) - Number(keys.has('KeyQ'))) * speed;
    const width = Math.round(canvas.clientWidth * devicePixelRatio),
      height = Math.round(canvas.clientHeight * devicePixelRatio);
    if (width !== canvas.width || height !== canvas.height) {
      canvas.width = width;
      canvas.height = height;
    }
    try {
      const frameStart = performance.now(),
        s = render(pose, Number(select.value));
      tick++;
      stats.textContent = `${s.draws} ${french ? 'appels' : 'draws'} · ${s.triangles.toLocaleString()} △ · ${(s.textureBytes / 1048576).toFixed(1)} MiB · CPU ${s.submissionMs.toFixed(1)} ms`;
      const sample = {
        ...s,
        tick,
        pose,
        completionMs: 0,
        setPose: (p: Pose) => {
          Object.assign(pose, p);
          request();
        },
      };
      Object.assign(window, { worldLab: sample });
      const fence = gl!.fenceSync(gl!.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (fence) {
        gl!.flush();
        const completed = () => {
          if (sample.tick !== tick) {
            gl!.deleteSync(fence);
            return;
          }
          const status = gl!.clientWaitSync(fence, 0, 0);
          if (status === gl!.TIMEOUT_EXPIRED) {
            setTimeout(completed, 8);
            return;
          }
          gl!.deleteSync(fence);
          if (status === gl!.WAIT_FAILED) return;
          sample.completionMs = performance.now() - frameStart;
          stats.textContent +=
            ' · ' + (french ? 'image' : 'frame') + ' ' + sample.completionMs.toFixed(0) + ' ms';
        };
        setTimeout(completed, 0);
      }
    } catch (e) {
      stats.textContent = String(e);
      canvas.dataset.error = String(e);
      return;
    }
    if (keys.size) request();
  }
  function request() {
    if (!raf) raf = requestAnimationFrame(frame);
  }
  select.onchange = request;
  new ResizeObserver(request).observe(canvas);
  canvas.onkeydown = (e) => {
    if (/^(Key[WASDQEZ]|ShiftLeft)$/.test(e.code)) {
      e.preventDefault();
      keys.add(e.code);
      request();
    }
  };
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  let x = 0,
    y = 0;
  canvas.onpointerdown = (e) => {
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    x = e.clientX;
    y = e.clientY;
  };
  canvas.onpointermove = (e) => {
    if (!canvas.hasPointerCapture(e.pointerId)) return;
    pose.ang[1] -= (e.clientX - x) * 0.18;
    pose.ang[0] = Math.max(-89, Math.min(89, pose.ang[0] + (e.clientY - y) * 0.18));
    x = e.clientX;
    y = e.clientY;
    request();
  };
  request();
}
start().catch((e) => {
  stats.textContent = e.message;
  canvas.dataset.error = e.message;
  console.error(e);
});
