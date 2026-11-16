import { t } from './i18n';
let csrf = '';
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrf);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      typeof data.detail === 'string'
        ? data.detail
        : t('Request failed ({{v0}}). Check the fields and try again.', { v0: response.status }),
    );
  }
  return response.json();
}
export function uploadFile(file: File, progress: (n: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/demos');
    xhr.setRequestHeader('X-CSRF-Token', csrf);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error(t('Upload failed. Try again.')));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(typeof data.detail === 'string' ? data.detail : t('Upload failed.')));
    };
    xhr.onerror = () => reject(new Error(t('Connection lost. Try your upload again.')));
    xhr.timeout = 600000;
    xhr.ontimeout = () => reject(new Error(t('Upload timed out. Try again.')));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}
