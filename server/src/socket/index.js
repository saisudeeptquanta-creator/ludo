/**
 * Real-time layer.
 *
 * Contract: the client SENDS INTENT and RECEIVES FACTS. Every handler re-reads
 * authoritative state and calls a service that validates the action. Nothing a
 * client sends is trusted — not a dice value, not a token position, not a turn,
 * not a winner.
 *
 * Identity comes from the `deviceId` on the handshake. It is an identifier, not
 * a credential; it can only reclaim a seat in a room whose code its holder
 * already had.
 */
import { Server } from 'socket.io';
import { GAME_CONFIG, RATE_LIMITS } from '../config/index.js';
import { run } from '../db/index.js';
import { identify, publicPlayer, findById } from '../services/player.service.js';
import { presence } from '../services/presence.service.js';
import * as rooms from '../services/room.service.js';
import * as games from '../services/game.service.js';
import { AppError } from '../utils/errors.js';
import { isOriginAllowed, noteRejectedOrigin } from '../utils/origins.js';
import { logger } from '../utils/logger.js';
import { TurnScheduler } from './turn-scheduler.js';

const roomChannel = (roomId) => `room:${roomId}`;
const gameChannel = (gameId) => `game:${gameId}`;
const playerChannel = (playerId) => `player:${playerId}`;

/** Grace timers for players who dropped mid-game, keyed `gameId:playerId`. */
const disconnectTimers = new Map();

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    /**
     * Browsers send an Origin header on every WebSocket upgrade, including
     * same-origin ones. In production this server also serves the client, so
     * the allow list is normally empty — without resolving Origin against the
     * request's own Host, the deployment rejected its own socket with a 400
     * and the game never came online.
     *
     * `allowRequest` is used because it is the one hook guaranteed to receive
     * the request, regardless of Socket.IO's cors callback arity.
     */
    allowRequest: (req, done) => {
      const allowed = isOriginAllowed(req.headers.origin, req.headers.host ?? null);
      if (!allowed) noteRejectedOrigin(req.headers.origin);
      done(null, allowed);
    },
    cors: { origin: true, credentials: true },
    pingInterval: 20_000,
    pingTimeout: 20_000,
    // A brief blip resumes the same session without a full rejoin; longer
    // outages fall through to the reconnect handler.
    connectionStateRecovery: { maxDisconnectionDuration: 30_000, skipMiddlewares: false },
  });

  const scheduler = new TurnScheduler((gameId, turnNumber) => {
    const result = games.applyTimeout({ gameId, expectedTurnNumber: turnNumber });
    if (!result) return;
    broadcastGame(io, gameId, result);
    scheduler.sync(result.state);
  });

  // ------------------------------------------------------------ identity --
  io.use((socket, next) => {
    try {
      const { deviceId, name, avatar } = socket.handshake.auth ?? {};
      const player = identify({ deviceId, name, avatar: Number(avatar) || 0 });
      socket.data.playerId = player.id;
      socket.data.name = player.name;
      next();
    } catch (err) {
      logger.warn('socket.identify_failed', { message: err.message });
      next(new Error(err.code === 'INVALID_NAME' ? 'INVALID_NAME' : 'IDENTIFY_FAILED'));
    }
  });

  io.on('connection', (socket) => {
    const playerId = socket.data.playerId;
    presence.connect(playerId, socket.id);
    socket.join(playerChannel(playerId));

    // Tell the client where it left off, so a reload lands back in the game.
    const activeGameId = games.activeGameFor(playerId);
    socket.emit('session_ready', {
      player: publicPlayer(findById(playerId)),
      activeGameId,
      room: rooms.currentRoomFor(playerId),
      serverTime: Date.now(),
    });

    const limiter = makeLimiter();

    const on = (event, handler, limit = RATE_LIMITS.socketAction) =>
      socket.on(event, async (payload, ack) => {
        try {
          if (!limiter(event, limit)) {
            throw new AppError(429, 'RATE_LIMITED', 'Slow down a moment and try again.');
          }
          const result = await handler(payload ?? {});
          if (typeof ack === 'function') ack({ ok: true, data: result ?? null });
        } catch (err) {
          const isApp = err instanceof AppError;
          if (!isApp) logger.error(`socket.${event}_failed`, { err, playerId });
          const body = {
            ok: false,
            error: {
              code: isApp ? err.code : 'INTERNAL_ERROR',
              message: isApp ? err.message : 'Something went wrong. Please try again.',
            },
          };
          if (typeof ack === 'function') ack(body);
          else socket.emit('action_error', { event, ...body.error });
        }
      });

    // --------------------------------------------------------------- room --

    on('room:create', async ({ maxPlayers = 4 }) => {
      const state = rooms.createRoom(playerId, { maxPlayers: Number(maxPlayers) || 4 });
      socket.join(roomChannel(state.id));
      return state;
    });

    on('room:join', async ({ code, roomId }) => {
      const state = rooms.joinRoom({ code, roomId, playerId });
      socket.join(roomChannel(state.id));
      const player = publicPlayer(findById(playerId));
      io.to(roomChannel(state.id)).emit('room:updated', {
        room: state,
        message: `${player.name} joined`,
        joinedId: playerId,
      });
      return state;
    });

    on('room:leave', async ({ roomId }) => {
      const player = publicPlayer(findById(playerId));
      const result = rooms.leaveRoom(roomId, playerId);
      socket.leave(roomChannel(roomId));
      io.to(roomChannel(roomId)).emit('room:updated', {
        room: result.room,
        closed: result.closed,
        newHostId: result.newHostId,
        message: `${player.name} left`,
        leftId: playerId,
      });
      return { left: true };
    });

    on('room:ready', async ({ roomId, isReady }) => {
      const state = rooms.setReady(roomId, playerId, Boolean(isReady));
      io.to(roomChannel(roomId)).emit('room:updated', { room: state });
      return state;
    });

    on('room:settings', async ({ roomId, settings }) => {
      const state = rooms.updateSettings(roomId, playerId, settings ?? {});
      io.to(roomChannel(roomId)).emit('room:updated', {
        room: state,
        message: 'Host changed the rules',
      });
      return state;
    });

    on('room:kick', async ({ roomId, targetId }) => {
      const result = rooms.kickPlayer(roomId, playerId, targetId);
      io.to(playerChannel(targetId)).emit('room:kicked', { roomId });
      for (const sid of presence.socketsFor(targetId)) {
        io.sockets.sockets.get(sid)?.leave(roomChannel(roomId));
      }
      io.to(roomChannel(roomId)).emit('room:updated', { room: result.room });
      return result.room;
    });

    // --------------------------------------------------------------- game --

    on('game:start', async ({ roomId }) => {
      const { state: lobby } = rooms.assertCanStart(roomId, playerId);
      const state = games.startGame({ roomId, members: lobby.players, settings: lobby.settings });

      // Move every lobby member's sockets into the game channel.
      for (const p of lobby.players) {
        for (const sid of presence.socketsFor(p.id)) {
          io.sockets.sockets.get(sid)?.join(gameChannel(state.id));
        }
      }

      io.to(roomChannel(roomId)).emit('game:countdown', {
        gameId: state.id,
        countdownMs: GAME_CONFIG.START_COUNTDOWN_MS,
        startsAt: Date.now() + GAME_CONFIG.START_COUNTDOWN_MS,
      });

      // The board goes live after the 3-2-1; the clock starts from that moment
      // so a stalled client cannot delay everyone else.
      setTimeout(() => {
        const fresh = games.loadState(state.id);
        if (!fresh) return;
        const deadline = Date.now() + fresh.config.TURN_DURATION_MS;
        startTurnClock(state.id, deadline);
        scheduler.arm(state.id, fresh.turnNumber, deadline);
        emitPersonalisedState(io, state.id, 'game:started');
      }, GAME_CONFIG.START_COUNTDOWN_MS);

      return { gameId: state.id };
    });

    on('game:join', async ({ gameId }) => {
      const state = games.loadState(gameId);
      if (!state) throw new AppError(404, 'GAME_NOT_FOUND', 'Game no longer exists.');
      if (games.seatOf(state, playerId) === null) {
        throw new AppError(403, 'NOT_IN_GAME', 'You are not a player in this game.');
      }

      socket.join(gameChannel(gameId));
      cancelDisconnectTimer(gameId, playerId);

      const result = games.setPlayerConnected({ gameId, playerId, connected: true });
      if (result) {
        io.to(gameChannel(gameId)).emit('game:presence', {
          playerId,
          seat: games.seatOf(result.state, playerId),
          connected: true,
        });
        emitPersonalisedState(io, gameId, 'game:state');
      }
      scheduler.sync(games.loadState(gameId));
      return games.gameDtoFor(gameId, playerId);
    });

    /** Reconnect catch-up: missed events, or a fresh snapshot if too far behind. */
    on('game:sync', async ({ gameId, lastStateVersion = 0 }) => {
      const state = games.loadState(gameId);
      if (!state) throw new AppError(404, 'GAME_NOT_FOUND', 'Game no longer exists.');
      if (games.seatOf(state, playerId) === null) {
        throw new AppError(403, 'NOT_IN_GAME', 'You are not a player in this game.');
      }
      const gap = state.stateVersion - lastStateVersion;
      return {
        snapshot: games.gameDto(state, playerId),
        events: gap > 0 && gap <= 200 ? games.eventsSince(gameId, lastStateVersion) : [],
        resynced: gap > 200 || lastStateVersion === 0,
      };
    });

    on('game:roll', async ({ gameId }) => {
      const result = games.rollDice({ gameId, playerId });
      broadcastGame(io, gameId, result);
      scheduler.sync(result.state);
      // Report the value actually rolled: a roll with no legal move passes the
      // turn and clears the dice from state.
      const rolled = result.events.find((e) => e.type === 'DICE_ROLLED');
      return { diceValue: rolled?.value ?? null, moves: result.moves?.length ?? 0 };
    });

    on('game:move', async ({ gameId, tokenIndex }) => {
      const result = games.moveToken({ gameId, playerId, tokenIndex: Number(tokenIndex) });
      broadcastGame(io, gameId, result);
      scheduler.sync(result.state);
      return { moved: true };
    });

    on('game:leave', async ({ gameId }) => {
      const result = games.removePlayer({ gameId, playerId, reason: 'left' });
      socket.leave(gameChannel(gameId));
      if (result) {
        broadcastGame(io, gameId, result);
        scheduler.sync(result.state);
      }
      return { left: true };
    });

    on('game:emote', async ({ gameId, emote }) => {
      const allowed = ['😂', '🔥', '😎', '👏', '😱', '🎉', '😡', '👍'];
      if (!allowed.includes(emote)) throw new AppError(400, 'INVALID_EMOTE', 'Unknown emote.');
      const state = games.loadState(gameId);
      if (!state || games.seatOf(state, playerId) === null) {
        throw new AppError(403, 'NOT_IN_GAME', 'You are not a player in this game.');
      }
      io.to(gameChannel(gameId)).emit('game:emote', {
        playerId,
        seat: games.seatOf(state, playerId),
        emote,
      });
      return { sent: true };
    }, RATE_LIMITS.chat);

    // --------------------------------------------------------- disconnect --

    socket.on('disconnect', () => {
      const wasLast = presence.disconnect(playerId, socket.id);
      if (!wasLast) return; // another tab is still open

      const gameId = games.activeGameFor(playerId);
      if (gameId) {
        const result = games.setPlayerConnected({ gameId, playerId, connected: false });
        if (result) {
          io.to(gameChannel(gameId)).emit('game:presence', {
            playerId,
            seat: games.seatOf(result.state, playerId),
            connected: false,
            graceMs: GAME_CONFIG.RECONNECT_GRACE_MS,
          });
        }
        startDisconnectTimer(io, scheduler, gameId, playerId);
      }

      // In a lobby, leaving is immediate — nothing is at stake yet.
      const room = rooms.currentRoomFor(playerId);
      if (room && room.status === 'open') {
        const player = publicPlayer(findById(playerId));
        const result = rooms.leaveRoom(room.id, playerId);
        io.to(roomChannel(room.id)).emit('room:updated', {
          room: result.room,
          closed: result.closed,
          newHostId: result.newHostId,
          message: `${player?.name ?? 'A player'} left`,
          leftId: playerId,
        });
      }
    });
  });

  io.engine.on('connection_error', (err) => {
    logger.warn('socket.connection_error', { code: err.code, message: err.message });
  });

  function dispose() {
    scheduler.clearAll();
    for (const timer of disconnectTimers.values()) clearTimeout(timer);
    disconnectTimers.clear();
  }

  return { io, scheduler, dispose };
}

// ------------------------------------------------------------- helpers ---

/**
 * Restarts the turn clock when the 3-2-1 countdown ends, so the first player
 * gets a full turn rather than one already three seconds old.
 */
function startTurnClock(gameId, deadline) {
  run(
    'UPDATE games SET turn_started_at = ?, turn_deadline_at = ? WHERE id = ?',
    new Date().toISOString(),
    new Date(deadline).toISOString(),
    gameId,
  );
}

/**
 * Sends each player their own view. The DTO carries only the recipient's legal
 * moves, so no client learns another player's options from the wire.
 */
function emitPersonalisedState(io, gameId, event) {
  const state = games.loadState(gameId);
  if (!state) return;
  for (const p of state.players) {
    io.to(playerChannel(p.userId)).emit(event, games.gameDto(state, p.userId));
  }
}

function broadcastGame(io, gameId, result) {
  io.to(gameChannel(gameId)).emit('game:events', {
    gameId,
    stateVersion: result.state.stateVersion,
    events: result.events,
  });
  emitPersonalisedState(io, gameId, 'game:state');

  if (result.state.status === 'finished' || result.state.status === 'cancelled') {
    io.to(gameChannel(gameId)).emit('game:finished', games.gameResults(gameId));
  }
}

function startDisconnectTimer(io, scheduler, gameId, playerId) {
  const key = `${gameId}:${playerId}`;
  cancelDisconnectTimer(gameId, playerId);
  const timer = setTimeout(() => {
    disconnectTimers.delete(key);
    if (presence.isOnline(playerId)) return; // came back on another socket
    const result = games.removePlayer({ gameId, playerId, reason: 'left' });
    if (result) {
      broadcastGame(io, gameId, result);
      scheduler.sync(result.state);
    }
  }, GAME_CONFIG.RECONNECT_GRACE_MS);
  timer.unref?.();
  disconnectTimers.set(key, timer);
}

function cancelDisconnectTimer(gameId, playerId) {
  const key = `${gameId}:${playerId}`;
  const timer = disconnectTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(key);
  }
}

/** Per-socket, per-event fixed-window limiter. */
function makeLimiter() {
  const windows = new Map();
  return (event, { windowMs, max }) => {
    const now = Date.now();
    let w = windows.get(event);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      windows.set(event, w);
    }
    w.count += 1;
    return w.count <= max;
  };
}
