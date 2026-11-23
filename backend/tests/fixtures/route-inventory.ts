import { channel } from 'node:diagnostics_channel';
import type { FastifyInstance, HTTPMethods } from 'fastify';

/** Observe actual matched routes, including Fastify's automatic HEAD siblings. */
export async function withRouteInventory(
  create: () => Promise<FastifyInstance>,
  register?: (app: FastifyInstance) => void,
) {
  const routes: { method: HTTPMethods; path: string }[] = [];
  const initialized = channel('fastify.initialization');
  const capture = (event: unknown) => {
    const { fastify } = event as { fastify: FastifyInstance };
    fastify.addHook('onRoute', (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method])
        routes.push({ method, path: route.url });
    });
    register?.(fastify);
  };
  initialized.subscribe(capture);
  try {
    const app = await create();
    await app.ready();
    return { app, routes };
  } finally {
    initialized.unsubscribe(capture);
  }
}
