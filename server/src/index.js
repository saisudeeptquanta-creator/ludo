/**
 * Server entry point: HTTP + Socket.IO on one port.
 *
 * In production it also serves the built client, so the whole game is one
 * process on one port — which is what makes "open it on your phone" trivial.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import { SERVER, RATE_LIMITS, IS_PROD } from './config/index.js';
import { migrate } from './db/migrate.js';
import { closeDb } from './db/index.js';
import routes from './routes/index.js';
import { rateLimit, notFoundHandler, errorHandler } from './middleware/index.js';
import { corsOriginCallback } from './utils/origins.js';
import { createSocketServer } from './socket/index.js';
import { purgeStaleRooms } from './services/room.service.js';
import { logger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, '..', '..', 'client', 'dist');

migrate();

const app = express();
if (SERVER.trustProxy) app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // The game is designed to be added to a phone home screen and run
    // fullscreen; a restrictive COEP breaks that with no benefit here.
    crossOriginEmbedderPolicy: false,
  }),
);
/**
 * CORS guards the API only.
 *
 * Applying it globally also gated the app's own JavaScript and CSS: a browser
 * sends an Origin header for those subresources, and in production the allow
 * list is empty (the client is served same-origin), so every asset 403'd and
 * the page rendered blank. Static files are public by nature and carry no
 * credentials, so they need no origin check.
 */
// `cors` does not hand the request to the origin callback, so it is bound per
// request here — the Host header is what identifies a same-origin call.
app.use(
  '/api',
  cors((req, done) => {
    done(null, {
      origin: (origin, cb) => corsOriginCallback(origin, cb, req),
      credentials: true,
    });
  }),
);
app.use(express.json({ limit: '32kb' }));
app.use('/api', rateLimit({ ...RATE_LIMITS.api, key: (req) => `api:${req.ip}` }));
app.use('/api', routes);

// Serve the built client when it exists, so `npm start` runs the whole game.
if (fs.existsSync(CLIENT_DIST)) {
  app.use(
    express.static(CLIENT_DIST, {
      index: false,
      // Asset filenames are content-hashed by Vite, so they can be cached hard.
      // index.html must NOT be: it is what points at the current hashes, and
      // caching it would pin returning players to a stale build forever.
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (IS_PROD && filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
  logger.info('server.serving_client', { dir: CLIENT_DIST });
}

app.use(notFoundHandler);
app.use(errorHandler);

const server = http.createServer(app);
const { io, dispose: disposeSockets } = createSocketServer(server);

const housekeeping = setInterval(() => {
  try {
    const closed = purgeStaleRooms();
    if (closed) logger.debug('housekeeping', { roomsClosed: closed });
  } catch (err) {
    logger.error('housekeeping.failed', { err });
  }
}, 10 * 60_000);
housekeeping.unref();

server.listen(SERVER.port, SERVER.host, () => {
  logger.info('server.listening', {
    url: `http://localhost:${SERVER.port}`,
    env: process.env.NODE_ENV ?? 'development',
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutting_down', { signal });

  clearInterval(housekeeping);
  disposeSockets();
  io.close();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('unhandled_rejection', { err: reason }));
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { err });
  shutdown('uncaughtException');
});

export { app, server, io };
