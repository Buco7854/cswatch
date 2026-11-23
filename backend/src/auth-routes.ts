import type { FastifyRequest } from 'fastify';

type RouteContext = Pick<FastifyRequest, 'method' | 'routeOptions'>;
type Entry = 'status' | 'setup' | 'anonymous' | 'challenge' | 'enroll' | 'full' | 'logout';
declare module 'fastify' {
  interface FastifyContextConfig {
    accountEntry?: Entry;
    accountOnboarding?: boolean;
  }
}

/** Routes without an entry declaration cannot be reached with a limited session.
 * Transactions still recheck the live session immediately before granting access. */
export const accountEntry = (level: Entry, onboarding = false) => ({
  config: { accountEntry: level, accountOnboarding: onboarding },
});
export const allowedBeforeSetup = (r: RouteContext) =>
  r.routeOptions.config?.accountEntry === 'status' ||
  r.routeOptions.config?.accountEntry === 'setup';
export const allowedAnonymous = (r: RouteContext) => {
  const level = r.routeOptions.config?.accountEntry;
  return allowedBeforeSetup(r) || level === 'anonymous' || level === 'logout';
};
export const allowedPending = (r: RouteContext, stage: 'challenge' | 'enroll') => {
  const level = r.routeOptions.config?.accountEntry;
  return level === 'status' || level === 'logout' || level === stage;
};
export const allowedAccountOnboarding = (r: RouteContext) => {
  const config = r.routeOptions.config;
  return (
    config?.accountEntry === 'status' ||
    config?.accountEntry === 'logout' ||
    config?.accountOnboarding === true
  );
};

export const isRead = (r: Pick<FastifyRequest, 'method'>) =>
  r.method === 'GET' || r.method === 'HEAD';
const publicPages = new Set([
  '/',
  '/library',
  '/login',
  '/register',
  '/recover',
  '/verify-email',
  '/setup',
  '/account',
  '/account/connections',
  '/account/sessions',
  '/admin',
]);
const pendingPages = new Set([
  '/recover',
  '/verify-email',
  '/',
  '/login',
  '/register',
  '/setup',
  '/account',
]);
export function authShellRoute(r: RouteContext, path: string, pending: boolean) {
  if (!isRead(r)) return false;
  if (r.routeOptions.url === '/assets/*' || path === '/licenses/provider-brands.txt') return true;
  const page = path.replace(/([^/])\/$/, '$1');
  return pending
    ? pendingPages.has(page)
    : publicPages.has(page) || /^\/watch\/[A-Za-z0-9_-]+$/.test(page);
}
