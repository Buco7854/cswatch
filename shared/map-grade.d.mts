export type MapGrade = {
  exposure: { min: number; max: number; bias: number };
  curve: {
    shoulder: number;
    linear: number;
    angle: number;
    toe: number;
    numerator: number;
    denominator: number;
    whiteStops: number;
  };
  lighting?: { sun: [number, number, number]; sky: [number, number, number] };
  lut: { size: number; sha256: string };
};
export const mapGradeFile: string;
export function mapGradeBytes(size: number): number;
export function mapGradeCurve(curve: MapGrade['curve']): {
  a: number;
  b: number;
  c: number;
  white: number;
  whiteScale: number;
};
export function validMapGrade(value: unknown): value is MapGrade;
