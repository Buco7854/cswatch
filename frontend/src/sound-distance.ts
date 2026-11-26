import registry from '../../shared/gameplay-sounds.json' with { type: 'json' };

type Curve = readonly (readonly [number, number])[];
const curves = new Map<string, Curve>();
for (const [name, event] of Object.entries(registry.events))
  if ('distance' in event && Array.isArray(event.distance))
    curves.set(name.toLowerCase(), event.distance as unknown as Curve);

/** Valve's authored distance-to-gain curve for a recorded sound event, linear between its
 * points (Source inches). Undefined when the event has no authored curve. */
export function authoredDistanceGain(eventName: string | undefined, inches: number) {
  const curve = eventName ? curves.get(eventName.toLowerCase()) : undefined;
  if (!curve || !Number.isFinite(inches)) return;
  if (inches <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [d1, g1] = curve[i];
    if (inches <= d1) {
      const [d0, g0] = curve[i - 1];
      return g0 + ((g1 - g0) * (inches - d0)) / Math.max(1e-6, d1 - d0);
    }
  }
  return curve.at(-1)![1];
}
