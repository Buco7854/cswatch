// Blends follow depth order. A later draw can share earlier state if none of the
// intervening draws cover any of the same pixels.
export type ScreenRect = [number, number, number, number];

export function projectedBounds(
  box: number[],
  matrix: number[],
  width: number,
  height: number,
): ScreenRect {
  const rect: ScreenRect = [1, 1, -1, -1];
  for (let corner = 0; corner < 8; corner++) {
    const x = box[corner & 1 ? 3 : 0],
      y = box[corner & 2 ? 4 : 1],
      z = box[corner & 4 ? 5 : 2];
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    if (w <= 0) return [-1, -1, 1, 1];
    const u = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w;
    const v = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w;
    rect[0] = Math.min(rect[0], u);
    rect[1] = Math.min(rect[1], v);
    rect[2] = Math.max(rect[2], u);
    rect[3] = Math.max(rect[3], v);
  }
  return [
    Math.max(-1, rect[0] - 2 / width),
    Math.max(-1, rect[1] - 2 / height),
    Math.min(1, rect[2] + 2 / width),
    Math.min(1, rect[3] + 2 / height),
  ];
}

export function transparentGroups<T extends { key: string; rect: ScreenRect }>(
  ordered: T[],
): T[][] {
  const batches: T[][] = [];
  for (const item of ordered) {
    let destination: T[] | undefined;
    const [left, bottom, right, top] = item.rect;
    for (let i = batches.length - 1; i >= 0; i--) {
      const batch = batches[i];
      if (batch[0].key === item.key) {
        destination = batch;
        break;
      }
      if (
        batch.some(
          ({ rect }) => rect[2] >= left && rect[0] <= right && rect[3] >= bottom && rect[1] <= top,
        )
      )
        break;
    }
    if (destination) destination.push(item);
    else batches.push([item]);
  }
  return batches;
}
