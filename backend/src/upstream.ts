/** Fixed-origin provider responses are still bounded before JSON/text allocation. */
export async function readUpstreamText(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty provider response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Provider response limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export async function readUpstreamJson(response: Response, maxBytes = 2 * 1024 ** 2) {
  return JSON.parse(await readUpstreamText(response, maxBytes)) as any;
}
