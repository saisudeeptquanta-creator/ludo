/**
 * Rooms and games over REST.
 *
 * Gameplay itself (roll, move) is socket-only — it must be broadcast, and an
 * HTTP endpoint would offer a second, easier-to-script path to the same state.
 * These routes cover creation, listing and history.
 */
import { Router } from 'express';
import { z } from 'zod';
import * as rooms from '../services/room.service.js';
import * as games from '../services/game.service.js';
import { asyncRoute, validate } from '../middleware/index.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, forbidden, MESSAGES } from '../utils/errors.js';
import { GAME_CONFIG, CHAT } from '../config/index.js';

const router = Router();
router.use(requireAuth);

const idParam = z.object({ id: z.coerce.number().int().positive() });

const settingsSchema = z.object({
  turnDurationMs: z.coerce.number().int().min(5_000).max(120_000).optional(),
  extraTurnOnSix: z.boolean().optional(),
  extraTurnOnCapture: z.boolean().optional(),
  stackingEnabled: z.boolean().optional(),
  safeCellsEnabled: z.boolean().optional(),
  blockingEnabled: z.boolean().optional(),
});

// ------------------------------------------------------------------ rooms --

router.post(
  '/rooms',
  validate(
    z.object({
      maxPlayers: z.coerce.number().int().min(2).max(4).default(4),
      settings: settingsSchema.optional(),
    }),
  ),
  asyncRoute(async (req, res) => {
    res.status(201).json({ room: rooms.createRoom(req.user.id, req.body) });
  }),
);

router.post(
  '/rooms/join',
  validate(z.object({ code: z.string().min(3).max(20) })),
  asyncRoute(async (req, res) => {
    res.json({ room: rooms.joinRoom({ code: req.body.code, userId: req.user.id }) });
  }),
);

router.get(
  '/rooms/current',
  asyncRoute(async (req, res) => {
    res.json({ room: rooms.currentRoomFor(req.user.id) });
  }),
);

router.get(
  '/rooms/:id',
  validate(idParam, 'params'),
  asyncRoute(async (req, res) => {
    const room = rooms.roomState(req.params.id);
    if (!room) throw notFound('ROOM_NOT_FOUND', MESSAGES.ROOM_NOT_FOUND);
    if (!rooms.isMember(room.id, req.user.id)) {
      throw forbidden('NOT_IN_ROOM', 'You are not in this room.');
    }
    res.json({ room });
  }),
);

router.patch(
  '/rooms/:id/settings',
  validate(idParam, 'params'),
  validate(settingsSchema.extend({ maxPlayers: z.coerce.number().int().min(2).max(4).optional() })),
  asyncRoute(async (req, res) => {
    res.json({ room: rooms.updateSettings(req.params.id, req.user.id, req.body) });
  }),
);

router.post(
  '/rooms/:id/leave',
  validate(idParam, 'params'),
  asyncRoute(async (req, res) => {
    res.json(rooms.leaveRoom(req.params.id, req.user.id));
  }),
);

// ------------------------------------------------------------ invitations --

router.get(
  '/invitations',
  asyncRoute(async (req, res) => {
    res.json({ invitations: rooms.listInvitations(req.user.id) });
  }),
);

router.post(
  '/invitations',
  validate(
    z.object({
      roomId: z.coerce.number().int().positive(),
      userId: z.coerce.number().int().positive(),
    }),
  ),
  asyncRoute(async (req, res) => {
    res.status(201).json({
      invitation: rooms.inviteToRoom({
        roomId: req.body.roomId,
        senderId: req.user.id,
        receiverId: req.body.userId,
      }),
    });
  }),
);

router.post(
  '/invitations/:id/respond',
  validate(idParam, 'params'),
  validate(z.object({ accept: z.boolean() })),
  asyncRoute(async (req, res) => {
    res.json(
      rooms.respondToInvitation({
        invitationId: req.params.id,
        userId: req.user.id,
        accept: req.body.accept,
      }),
    );
  }),
);

router.delete(
  '/invitations/:id',
  validate(idParam, 'params'),
  asyncRoute(async (req, res) => {
    res.json(rooms.cancelInvitation({ invitationId: req.params.id, userId: req.user.id }));
  }),
);

// ------------------------------------------------------------------ games --

router.get(
  '/games/active',
  asyncRoute(async (req, res) => {
    const gameId = games.activeGameFor(req.user.id);
    res.json({ game: gameId ? games.gameDtoFor(gameId, req.user.id) : null });
  }),
);

router.get(
  '/games/history',
  validate(
    z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    'query',
  ),
  asyncRoute(async (req, res) => {
    res.json({ games: games.gameHistory(req.user.id, req.query) });
  }),
);

router.get(
  '/games/:id',
  validate(idParam, 'params'),
  asyncRoute(async (req, res) => {
    const dto = games.gameDtoFor(req.params.id, req.user.id);
    if (!dto) throw notFound('GAME_NOT_FOUND', MESSAGES.GAME_NOT_FOUND);
    if (!dto.you) throw forbidden('NOT_IN_GAME', MESSAGES.NOT_IN_GAME);
    res.json({ game: dto });
  }),
);

router.get(
  '/games/:id/details',
  validate(idParam, 'params'),
  asyncRoute(async (req, res) => {
    res.json({ match: games.matchDetails(req.params.id, req.user.id) });
  }),
);

// ----------------------------------------------------------------- config --

/** Everything the client needs to render rules-consistent UI. */
router.get(
  '/config',
  asyncRoute(async (_req, res) => {
    res.json({
      minPlayers: GAME_CONFIG.MIN_PLAYERS,
      maxPlayers: GAME_CONFIG.MAX_PLAYERS,
      tokenCount: GAME_CONFIG.TOKEN_COUNT,
      turnDurationMs: GAME_CONFIG.TURN_DURATION_MS,
      reconnectGraceMs: GAME_CONFIG.RECONNECT_GRACE_MS,
      startCountdownMs: GAME_CONFIG.START_COUNTDOWN_MS,
      colors: GAME_CONFIG.COLORS,
      seating: GAME_CONFIG.SEATING,
      quickMessages: CHAT.quickMessages,
      emotes: CHAT.emotes,
    });
  }),
);

export default router;
