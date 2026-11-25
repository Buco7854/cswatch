// Both reader and writer use undirected edges: meshoptimizer may rotate a triangle's
// three indices during entropy coding. Rotations preserve the opposite vertex.
export function trianglePredictors(indices, count, base = 0) {
  const opposite = new Map(),
    predictions = new Int32Array(count * 3).fill(-1);
  for (let first = 0; first < indices.length; first += 3) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[first + corner] - base;
      const left = indices[first + ((corner + 1) % 3)] - base;
      const right = indices[first + ((corner + 2) % 3)] - base;
      if (vertex < 0 || vertex >= count) throw Error('Index outside vertex range');
      const edge = Math.min(left, right) * count + Math.max(left, right);
      const across = opposite.get(edge);
      if (
        across !== undefined &&
        Math.max(left, right, across) < vertex &&
        predictions[3 * vertex] === -1
      ) {
        predictions[3 * vertex] = left;
        predictions[3 * vertex + 1] = right;
        predictions[3 * vertex + 2] = across;
      }
      opposite.set(edge, vertex);
    }
  }
  return predictions;
}

// Accumulate the residuals so meshoptimizer's byte delta pass sees the residual
// from the parallelogram predictor instead of just the previous vertex.
export function predictWords(words, components, predictions, encode) {
  const source = encode ? words.slice() : words;
  const previous = new Uint32Array(components);
  for (let i = 0; i < words.length / components; i++) {
    const left = predictions[3 * i],
      right = predictions[3 * i + 1],
      across = predictions[3 * i + 2];
    for (let c = 0; c < components; c++) {
      const at = i * components + c;
      const estimate =
        left < 0
          ? i
            ? source[at - components]
            : 0
          : source[left * components + c] +
            source[right * components + c] -
            source[across * components + c];
      const stored = words[at];
      words[at] = encode ? stored - estimate + previous[c] : stored - previous[c] + estimate;
      previous[c] = encode ? words[at] : stored;
    }
  }
}
