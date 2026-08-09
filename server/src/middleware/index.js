/**
 * Cross-cutting request middleware: validation, rate limiting and the error
 * boundary. Nothing here knows about Ludo — it is transport plumbing.
 */
import { ZodError } from 'zod';
import { AppError, badRequest, tooMany } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { IS_PROD } from '../config/index.js';

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Validates a request section against a Zod schema and REPLACES it with the
 * parsed result, so handlers only ever see values that passed validation.
 */
export const validate = (schema, section = 'body') => (req, _res, next) => {
  try {
    req[section] = schema.parse(req[section]);
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return next(
        badRequest('VALIDATION_FAILED', first?.message ?? 'Please check the form and try again.', {
          fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      );
    }
    next(err);
  }
};

/**
 * Fixed-window in-memory rate limiter. Adequate for a single-node deployment;
 * swap the Map for Redis to scale horizontally.
 */
export function rateLimit({ windowMs, max, key: keyFn }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(windowMs, 30_000));
  sweep.unref?.();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : `${req.ip}:${req.baseUrl}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));

    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return next(tooMany());
    }
    next();
  };
}

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`));
}

/**
 * The single error boundary. AppErrors carry player-safe copy; anything else is
 * a bug and is reported generically — stack traces never reach a client.
 */
export function errorHandler(err, req, res, _next) {
  const isApp = err instanceof AppError;
  const status = isApp ? err.status : 500;

  if (!isApp || status >= 500) {
    logger.error('request.failed', {
      err,
      method: req.method,
      path: req.originalUrl,
      userId: req.user?.id,
    });
  }

  const body = {
    error: {
      code: isApp ? err.code : 'INTERNAL_ERROR',
      message: isApp ? err.message : 'Something went wrong on our side. Please try again.',
    },
  };
  if (isApp && err.meta?.fields) body.error.fields = err.meta.fields;
  if (!IS_PROD && !isApp) body.error.debug = err.message;

  res.status(status).json(body);
}
