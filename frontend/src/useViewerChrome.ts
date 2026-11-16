import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

const IDLE_MS = 3000;
const floatingSurface = () =>
  Boolean(
    document.querySelector('dialog[open],[aria-modal="true"],[role="menu"],[role="listbox"]'),
  );

/** Video-style chrome, without treating orbit drags or pinch gestures as taps. */
export function useViewerChrome({
  frame,
  stage,
  hidden,
  setHidden,
  playing,
  autoHide,
  blocked,
  ready,
}: {
  frame: RefObject<HTMLDivElement | null>;
  stage: RefObject<HTMLDivElement | null>;
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
  playing: boolean;
  autoHide: boolean;
  blocked: boolean;
  ready: boolean;
}) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!playing) setIdle(false);
  }, [playing, ready]);
  const visible = blocked || (!hidden && !idle);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const show = useCallback(() => {
    setIdle(false);
    setHidden(false);
  }, [setHidden]);
  const hide = useCallback(() => {
    if (blocked) return;
    // Move focus before making the controls inert. Captions remain independent.
    stage.current?.focus({ preventScroll: true });
    setHidden(true);
  }, [blocked, setHidden, stage]);
  const toggle = useCallback(() => {
    if (visibleRef.current) hide();
    else show();
  }, [hide, show]);

  useEffect(() => {
    const root = frame.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout>;
    const pointers = new Set<number>();
    let tap: { id: number; x: number; y: number; time: number; moved: boolean } | null = null;
    function arm() {
      clearTimeout(timer);
      if (!playing || !autoHide || !visible || blocked) return;
      timer = setTimeout(() => {
        const focused = document.activeElement;
        if (
          pointers.size ||
          floatingSurface() ||
          (focused instanceof HTMLElement &&
            focused.closest('[data-viewer-chrome]') &&
            focused.matches(':focus-visible'))
        ) {
          arm();
          return;
        }
        if (focused instanceof HTMLElement && focused.closest('[data-viewer-chrome]'))
          stage.current?.focus({ preventScroll: true });
        setIdle(true);
      }, IDLE_MS);
    }
    function down(event: PointerEvent) {
      pointers.add(event.pointerId);
      clearTimeout(timer);
      const target = event.target;
      if (
        pointers.size !== 1 ||
        !event.isPrimary ||
        event.button !== 0 ||
        !(target instanceof Element) ||
        !target.closest('.viewer-stage') ||
        target.closest('button,a,input,select,textarea,[data-viewer-chrome]')
      ) {
        tap = null;
        return;
      }
      tap = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
        moved: false,
      };
    }
    function move(event: PointerEvent) {
      if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 8) tap.moved = true;
      if (event.pointerType === 'mouse' && !pointers.size && !floatingSurface()) show();
      arm();
    }
    function up(event: PointerEvent) {
      pointers.delete(event.pointerId);
      const current = tap;
      tap = null;
      if (
        current?.id === event.pointerId &&
        !current.moved &&
        event.timeStamp - current.time < 500 &&
        Math.hypot(event.clientX - current.x, event.clientY - current.y) <= 8
      )
        toggle();
      arm();
    }
    function cancel(event: PointerEvent) {
      pointers.delete(event.pointerId);
      tap = null;
      arm();
    }
    function activity() {
      arm();
    }
    root.addEventListener('pointerdown', down, true);
    root.addEventListener('pointermove', move, true);
    // Capture at the window so a drag released outside the frame cannot strand it.
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    root.addEventListener('keydown', activity, true);
    root.addEventListener('focusin', activity);
    arm();
    return () => {
      clearTimeout(timer);
      root.removeEventListener('pointerdown', down, true);
      root.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      root.removeEventListener('keydown', activity, true);
      root.removeEventListener('focusin', activity);
    };
  }, [frame, stage, playing, autoHide, visible, blocked, ready, show, toggle]);
  return { visible, show, hide, toggle };
}
