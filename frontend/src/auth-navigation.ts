import { safeAuthReturnPath } from '../../shared/auth-navigation.mjs';
export { safeAuthReturnPath as authReturnPath } from '../../shared/auth-navigation.mjs';

export function authPath(mode: 'login' | 'register', returnTo: unknown) {
  return `/${mode}?${new URLSearchParams({ returnTo: safeAuthReturnPath(returnTo) })}`;
}

/** Read mail-link secrets before a router or redirect can retain the fragment. */
export function takeMailFragment(path: '/verify-email' | '/recover') {
  const location = window.location;
  if (location.pathname.replace(/\/$/, '') !== path || !location.hash) return '';
  const candidate = location.hash.slice(1);
  window.history.replaceState(window.history.state, '', location.pathname + location.search);
  return /^[a-f0-9]{64}$/.test(candidate) ? candidate : '';
}

const emailDestinationKey = 'cswatch.email-onboarding-destination';

export function rememberEmailDestination(userId: string, route: string) {
  const url = new URL(safeAuthReturnPath(route), window.location.origin);
  // Keep only the application view in this tab. Query strings and fragments can carry private data.
  try {
    sessionStorage.setItem(
      emailDestinationKey,
      JSON.stringify({ userId, path: url.pathname, expires: Date.now() + 30 * 60_000 }),
    );
  } catch {
    /* A browser without tab storage can continue to the library. */
  }
}
export function emailDestination(userId: string) {
  try {
    const record = JSON.parse(sessionStorage.getItem(emailDestinationKey) || 'null');
    if (record?.userId === userId && record.expires > Date.now())
      return safeAuthReturnPath(record.path);
  } catch {
    /* The link remains usable when the browser blocks tab storage. */
  }
  return '/library';
}
export function forgetEmailDestination() {
  try {
    sessionStorage.removeItem(emailDestinationKey);
  } catch {}
}
