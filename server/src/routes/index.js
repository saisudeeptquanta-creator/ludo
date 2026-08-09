/**
 * REST surface.
 *
 * Gameplay is socket-only — it must be broadcast, and an HTTP endpoint would
 * offer a second, easier-to-script path to the same state. What is left is a
 * health check and the client's rule/config bootstrap.
 */
import { Router } from 'express';
import { GAME_CONFIG } from '../config/index.js';
import { presence } from '../services/presence.service.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    online: presence.onlineCount(),
  });
});

/** Everything the client needs to render rules-consistent UI. */
router.get('/config', (_req, res) => {
  res.json({
    minPlayers: GAME_CONFIG.MIN_PLAYERS,
    maxPlayers: GAME_CONFIG.MAX_PLAYERS,
    tokenCount: GAME_CONFIG.TOKEN_COUNT,
    turnDurationMs: GAME_CONFIG.TURN_DURATION_MS,
    reconnectGraceMs: GAME_CONFIG.RECONNECT_GRACE_MS,
    startCountdownMs: GAME_CONFIG.START_COUNTDOWN_MS,
    colors: GAME_CONFIG.COLORS,
    seating: GAME_CONFIG.SEATING,
  });
});

export default router;
