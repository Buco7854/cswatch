// All tabs use one lock domain even when the Web Locks API is unavailable.
// The empty object store only supplies an exclusive transaction across tabs.
const database = 'cswatch-browser-session';
const store = 'bootstrap';
const timeoutMs = 15_000;

export class BrowserStorageError extends Error {
  constructor(cause?: unknown) {
    super(
      'In your browser settings, allow this site to store data, then retry. You can also use another browser.',
      { cause },
    );
  }
}

function openBootstrapDatabase(signal: AbortSignal): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) throw signal.reason;
    const request = indexedDB.open(database, 1);
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onerror = () => {
      signal.removeEventListener('abort', cancel);
      reject(request.error);
    };
    request.onsuccess = () => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) request.result.close();
      else resolve(request.result);
    };
  });
}

export async function withBrowserSession<T>(
  exchange: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal | null,
) {
  const controller = new AbortController();
  const { signal } = controller;
  const expiresAt = Date.now() + timeoutMs;
  const expire = () =>
    controller.abort(new DOMException('Browser sign-in timed out.', 'TimeoutError'));
  const timer = window.setTimeout(expire, timeoutMs);
  const cancel = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) cancel();
  else callerSignal?.addEventListener('abort', cancel, { once: true });

  let db: IDBDatabase | undefined;
  try {
    let transaction: IDBTransaction;
    let lock: IDBObjectStore;
    try {
      db = await openBootstrapDatabase(signal);
      if (signal.aborted) throw signal.reason;
      transaction = db.transaction(store, 'readwrite');
      lock = transaction.objectStore(store);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new BrowserStorageError(error);
    }
    return await new Promise<T>((resolve, reject) => {
      let started = false;
      let result: { value: T } | { error: unknown } | undefined;
      const abort = () => {
        if (started) return; // Wait for the cancelled exchange to settle.
        try {
          transaction.abort();
        } catch {
          // An already settled transaction has released its lock.
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      const finish = () => signal.removeEventListener('abort', abort);
      transaction.onabort = () => {
        finish();
        controller.abort(started ? transaction.error : new BrowserStorageError(transaction.error));
        reject(signal.reason);
      };
      transaction.oncomplete = () => {
        finish();
        if (signal.aborted) reject(signal.reason);
        else if (result && 'value' in result) resolve(result.value);
        else reject(result?.error);
      };
      function holdUntilCookies() {
        // Start only when IndexedDB grants the writer. Keep one read pending
        // until the exchange settles and the browser has processed Set-Cookie.
        lock.get(store).onsuccess = () => {
          if (Date.now() >= expiresAt) expire();
          if (result || (signal.aborted && !started)) return;
          if (!started) {
            started = true;
            void Promise.resolve()
              .then(() => exchange(signal))
              .then(
                (value) => (result = { value }),
                (error: unknown) => (result = { error }),
              );
          }
          holdUntilCookies();
        };
      }
      holdUntilCookies();
    });
  } finally {
    callerSignal?.removeEventListener('abort', cancel);
    window.clearTimeout(timer);
    db?.close();
  }
}
