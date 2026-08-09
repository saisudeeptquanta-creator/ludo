/**
 * Rooms — the only way a game is created.
 *
 * A room is a lobby of up to four seats. Seat order maps to board colour when
 * the host starts, so it is meaningful, not cosmetic.
 */
import { get, query, run, transaction } from '../db/index.js';
import { GAME_CONFIG, ROOM } from '../config/index.js';
import { roomCode, normalizeRoomCode, displayRoomCode } from '../utils/ids.js';
import { publicPlayer } from './player.service.js';
import { presence } from './presence.service.js';
import { badRequest, conflict, notFound, forbidden, MESSAGES } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export const findRoomById = (roomId) =>
  get("SELECT * FROM rooms WHERE id = ? AND status <> 'closed'", roomId);

export function findRoomByCode(code) {
  const normalized = normalizeRoomCode(code);
  if (!normalized) return null;
  return get("SELECT * FROM rooms WHERE code = ? AND status <> 'closed'", normalized);
}

export const roomMembers = (roomId) =>
  query(
    `SELECT rp.seat, rp.is_ready, rp.joined_at, p.id, p.name, p.avatar
       FROM room_players rp
       JOIN players p ON p.id = rp.player_id
      WHERE rp.room_id = ? AND rp.left_at IS NULL
      ORDER BY rp.seat`,
    roomId,
  );

export const isMember = (roomId, playerId) =>
  Boolean(
    get(
      'SELECT 1 AS x FROM room_players WHERE room_id = ? AND player_id = ? AND left_at IS NULL',
      roomId,
      playerId,
    ),
  );

function defaultSettings() {
  return {
    turnDurationMs: GAME_CONFIG.TURN_DURATION_MS,
    extraTurnOnSix: GAME_CONFIG.EXTRA_TURN_ON_SIX,
    extraTurnOnCapture: GAME_CONFIG.EXTRA_TURN_ON_CAPTURE,
    stackingEnabled: GAME_CONFIG.STACKING_ENABLED,
    safeCellsEnabled: GAME_CONFIG.SAFE_CELLS_ENABLED,
    blockingEnabled: GAME_CONFIG.BLOCKING_ENABLED,
    releaseOnAnyRollWhenStuck: GAME_CONFIG.RELEASE_ON_ANY_ROLL_WHEN_STUCK,
  };
}

function canStart(room, players) {
  if (room.status === 'in_game') return { ok: false, reason: 'Game already in progress.' };
  if (players.length < GAME_CONFIG.MIN_PLAYERS) {
    return { ok: false, reason: `Waiting for at least ${GAME_CONFIG.MIN_PLAYERS} players` };
  }
  if (!players.every((p) => p.isReady)) return { ok: false, reason: 'Waiting for everyone to be ready' };
  return { ok: true, reason: null };
}

/** Full lobby payload. Empty seats are included so the UI renders four slots. */
export function roomState(roomId) {
  const room = findRoomById(roomId);
  if (!room) return null;

  const members = roomMembers(roomId);
  const settings = { ...defaultSettings(), ...JSON.parse(room.settings_json || '{}') };
  const colors = GAME_CONFIG.SEATING[room.max_players] ?? GAME_CONFIG.COLORS;

  const players = members.map((m) => ({
    ...publicPlayer(m),
    seat: m.seat,
    color: colors[m.seat] ?? GAME_CONFIG.COLORS[m.seat],
    isReady: Boolean(m.is_ready),
    isHost: m.id === room.host_id,
    online: presence.isOnline(m.id),
  }));

  const slots = [];
  for (let seat = 0; seat < room.max_players; seat += 1) {
    slots.push(players.find((p) => p.seat === seat) ?? { seat, color: colors[seat], empty: true });
  }

  const check = canStart(room, players);
  return {
    id: room.id,
    code: room.code,
    displayCode: displayRoomCode(room.code),
    hostId: room.host_id,
    status: room.status,
    maxPlayers: room.max_players,
    gameId: room.game_id,
    settings,
    players,
    slots,
    playerCount: players.length,
    readyCount: players.filter((p) => p.isReady).length,
    canStart: check.ok,
    startBlockedReason: check.reason,
  };
}

export function createRoom(playerId, { maxPlayers = 4, settings = {} } = {}) {
  if (maxPlayers < GAME_CONFIG.MIN_PLAYERS || maxPlayers > GAME_CONFIG.MAX_PLAYERS) {
    throw badRequest('INVALID_SIZE', 'Rooms hold between 2 and 4 players.');
  }

  // One open room per host keeps stale lobbies from piling up.
  const existing = get("SELECT id FROM rooms WHERE host_id = ? AND status = 'open'", playerId);
  if (existing) leaveRoom(existing.id, playerId);

  return transaction(() => {
    let code = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = roomCode();
      if (!get("SELECT 1 AS x FROM rooms WHERE code = ? AND status <> 'closed'", candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) throw conflict('CODE_EXHAUSTED', 'Could not create a room. Please try again.');

    const res = run(
      'INSERT INTO rooms (code, host_id, max_players, settings_json) VALUES (?, ?, ?, ?)',
      code,
      playerId,
      maxPlayers,
      JSON.stringify({ ...defaultSettings(), ...settings }),
    );
    const roomId = Number(res.lastInsertRowid);
    run('INSERT INTO room_players (room_id, player_id, seat) VALUES (?, ?, 0)', roomId, playerId);
    logger.info('room.created', { roomId, code, hostId: playerId });
    return roomState(roomId);
  });
}

export function joinRoom({ code, roomId, playerId }) {
  return transaction(() => {
    const room = roomId ? findRoomById(roomId) : findRoomByCode(code);
    if (!room) throw notFound('ROOM_NOT_FOUND', MESSAGES.ROOM_NOT_FOUND);

    // Already seated: this is a refresh or a reconnect, not a new join.
    if (isMember(room.id, playerId)) return roomState(room.id);

    if (room.status === 'in_game') throw conflict('ROOM_STARTED', MESSAGES.ROOM_STARTED);

    const taken = new Set(roomMembers(room.id).map((m) => m.seat));
    if (taken.size >= room.max_players) throw conflict('ROOM_FULL', MESSAGES.ROOM_FULL);

    let seat = 0;
    while (taken.has(seat)) seat += 1;

    run(
      'INSERT INTO room_players (room_id, player_id, seat) VALUES (?, ?, ?)',
      room.id,
      playerId,
      seat,
    );
    run("UPDATE rooms SET updated_at = datetime('now') WHERE id = ?", room.id);
    logger.info('room.joined', { roomId: room.id, playerId, seat });
    return roomState(room.id);
  });
}

/**
 * Removes a member. If the host leaves, the lowest remaining seat takes over
 * rather than the room being destroyed.
 */
export function leaveRoom(roomId, playerId) {
  return transaction(() => {
    const room = findRoomById(roomId);
    if (!room) return { room: null, closed: true, newHostId: null };
    if (!isMember(roomId, playerId)) {
      return { room: roomState(roomId), closed: false, newHostId: null };
    }

    run(
      "UPDATE room_players SET left_at = datetime('now') WHERE room_id = ? AND player_id = ? AND left_at IS NULL",
      roomId,
      playerId,
    );

    const remaining = roomMembers(roomId);
    if (remaining.length === 0) {
      run("UPDATE rooms SET status = 'closed', closed_at = datetime('now') WHERE id = ?", roomId);
      return { room: null, closed: true, newHostId: null };
    }

    let newHostId = null;
    if (room.host_id === playerId) {
      newHostId = remaining[0].id;
      run("UPDATE rooms SET host_id = ?, updated_at = datetime('now') WHERE id = ?", newHostId, roomId);
      logger.info('room.host_transferred', { roomId, newHostId });
    }
    return { room: roomState(roomId), closed: false, newHostId };
  });
}

export function setReady(roomId, playerId, isReady) {
  if (!isMember(roomId, playerId)) throw forbidden('NOT_IN_ROOM', 'You are not in this room.');
  run(
    'UPDATE room_players SET is_ready = ? WHERE room_id = ? AND player_id = ? AND left_at IS NULL',
    isReady ? 1 : 0,
    roomId,
    playerId,
  );
  return roomState(roomId);
}

export function assertHost(roomId, playerId) {
  const room = findRoomById(roomId);
  if (!room) throw notFound('ROOM_NOT_FOUND', MESSAGES.ROOM_NOT_FOUND);
  if (room.host_id !== playerId) throw forbidden('NOT_HOST', 'Only the host can do that.');
  return room;
}

export function kickPlayer(roomId, hostId, targetId) {
  assertHost(roomId, hostId);
  if (hostId === targetId) throw badRequest('CANNOT_KICK_SELF', 'You cannot remove yourself.');
  if (!isMember(roomId, targetId)) throw notFound('NOT_IN_ROOM', 'They are not in this room.');
  return leaveRoom(roomId, targetId);
}

export function updateSettings(roomId, hostId, patch) {
  const room = assertHost(roomId, hostId);
  if (room.status !== 'open') throw conflict('ROOM_STARTED', MESSAGES.ROOM_STARTED);

  const next = { ...defaultSettings(), ...JSON.parse(room.settings_json || '{}') };

  if (patch.turnDurationMs !== undefined) {
    const ms = Number(patch.turnDurationMs);
    if (!Number.isFinite(ms) || ms < 5_000 || ms > 120_000) {
      throw badRequest('INVALID_SETTING', 'Turn time must be between 5 and 120 seconds.');
    }
    next.turnDurationMs = ms;
  }
  for (const key of [
    'extraTurnOnSix',
    'extraTurnOnCapture',
    'stackingEnabled',
    'safeCellsEnabled',
    'blockingEnabled',
    'releaseOnAnyRollWhenStuck',
  ]) {
    if (patch[key] !== undefined) next[key] = Boolean(patch[key]);
  }

  if (patch.maxPlayers !== undefined) {
    const max = Number(patch.maxPlayers);
    if (max < GAME_CONFIG.MIN_PLAYERS || max > GAME_CONFIG.MAX_PLAYERS) {
      throw badRequest('INVALID_SIZE', 'Rooms hold between 2 and 4 players.');
    }
    if (roomMembers(roomId).length > max) {
      throw conflict('TOO_MANY_PLAYERS', 'Remove a player before shrinking the room.');
    }
    run('UPDATE rooms SET max_players = ? WHERE id = ?', max, roomId);
  }

  run(
    "UPDATE rooms SET settings_json = ?, updated_at = datetime('now') WHERE id = ?",
    JSON.stringify(next),
    roomId,
  );
  // Changing the rules clears ready flags so nobody is surprised by new rules.
  run('UPDATE room_players SET is_ready = 0 WHERE room_id = ? AND left_at IS NULL', roomId);
  return roomState(roomId);
}

export function assertCanStart(roomId, hostId) {
  const room = assertHost(roomId, hostId);
  const state = roomState(roomId);
  const check = canStart(room, state.players);
  if (!check.ok) throw conflict('CANNOT_START', check.reason);
  return { room, state };
}

/** The room a player currently occupies, if any — drives resume-on-reload. */
export function currentRoomFor(playerId) {
  const row = get(
    `SELECT r.id FROM rooms r
       JOIN room_players rp ON rp.room_id = r.id AND rp.left_at IS NULL
      WHERE rp.player_id = ? AND r.status <> 'closed'
      ORDER BY r.id DESC LIMIT 1`,
    playerId,
  );
  return row ? roomState(row.id) : null;
}

/** Sweeps empty lobbies nobody returned to. */
export function purgeStaleRooms() {
  const cutoff = `-${Math.round(ROOM.emptyRoomTtlMs / 60_000)} minutes`;
  const stale = query(
    `SELECT r.id FROM rooms r
      WHERE r.status = 'open'
        AND r.updated_at < datetime('now', ?)
        AND NOT EXISTS (
          SELECT 1 FROM room_players rp WHERE rp.room_id = r.id AND rp.left_at IS NULL
        )`,
    cutoff,
  );
  for (const r of stale) {
    run("UPDATE rooms SET status = 'closed', closed_at = datetime('now') WHERE id = ?", r.id);
  }
  return stale.length;
}

export { displayRoomCode, normalizeRoomCode };
