import { safeAuthReturnPath } from '../../shared/auth-navigation.mjs';
export { safeAuthReturnPath as authReturnPath } from '../../shared/auth-navigation.mjs';

export function authPath(mode: 'login' | 'register', returnTo: unknown) {
  return `/${mode}?${new URLSearchParams({ returnTo: safeAuthReturnPath(returnTo) })}`;
}
