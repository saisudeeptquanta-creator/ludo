/**
 * Structured logger. Emits one JSON line per event in production and a compact
 * coloured line in development. Credentials are never passed in — callers log
 * identifiers, not secrets.
 */
import { IS_PROD } from '../config/index.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL ?? (IS_PROD ? 'info' : 'debug')] ?? 20;

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

/** Keys that must never reach the log sink even if a caller passes them. */
const REDACT = new Set([
  'password',
  'confirmPassword',
  'passwordHash',
  'password_hash',
  'token',
  'tokenHash',
  'sessionToken',
  'authorization',
  'cookie',
]);

function sanitize(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = Array.isArray(meta) ? [] : {};
  for (const [k, v] of Object.entries(meta)) {
    if (REDACT.has(k)) out[k] = '[redacted]';
    else if (v && typeof v === 'object' && !(v instanceof Date)) out[k] = sanitize(v);
    else out[k] = v;
  }
  return out;
}

function emit(level, event, meta) {
  if (LEVELS[level] < MIN) return;
  const clean = sanitize(meta);
  if (IS_PROD) {
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...clean })}\n`,
    );
  } else {
    const detail = clean && Object.keys(clean).length ? ` ${JSON.stringify(clean)}` : '';
    process.stdout.write(
      `${COLORS[level]}${level.padEnd(5)}${RESET} ${event}${detail}\n`,
    );
  }
}

export const logger = {
  debug: (event, meta) => emit('debug', event, meta),
  info: (event, meta) => emit('info', event, meta),
  warn: (event, meta) => emit('warn', event, meta),
  error: (event, meta) => {
    if (meta instanceof Error) {
      emit('error', event, { message: meta.message, stack: meta.stack });
    } else if (meta?.err instanceof Error) {
      const { err, ...rest } = meta;
      emit('error', event, { ...rest, message: err.message, stack: err.stack });
    } else {
      emit('error', event, meta);
    }
  },
};
