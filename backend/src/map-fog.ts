import { z } from 'zod';

const scalar = (min: number, max: number) => z.number().finite().min(min).max(max);
const exponent = z.number().finite().gt(0).max(16);
const component = scalar(-1, 1);
const tolerance = 1e-4;
function properRotation(matrix: number[]) {
  for (let axis = 0; axis < 3; axis++) {
    for (let other = axis; other < 3; other++) {
      let column = 0,
        row = 0;
      for (let part = 0; part < 3; part++) {
        column += matrix[axis * 3 + part] * matrix[other * 3 + part];
        row += matrix[part * 3 + axis] * matrix[part * 3 + other];
      }
      const expected = axis === other ? 1 : 0;
      if (Math.abs(column - expected) > tolerance || Math.abs(row - expected) > tolerance)
        return false;
    }
  }
  const determinant =
    matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7]) -
    matrix[3] * (matrix[1] * matrix[8] - matrix[2] * matrix[7]) +
    matrix[6] * (matrix[1] * matrix[5] - matrix[2] * matrix[4]);
  return Math.abs(determinant - 1) <= tolerance;
}

export const mapCubeFogSchema = z
  .object({
    blend: z.literal('multiply'),
    start: scalar(0, 254000),
    end: scalar(0, 254000),
    exponent,
    height: z
      .object({ start: scalar(-254000, 254000), end: scalar(-254000, 254000), exponent })
      .strict()
      .refine((height) => height.start !== height.end)
      .nullable(),
    maxOpacity: scalar(0, 1),
    lodBias: scalar(0, 16),
    brightness: scalar(0, 16),
    rotation: z
      .tuple([
        component,
        component,
        component,
        component,
        component,
        component,
        component,
        component,
        component,
      ])
      .refine(properRotation),
  })
  .strict()
  .refine((fog) => fog.end > fog.start);
