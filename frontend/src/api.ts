import { t } from './i18n';
let csrf = '';
export function setCsrf(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrf);
  let response: Response;
  try {
    response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(t('Connection lost. Try again.'));
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      typeof data.detail === 'string'
        ? data.detail
        : t('Request failed ({{v0}}). Check the fields and try again.', { v0: response.status }),
      response.status,
      typeof data.code === 'string' ? data.code : undefined,
    );
  }
  return response.json();
}
export function uploadFile(
  file: File,
  progress: (n: number) => void,
  signal?: AbortSignal,
  csrfToken = csrf,
  match?: { source: 'steam' | 'faceit'; id: string },
): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Upload cancelled.', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    const abort = () => xhr.abort();
    function finish(result: { id: string } | Error) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
      xhr.upload.onprogress = null;
      if ('id' in result) resolve(result);
      else reject(result);
    }
    xhr.open(
      'POST',
      match
        ? '/api/demos?' + new URLSearchParams({ [match.source + '_match']: match.id })
        : '/api/demos',
    );
    xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        finish(new Error(t('Upload failed. Try again.')));
        return;
      }
      const object = data && typeof data === 'object' ? data : {};
      if (xhr.status >= 200 && xhr.status < 300 && typeof object.id === 'string')
        finish({ id: object.id });
      else
        finish(new Error(typeof object.detail === 'string' ? object.detail : t('Upload failed.')));
    };
    xhr.onerror = () => finish(new Error(t('Connection lost. Try your upload again.')));
    xhr.onabort = () => finish(new DOMException('Upload cancelled.', 'AbortError'));
    xhr.timeout = 600000;
    xhr.ontimeout = () => finish(new Error(t('Upload timed out. Try again.')));
    const form = new FormData();
    form.append('file', file);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      xhr.send(form);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(t('Upload failed.')));
    }
  });
}
