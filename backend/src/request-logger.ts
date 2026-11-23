import Fastify, { type FastifyRequest, type FastifyServerOptions } from 'fastify';

type LoggerOptions = Exclude<NonNullable<FastifyServerOptions['logger']>, boolean>;
type Serializer = NonNullable<LoggerOptions['serializers']>[string];

const diagnosticCodes = new Set([
  ...Object.keys(Fastify.errorCodes),
  'EACCES',
  'ECONNRESET',
  'EIO',
  'ENOENT',
  'ENOSPC',
  'EPIPE',
  'ERR_HTTP_REQUEST_TIMEOUT',
  'ERR_SQLITE_ERROR',
  'HPE_HEADER_OVERFLOW',
  'HPE_INVALID_CHUNK_SIZE',
  'HPE_INVALID_CONTENT_LENGTH',
  'HPE_INVALID_HEADER_TOKEN',
  'HPE_INVALID_METHOD',
  'HPE_INVALID_TRANSFER_ENCODING',
  'HPE_INVALID_URL',
  'HPE_INVALID_VERSION',
  'HPE_UNEXPECTED_CONTENT_LENGTH',
]);

const serializers: Record<string, Serializer> = {
  req: (r: FastifyRequest) => ({
    method: r.method,
    url: r.url?.split('?')[0],
    host: r.hostname,
    remoteAddress: r.ip,
  }),
  // Node and Fastify errors can carry request data in buffers and nested objects.
  err: (error: unknown) => {
    if (!error || typeof error !== 'object') return {};
    const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
    return {
      code: typeof code === 'string' && diagnosticCodes.has(code) ? code : undefined,
      statusCode:
        typeof statusCode === 'number' &&
        Number.isInteger(statusCode) &&
        statusCode >= 400 &&
        statusCode <= 599
          ? statusCode
          : undefined,
    };
  },
};

export function requestLogger(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      // The multipart plugin logs the raw request headers with its parser options.
      paths: ['req.headers', 'busboyOptions.headers'],
      remove: true,
    },
    serializers,
    hooks: {
      logMethod(args, method) {
        let [fields, message] = args;
        if (fields instanceof Error) fields = args[0] = { err: fields };
        if (fields && typeof fields === 'object' && 'err' in fields) {
          const error = fields.err as { message?: unknown } | null | undefined;
          // Pino lifts err.message into the log before the serializer runs.
          if (message === undefined || message === error?.message) args[1] = 'Error';
        }
        method.apply(this, args);
      },
    },
  };
}
