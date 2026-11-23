import { memo, useCallback, useLayoutEffect, useMemo, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useFrame, useThree } from '@react-three/fiber';
import { Raycaster, Vector2, Vector3, type Bone, type Group } from 'three';
import { overlapsOverlay, placeActorLabel, type ActorOverlayLayout } from '../actor-overlay';
import { smokeHidesLabel } from '../smoke-render-state';
import type { SmokeSample } from '../smoke-field';
import { t } from '../i18n';
import type { Player, Position } from '../types';

type ActorAnchor = {
  body: RefObject<Group | null>;
  head: RefObject<Bone | null>;
  height: number;
  yaw: number;
};

export function createActorOverlay() {
  return {
    anchors: new Map<string, ActorAnchor>(),
    labels: new Map<string, HTMLDivElement>(),
    markers: new Map<string, HTMLDivElement>(),
    sizes: new WeakMap<Element, { width: number; height: number }>(),
    observer: undefined as ResizeObserver | undefined,
    invalidate: undefined as (() => void) | undefined,
  };
}

export type ActorOverlay = ReturnType<typeof createActorOverlay>;

const ActorOverlayItem = memo(function ActorOverlayItem({
  overlay,
  id,
  name,
  health,
  team,
  selected,
  marker,
}: {
  overlay: ActorOverlay;
  id: string;
  name?: string;
  health: number;
  team: number;
  selected: boolean;
  marker: boolean;
}) {
  useTranslation();
  const labelRef = useCallback(
    (element: HTMLDivElement | null) => {
      const old = overlay.labels.get(id);
      if (old) overlay.observer?.unobserve(old);
      if (element) {
        overlay.labels.set(id, element);
        overlay.observer?.observe(element, { box: 'border-box' });
        if (typeof ResizeObserver === 'undefined')
          overlay.sizes.set(element, element.getBoundingClientRect());
      } else overlay.labels.delete(id);
      overlay.invalidate?.();
    },
    [overlay, id],
  );
  const markerRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) overlay.markers.set(id, element);
      else overlay.markers.delete(id);
      overlay.invalidate?.();
    },
    [overlay, id],
  );
  return (
    <>
      {name && (
        <div
          ref={labelRef}
          className="actor-label"
          data-team={team}
          data-player={id}
          role="img"
          aria-label={t('{{name}}, {{health}} health', { name, health })}
        >
          <span className="actor-label-name">{name}</span>
          {Number.isFinite(health) && health >= 0 && (
            <span className="actor-label-health">
              <span className="actor-label-track" aria-hidden="true">
                <span style={{ width: Math.min(100, health) + '%' }} />
              </span>
              <span>{health}</span>
            </span>
          )}
        </div>
      )}
      {marker && (
        <div
          ref={markerRef}
          className="overhead-player-marker"
          data-player={id}
          data-team={team}
          data-selected={selected}
          aria-hidden="true"
        >
          <span />
        </div>
      )}
    </>
  );
});

export default memo(function ActorOverlays({
  overlay,
  players,
  positions,
  selected,
  labels,
  mode,
}: {
  overlay: ActorOverlay;
  players: Player[];
  positions: Position[];
  selected: string;
  labels: boolean;
  mode: string;
}) {
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      let resized = false;
      for (const entry of entries) {
        const size = entry.borderBoxSize?.[0];
        const { width, height } = size
          ? { width: size.inlineSize, height: size.blockSize }
          : entry.target.getBoundingClientRect();
        const previous = overlay.sizes.get(entry.target);
        if (previous?.width === width && previous.height === height) continue;
        overlay.sizes.set(entry.target, { width, height });
        resized = true;
      }
      if (resized) overlay.invalidate?.();
    });
    overlay.observer = observer;
    for (const label of overlay.labels.values()) observer.observe(label, { box: 'border-box' });
    return () => {
      observer.disconnect();
      overlay.observer = undefined;
    };
  }, [overlay]);
  const names = useMemo(() => new Map(players.map(({ id, name }) => [id, name])), [players]);
  const marker = mode === 'tactical';
  return (
    <div className="actor-overlays">
      {positions.map(({ id, alive, health, team }) => {
        if (!alive || (mode === 'pov' && id === selected)) return null;
        const name = labels ? names.get(id) : undefined;
        if (!name && !marker) return null;
        return (
          <ActorOverlayItem
            key={id}
            overlay={overlay}
            id={id}
            name={name}
            health={health}
            team={team}
            selected={id === selected}
            marker={marker}
          />
        );
      })}
    </div>
  );
});

function paint(element: HTMLElement, box?: { left: number; top: number }) {
  const visibility = box ? 'visible' : 'hidden';
  if (element.style.visibility !== visibility) element.style.visibility = visibility;
  if (!box) return;
  const transform = `translate3d(${box.left}px, ${box.top}px, 0px)`;
  if (element.style.transform !== transform) element.style.transform = transform;
}

/** A single screen-space pass reads the sampled world poses and cached DOM sizes. */
export function useActorOverlayFrame(
  overlay: ActorOverlay | undefined,
  layout: ActorOverlayLayout | undefined,
  selected: string,
  xray: boolean,
  smoke: RefObject<SmokeSample[]>,
) {
  const invalidate = useThree((state) => state.invalidate);
  const scratch = useMemo(
    () => ({ point: new Vector3(), ndc: new Vector2(), ray: new Raycaster() }),
    [],
  );
  useLayoutEffect(() => {
    if (!overlay) return;
    overlay.invalidate = invalidate;
    if (layout) layout.invalidate = invalidate;
    return () => {
      overlay.invalidate = undefined;
      if (layout?.invalidate === invalidate) layout.invalidate = undefined;
      for (const element of overlay.labels.values()) paint(element);
      for (const element of overlay.markers.values()) paint(element);
    };
  }, [overlay, layout, invalidate]);
  useFrame(({ camera, scene, size }) => {
    if (!overlay || (!overlay.labels.size && !overlay.markers.size)) return;
    camera.updateMatrixWorld();
    const { point, ndc, ray } = scratch;
    const { width, height } = size;
    const occupied = [...(layout?.rectangles ?? [])];
    const candidates = [];
    for (const [id, element] of overlay.markers) {
      const anchor = overlay.anchors.get(id);
      const body = anchor?.body.current;
      if (!body?.visible || !anchor) {
        paint(element);
        continue;
      }
      body.getWorldPosition(point).project(camera);
      const radius = id === selected ? 10 : 7;
      const left = Math.round(((point.x + 1) * width) / 2) - radius;
      const top = Math.round(((1 - point.y) * height) / 2) - radius;
      const box = { left, top, right: left + 2 * radius, bottom: top + 2 * radius };
      if (
        point.z < -1 ||
        point.z > 1 ||
        left < 0 ||
        top < 0 ||
        box.right > width ||
        box.bottom > height ||
        overlapsOverlay(box, layout?.rectangles ?? [])
      ) {
        paint(element);
        continue;
      }
      const heading = `${-anchor.yaw}deg`;
      if (element.style.getPropertyValue('--actor-heading') !== heading)
        element.style.setProperty('--actor-heading', heading);
      paint(element, box);
      occupied.push(box);
    }
    for (const [id, element] of overlay.labels) {
      const anchor = overlay.anchors.get(id);
      const body = anchor?.body.current;
      const box = overlay.sizes.get(element);
      if (!body?.visible || !anchor || !box) {
        paint(element);
        continue;
      }
      if (anchor.head.current) {
        body.worldToLocal(anchor.head.current.getWorldPosition(point));
        if (point.y >= 0.25 && point.y <= 2.3 && Math.hypot(point.x, point.z) <= 0.8)
          point.y += 0.24;
        else point.set(0, anchor.height, 0);
      } else point.set(0, anchor.height, 0);
      body.localToWorld(point);
      if (
        !xray &&
        smoke.current.length &&
        smokeHidesLabel(smoke.current, camera.position.toArray(), point.toArray())
      ) {
        paint(element);
        continue;
      }
      const distance = point.distanceToSquared(camera.position);
      point.project(camera);
      if (point.z < -1 || point.z > 1) {
        paint(element);
        continue;
      }
      candidates.push({
        element,
        box,
        distance,
        x: point.x,
        y: point.y,
        selected: id === selected,
      });
    }
    candidates.sort((a, b) => Number(b.selected) - Number(a.selected) || a.distance - b.distance);
    for (const candidate of candidates) {
      const box = placeActorLabel(
        ((candidate.x + 1) * width) / 2,
        ((1 - candidate.y) * height) / 2,
        candidate.box.width,
        candidate.box.height,
        size,
        occupied,
      );
      if (box && !xray) {
        ray.setFromCamera(ndc.set(candidate.x, candidate.y), camera);
        ray.far = Math.sqrt(candidate.distance) - 0.001;
        if (ray.intersectObjects(scene.children, true).length) {
          paint(candidate.element);
          continue;
        }
      }
      paint(candidate.element, box);
      if (box) occupied.push(box);
    }
  });
}
