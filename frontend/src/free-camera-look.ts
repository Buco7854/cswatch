import { Euler, PerspectiveCamera, Vector3 } from 'three';

const turnRate = 0.003;
const pitchLimit = Math.PI / 2 - 0.01;
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/** Turn at the current eye position, with no orbit center or camera roll. */
export function turnFreeCamera(camera: PerspectiveCamera, dx: number, dy: number, sensitivity = 1) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const rotation = new Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  camera.rotation.set(
    clamp(rotation.x - clamp(dy, 2000) * turnRate * sensitivity, pitchLimit),
    rotation.y - clamp(dx, 2000) * turnRate * sensitivity,
    0,
    'YXZ',
  );
  camera.updateMatrixWorld();
}

type Pointer = { x: number; y: number; pan: boolean };
const blocked = () =>
  !!document.querySelector('dialog[open],[aria-modal="true"],[role="menu"],[role="listbox"]');

/** Canvas-only mouse/touch look for recorded-map noclip. The caller owns the
 * mounted viewer lifetime; disposing releases every held pointer and listener. */
export function installFreeCameraLook(
  element: HTMLElement,
  camera: PerspectiveCamera,
  invalidate: () => void,
  sensitivity = 1,
  invertVertical = false,
) {
  const pointers = new Map<number, Pointer>();
  let active = true;
  const previousTouchAction = element.style.touchAction;
  element.style.touchAction = 'none';
  const forward = new Vector3(),
    right = new Vector3(),
    up = new Vector3();
  const pan = (dx: number, dy: number) => {
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(right, -clamp(dx, 400) * 0.01);
    camera.position.addScaledVector(up, clamp(dy, 400) * 0.01);
  };
  const dolly = (distance: number) => {
    camera.getWorldDirection(forward);
    camera.position.addScaledVector(forward, clamp(distance, 4));
  };
  const release = (id: number) => {
    pointers.delete(id);
    try {
      if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    } catch {
      // A browser may already have released a canceled or removed pointer.
    }
  };
  const clear = () => {
    for (const id of [...pointers.keys()]) release(id);
  };
  const down = (event: PointerEvent) => {
    if (!active || blocked() || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    if (event.pointerType === 'mouse' && ![0, 1, 2].includes(event.button)) return;
    if (pointers.size >= 2) return;
    event.preventDefault();
    // Choose a visible game focus target before tracking the gesture. A dialog's
    // older deferred restoration must yield to this newer pointer interaction.
    const focusTarget = element.closest<HTMLElement>('.viewer-stage');
    if (!pointers.size && focusTarget && document.activeElement !== focusTarget)
      focusTarget.focus({ preventScroll: true });
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pan: event.button === 1 });
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events and a concurrently detached canvas have no active pointer.
    }
  };
  const move = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId);
    if (!previous || !active) return;
    if (blocked()) {
      clear();
      return;
    }
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    event.preventDefault();
    const dx = event.clientX - previous.x,
      dy = event.clientY - previous.y;
    if (pointers.size === 2) {
      const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
      pan(dx / 2, dy / 2);
      dolly((after - before) * 0.02);
    } else if (previous.pan) pan(dx, dy);
    else turnFreeCamera(camera, dx, invertVertical ? -dy : dy, sensitivity);
    previous.x = event.clientX;
    previous.y = event.clientY;
    camera.updateMatrixWorld();
    invalidate();
  };
  const end = (event: PointerEvent) => release(event.pointerId);
  const wheel = (event: WheelEvent) => {
    // Preserve browser zoom and accessibility shortcuts.
    if (!active || blocked() || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!Number.isFinite(event.deltaY)) return;
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
    dolly(-clamp(event.deltaY * units, 400) * 0.01);
    camera.updateMatrixWorld();
    invalidate();
  };
  const context = (event: Event) => {
    if (!blocked()) event.preventDefault();
  };
  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', end);
  element.addEventListener('lostpointercapture', end);
  element.addEventListener('wheel', wheel, { passive: false });
  element.addEventListener('contextmenu', context);
  window.addEventListener('blur', clear);
  document.addEventListener('focusin', clear);
  return () => {
    active = false;
    clear();
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', end);
    element.removeEventListener('pointercancel', end);
    element.removeEventListener('lostpointercapture', end);
    element.removeEventListener('wheel', wheel);
    element.removeEventListener('contextmenu', context);
    window.removeEventListener('blur', clear);
    document.removeEventListener('focusin', clear);
    if (element.style.touchAction === 'none') element.style.touchAction = previousTouchAction;
  };
}
