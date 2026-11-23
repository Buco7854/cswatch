/** Device-local viewer artwork. These values are not recovered player settings. */
export type CrosshairStyle = {
  color: string;
  length: number;
  thickness: number;
  gap: number;
  opacity: number;
  outline: boolean;
  outlineWidth: number;
  centerDot: boolean;
  tStyle: boolean;
};

export const CROSSHAIR_LIMITS = {
  length: { min: 1, max: 24, step: 0.5 },
  thickness: { min: 1, max: 8, step: 0.5 },
  gap: { min: 0, max: 16, step: 0.5 },
  opacity: { min: 0, max: 1, step: 0.05 },
  outlineWidth: { min: 0.5, max: 3, step: 0.5 },
} as const;

export const defaultCrosshairStyle: Readonly<CrosshairStyle> = Object.freeze({
  color: '#c6f24e',
  length: 8.5,
  thickness: 2,
  gap: 0,
  opacity: 1,
  outline: false,
  outlineWidth: 1,
  centerDot: false,
  tStyle: false,
});

const colorPattern = /^#[\da-f]{6}$/i;
const safeColor = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 7 && colorPattern.test(value);
const booleanKeys = ['outline', 'centerDot', 'tStyle'] as const;
const numericKeys = Object.keys(CROSSHAIR_LIMITS) as (keyof typeof CROSSHAIR_LIMITS)[];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.getOwnPropertyDescriptor(value, key)?.value;

/** Reject strings, NaN and inherited fields; bound finite numeric preferences. */
export function normalizeCrosshairStyle(value: unknown): CrosshairStyle {
  const result = { ...defaultCrosshairStyle };
  if (!record(value)) return result;
  const color = own(value, 'color');
  if (safeColor(color)) result.color = color.toLowerCase();
  for (const key of booleanKeys) {
    const field = own(value, key);
    if (typeof field === 'boolean') result[key] = field;
  }
  for (const key of numericKeys) {
    const field = own(value, key);
    if (typeof field !== 'number' || !Number.isFinite(field)) continue;
    const { min, max, step } = CROSSHAIR_LIMITS[key];
    const bounded = Math.max(min, Math.min(max, field));
    // Quantize to the controls' units without retaining floating-point noise.
    result[key] = Number((min + Math.round((bounded - min) / step) * step).toFixed(4));
  }
  return result;
}

/** Portable cswatch JSON, deliberately not a game share code or console command. */
export function formatCrosshairPreset(value: unknown): string {
  return JSON.stringify(
    { format: 'cswatch-crosshair', version: 1, style: normalizeCrosshairStyle(value) },
    null,
    2,
  );
}

type CrosshairRect = {
  id: 'left' | 'right' | 'top' | 'bottom' | 'dot';
  x: number;
  y: number;
  width: number;
  height: number;
};
type CrosshairGeometry = {
  size: 96;
  color: string;
  opacity: number;
  fills: CrosshairRect[];
  outlines: CrosshairRect[];
};

/** One CSS pixel per SVG unit in both the first-person overlay and its preview.
 * Gap is the center-to-arm distance. T style removes only the upper arm.
 * Outlines paint in one pass before every fill, avoiding seams where arms meet. */
export function crosshairGeometry(value: unknown): CrosshairGeometry {
  const style = normalizeCrosshairStyle(value);
  const { length, gap, thickness } = style;
  const c = 48,
    half = thickness / 2;
  const fills: CrosshairRect[] = [
    { id: 'left', x: c - gap - length, y: c - half, width: length, height: thickness },
    { id: 'right', x: c + gap, y: c - half, width: length, height: thickness },
    { id: 'bottom', x: c - half, y: c + gap, width: thickness, height: length },
  ];
  if (!style.tStyle)
    fills.push({ id: 'top', x: c - half, y: c - gap - length, width: thickness, height: length });
  if (style.centerDot)
    fills.push({ id: 'dot', x: c - half, y: c - half, width: thickness, height: thickness });
  const outlines = style.outline
    ? fills.map((rect) => ({
        ...rect,
        x: rect.x - style.outlineWidth,
        y: rect.y - style.outlineWidth,
        width: rect.width + style.outlineWidth * 2,
        height: rect.height + style.outlineWidth * 2,
      }))
    : [];
  return { size: 96, color: style.color, opacity: style.opacity, fills, outlines };
}
