import type { ProviderRequests, ProviderService } from './provider-requests.js';
import { HttpError } from './errors.js';

class UpstreamReadError extends Error {}

/** Fixed-origin provider responses are still bounded before JSON/text allocation. */
export async function readUpstreamText(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty provider response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(() => {
        throw new UpstreamReadError();
      });
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

export async function requestProvider<T>(
  requests: ProviderRequests,
  service: ProviderService,
  url: string,
  options: RequestInit,
  failure: string,
  read: (response: Response) => Promise<T>,
) {
  return requests.run(service, async (report) => {
    let response: Response;
    try {
      response = await fetch(url, { ...options, redirect: 'error' });
    } catch {
      if (!options.signal?.aborted || options.signal.reason?.name === 'TimeoutError') report(503);
      throw new HttpError(502, failure);
    }
    report(response.status, response.headers.get('retry-after'));
    try {
      return await read(response);
    } catch (error) {
      if (
        error instanceof UpstreamReadError &&
        (!options.signal?.aborted || options.signal.reason?.name === 'TimeoutError')
      )
        report(503);
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, failure);
    } finally {
      if (!response.bodyUsed) void response.body?.cancel().catch(() => {});
    }
  });
}
