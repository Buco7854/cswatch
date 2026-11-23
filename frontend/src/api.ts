import { BrowserStorageError, withBrowserSession } from './browser-bootstrap';
import { t } from './i18n';
import type { AuthStatus } from './types';
let sessionCsrf = '';
let guestCsrf = '';
type AccessChange = 'session' | 'admin-network';
let accessChanged: ((context: string, change: AccessChange) => void) | undefined;

const pacedTotpPaths = new Set([
  '/api/auth/mfa/totp',
  '/api/auth/step-up/totp',
  '/api/auth/factors/totp/verify',
]);
// The server can spend up to 25 seconds pacing a proof before sending its response.
const pacedTotpTimeoutMs = 35_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
export class SessionChangedError extends Error {
  constructor() {
    super('Session expired. Refresh the page and try again.');
  }
}

export function sessionDeadline(signal?: AbortSignal | null, timeoutMs = 15_000) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export function observeAccessChanges(listener: NonNullable<typeof accessChanged>) {
  accessChanged = listener;
  return () => {
    accessChanged = undefined;
  };
}
export function setCsrf(session: string, guest: string) {
  sessionCsrf = session;
  guestCsrf = guest;
}
function adminApi(pathname: string) {
  return pathname === '/api/admin' || pathname.startsWith('/api/admin/');
}
function accountRead(pathname: string) {
  return (
    pathname === '/api/config' ||
    pathname === '/api/demos' ||
    pathname.startsWith('/api/demos/') ||
    adminApi(pathname) ||
    pathname.startsWith('/api/connections/') ||
    (pathname.startsWith('/api/auth/') && pathname !== '/api/auth/me')
  );
}

export function requestData<T>(
  path: string,
  options: RequestInit,
  read: (response: Response) => Promise<T>,
  sessionContext?: string,
): Promise<T> {
  const method = options.method?.toUpperCase();
  const explicitLogout = method === 'POST' && path === '/api/auth/logout';
  const mayIssueAnonymous =
    explicitLogout ||
    (method === 'DELETE' && path.startsWith('/api/auth/sessions/')) ||
    (method === 'POST' &&
      (path === '/api/auth/sessions/revoke-all' ||
        /^\/api\/auth\/recover\/(?:claim|complete)$/.test(path) ||
        /^\/api\/admin\/users\/[^/]+\/actions$/.test(path)));
  if (mayIssueAnonymous) {
    const context = sessionContext ?? sessionCsrf;
    let started = false;
    const exchange = (init: RequestInit) =>
      exchangeData(path, init, read, context, true, sessionContext === undefined);
    return withBrowserSession((signal) => {
      started = true;
      return exchange({ ...options, signal });
    }, options.signal).catch((error: unknown) => {
      // A signed-in browser must be able to revoke its grant when local storage
      // is unavailable. No anonymous cookie may be published outside the lock.
      if (
        !started &&
        explicitLogout &&
        (!options.signal?.aborted || options.signal.reason?.name === 'TimeoutError')
      ) {
        const headers = new Headers(options.headers);
        headers.set('X-Omit-Anonymous-Cookie', '1');
        return exchange({ ...options, headers, signal: sessionDeadline() });
      }
      return connectionFailure(error, options.signal);
    });
  }
  return exchangeData(path, options, read, sessionContext);
}

function connectionFailure(error: unknown, signal?: AbortSignal | null): never {
  if (
    (signal?.aborted && signal.reason?.name !== 'TimeoutError') ||
    error instanceof ApiError ||
    error instanceof BrowserStorageError ||
    error instanceof SessionChangedError
  )
    throw error;
  throw new Error(t('Connection lost. Try again.'));
}

async function exchangeData<T>(
  path: string,
  options: RequestInit,
  read: (response: Response) => Promise<T>,
  sessionContext?: string,
  browserSessionLocked = false,
  observeChanges = sessionContext === undefined,
): Promise<T> {
  const headers = new Headers(options.headers);
  const method = options.method?.toUpperCase() || 'GET';
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const context = sessionContext ?? sessionCsrf;
  const pathname = path.split('?')[0];
  const boundRead = (method === 'GET' || method === 'HEAD') && accountRead(pathname);
  const boundAdminWrite = unsafe && adminApi(pathname);
  if (boundRead || boundAdminWrite) headers.set('X-Session-Context', context);
  const body = options.body ?? (unsafe ? '{}' : undefined);
  if (body && !(body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const account = path.startsWith('/api/auth/') || path === '/api/setup';
  if (unsafe && !headers.has('X-CSRF-Token')) {
    headers.set('X-CSRF-Token', account ? context : guestCsrf || context);
  }
  const status = method === 'GET' && pathname === '/api/auth/me';
  const pacedTotp = method === 'POST' && pacedTotpPaths.has(pathname);
  const requestSignal =
    account || path === '/api/config'
      ? sessionDeadline(options.signal, pacedTotp ? pacedTotpTimeoutMs : undefined)
      : options.signal;
  const send = (signal = requestSignal) =>
    fetch(path, {
      ...options,
      ...(boundRead || status ? { cache: 'no-store' } : {}),
      body,
      headers,
      signal,
      credentials: 'same-origin',
    });
  const failed = (error: unknown) => connectionFailure(error, options.signal);
  if (status) headers.set('X-Browser-Session-Probe', '1');
  const response = await send().catch(failed);
  if (
    status &&
    response.status === 204 &&
    response.headers.get('X-Browser-Bootstrap-Required') === '1'
  ) {
    headers.delete('X-Browser-Session-Probe');
    if (browserSessionLocked) return read(await send().catch(failed));
    return withBrowserSession(async (signal) => read(await send(signal)), requestSignal).catch(
      failed,
    );
  }
  if (
    (boundRead || boundAdminWrite) &&
    response.status === 409 &&
    response.headers.get('X-Session-Changed') === '1'
  ) {
    // The caller of a paired status/configuration read will retry the pair itself.
    if ((observeChanges || boundAdminWrite) && context === sessionCsrf)
      accessChanged?.(context, 'session');
    throw new SessionChangedError();
  }
  const result = await read(response).catch((error: unknown) => {
    if (requestSignal?.aborted) return failed(error);
    throw error;
  });
  if (boundRead && sessionContext === undefined && context !== sessionCsrf)
    throw new SessionChangedError();
  return result;
}

async function readApiResponse<T>(response: Response, onSuccess?: () => void): Promise<T> {
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
  onSuccess?.();
  return response.json();
}

export function api<T>(
  path: string,
  options: RequestInit = {},
  sessionContext?: string,
  onSuccess?: () => void,
): Promise<T> {
  const context = sessionContext ?? sessionCsrf;
  return requestData<T>(
    path,
    options,
    (response) => readApiResponse<T>(response, onSuccess),
    sessionContext,
  ).catch((error: unknown) => {
    if (
      error instanceof ApiError &&
      error.status === 403 &&
      error.code === 'admin_network_denied' &&
      adminApi(path.split('?')[0])
    ) {
      if (!options.signal?.aborted && context === sessionCsrf)
        accessChanged?.(context, 'admin-network');
      throw new ApiError(
        t('The request could not be completed. Try again later.'),
        error.status,
        error.code,
      );
    }
    throw error;
  });
}

export function prepareGuestUpload(callerSignal: AbortSignal) {
  // The status retry and guest POST must install cookies under the same lock.
  return withBrowserSession(async (signal) => {
    const status = await exchangeData(
      '/api/auth/me',
      { signal },
      readApiResponse<AuthStatus>,
      undefined,
      true,
    );
    if (status.session.stage !== 'anonymous') return;
    return api<{ csrf: string; expires_at: number }>('/api/guest/session', {
      method: 'POST',
      signal,
      headers: { 'X-CSRF-Token': status.guest_session?.csrf ?? status.session.csrf },
    });
  }, callerSignal).catch((error: unknown) => connectionFailure(error, callerSignal));
}

export function uploadFile(
  file: File,
  progress: (n: number) => void,
  signal?: AbortSignal,
  csrfToken = guestCsrf || sessionCsrf,
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
