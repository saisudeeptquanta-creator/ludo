/**
 * Browser origin policy, shared by the REST API and the socket server.
 *
 * Development and production want genuinely different behaviour:
 *
 *  - In development the dev server's port is not stable (Vite silently moves to
 *    5174 if 5173 is taken), and testing on a phone means hitting the machine's
 *    LAN address. Pinning an exact list there produces mystifying failures on
 *    every request, so local and private-network origins are allowed on any port.
 *
 *  - In production only the configured origins are allowed, full stop.
 *
 * A rejection is a client mistake, not a server fault: it produces a 403 that
 * names the offending origin and the variable to set, instead of a generic 500.
 */
import { SERVER, IS_PROD } from '../config/index.js';
import { forbidden } from './errors.js';
import { logger } from './logger.js';

/** Hostnames that always mean "this machine". */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** RFC1918 + link-local ranges — a phone on the same Wi-Fi. */
function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (LOCAL_HOSTNAMES.has(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h.endsWith('.local')) return true;
  return false;
}

/** Normalises to scheme://host:port so trailing slashes never cause a mismatch. */
function normalize(value) {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return null;
  }
}

const ALLOWED = new Set(SERVER.corsOrigins.map(normalize).filter(Boolean));

const rejected = new Set();

/**
 * @param {string|undefined} origin
 * @returns {boolean} whether this origin may call the API.
 */
export function isOriginAllowed(origin, host = null) {
  // Non-browser clients (curl, server-to-server) send no Origin header.
  if (!origin) return true;

  const normalized = normalize(origin);
  if (!normalized) return false;
  if (ALLOWED.has(normalized)) return true;

  /**
   * Same-origin requests are always allowed.
   *
   * Browsers DO send an Origin header for WebSocket upgrades and for
   * subresources, even when the target is the very page that requested them.
   * In production the client is served by this same server, so the allow list
   * is normally empty — without this check the app's own socket connection was
   * rejected with a 400 and the game never came online.
   */
  if (host) {
    try {
      if (new URL(normalized).host === host) return true;
    } catch {
      /* fall through to the deny path */
    }
  }

  if (!IS_PROD) {
    try {
      const { hostname, protocol } = new URL(normalized);
      if ((protocol === 'http:' || protocol === 'https:') && isPrivateHost(hostname)) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

/** Logs each unfamiliar origin once, with the fix, rather than on every request. */
export function noteRejectedOrigin(origin) {
  if (!origin || rejected.has(origin)) return;
  rejected.add(origin);
  logger.warn('cors.origin_rejected', {
    origin,
    allowed: [...ALLOWED],
    hint: 'Add it to CORS_ORIGINS in server/.env (comma-separated) and restart.',
  });
}

/**
 * The `origin` callback shape both `cors` and Socket.IO accept.
 *
 * Both pass the request as an optional third argument, which is where the Host
 * header comes from — that is what lets a same-origin request through without
 * needing the deployment's public URL configured anywhere.
 */
export function corsOriginCallback(origin, callback, req = null) {
  const host = req?.headers?.host ?? null;
  if (isOriginAllowed(origin, host)) return callback(null, true);
  noteRejectedOrigin(origin);
  // Report it as the client-side problem it is, with an actionable message.
  callback(
    forbidden(
      'ORIGIN_NOT_ALLOWED',
      `This app is not permitted to call the API from ${origin}. ` +
        'Add that address to CORS_ORIGINS in server/.env and restart the server.',
    ),
  );
}
