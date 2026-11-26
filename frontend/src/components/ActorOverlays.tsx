import { memo, useCallback, useLayoutEffect, useMemo, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useFrame, useThree } from '@react-three/fiber';
import { Raycaster, Vector2, Vector3, type Bone, type Group } from 'three';
import {
  actorLabelStyle,
  overlapsOverlay,
  placeActorLabel,
  type ActorOverlayLayout,
  type ScreenRect,
} from '../actor-overlay';
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

/** Half the side of the aim point kept free of labels in first person. The
 * drawn crosshair also reserves its own measured box through the HUD layout. */
const reticleClearance = 8;
/** Lift above the head bone so the chevron sits just over the head. */
const headClearance = 0.2;

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
            <span className="actor-label-track" aria-hidden="true">
              <span style={{ width: Math.min(100, health) + '%' }} />
            </span>
          )}
          <svg className="actor-label-marker" viewBox="0 0 10 6" aria-hidden="true">
            <path d="M1 1h8L5 5z" />
          </svg>
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
        // The watched player is identified by the HUD, so only others get a name.
        const name = labels && id !== selected ? names.get(id) : undefined;
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

function paint(element: HTMLElement, box?: { left: number; top: number }, scale = 1) {
  const visibility = box ? 'visible' : 'hidden';
  if (element.style.visibility !== visibility) element.style.visibility = visibility;
  if (!box) return;
  const transform =
    `translate3d(${box.left}px, ${box.top}px, 0px)` + (scale === 1 ? '' : ` scale(${scale})`);
  if (element.style.transform !== transform) element.style.transform = transform;
}

function flag(element: HTMLElement, name: 'occluded' | 'compact', value: boolean) {
  if (value) {
    if (element.dataset[name] !== 'true') element.dataset[name] = 'true';
  } else if (name in element.dataset) delete element.dataset[name];
}

/** A single screen-space pass reads the sampled world poses and cached DOM sizes. */
export function useActorOverlayFrame(
  overlay: ActorOverlay | undefined,
  layout: ActorOverlayLayout | undefined,
  selected: string,
  xray: boolean,
  pov: boolean,
  smoke: RefObject<SmokeSample[]>,
  world?: import('../world/queries').WorldQueries,
) {
  const invalidate = useThree((state) => state.invalidate);
  const scratch = useMemo(
    () => ({
      point: new Vector3(),
      ndc: new Vector2(),
      ray: new Raycaster(),
      markers: new Map<string, ScreenRect>(),
    }),
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
    const markerBoxes = scratch.markers;
    markerBoxes.clear();
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
      markerBoxes.set(id, box);
    }
    // Keep the aim point readable in first person.
    if (pov)
      occupied.push({
        left: width / 2 - reticleClearance,
        right: width / 2 + reticleClearance,
        top: height / 2 - reticleClearance,
        bottom: height / 2 + reticleClearance,
      });
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
          point.y += headClearance;
        else point.set(0, anchor.height, 0);
      } else point.set(0, anchor.height, 0);
      body.localToWorld(point);
      const smoked =
        smoke.current.length > 0 &&
        smokeHidesLabel(smoke.current, camera.position.toArray(), point.toArray());
      if (smoked && !xray) {
        paint(element);
        continue;
      }
      const distance = point.distanceToSquared(camera.position);
      point.project(camera);
      if (point.z < -1 || point.z > 1) {
        paint(element);
        continue;
      }
      // From above, the head projects onto the player's own direction arrow;
      // the label then stands on top of the arrow instead.
      const marker = markerBoxes.get(id);
      const bottom = ((1 - point.y) * height) / 2;
      candidates.push({
        element,
        box,
        distance,
        smoked,
        x: point.x,
        y: point.y,
        bottom: marker ? Math.min(bottom, marker.top - 3) : bottom,
      });
    }
    // Nearer players keep their full label when two collide.
    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates) {
      const meters = Math.sqrt(candidate.distance);
      const { scale } = actorLabelStyle(meters, false);
      const placed = placeActorLabel(
        ((candidate.x + 1) * width) / 2,
        candidate.bottom,
        candidate.box,
        scale,
        size,
        occupied,
      );
      if (!placed) {
        paint(candidate.element);
        continue;
      }
      let occluded = candidate.smoked;
      if (!occluded) {
        ray.setFromCamera(ndc.set(candidate.x, candidate.y), camera);
        ray.far = meters - 0.001;
        occluded = world
          ? Boolean(
              world.hit({
                target: ray.ray.origin.toArray(),
                position: ray.ray.at(ray.far, point).toArray(),
              }),
            )
          : ray.intersectObjects(scene.children, true).length > 0;
      }
      // Without X-ray, a player behind a wall or smoke has no label.
      if (occluded && !xray) {
        paint(candidate.element);
        continue;
      }
      const { opacity } = actorLabelStyle(meters, occluded);
      const opacityText = String(opacity);
      if (candidate.element.style.opacity !== opacityText)
        candidate.element.style.opacity = opacityText;
      flag(candidate.element, 'occluded', occluded);
      flag(candidate.element, 'compact', placed.compact);
      // Scale around the bottom centre so the chevron stays on the head.
      const { width: labelWidth, height: labelHeight } = candidate.box;
      const centre = (placed.box.left + placed.box.right) / 2;
      paint(
        candidate.element,
        {
          left: Math.round(centre - labelWidth / 2),
          top: Math.round(placed.box.bottom - labelHeight),
        },
        scale,
      );
      occupied.push(placed.box);
    }
  });
}
