/**
 * The authoritative game service.
 *
 * The only module allowed to advance a game. Every mutation runs inside
 * `transaction()`, and because node:sqlite is synchronous and Node runs one
 * callback at a time, a transaction block here is genuinely atomic within the
 * process — two sockets cannot interleave a roll. `BEGIN IMMEDIATE` extends that
 * across processes.
 *
 * The normalized tables are the source of truth: engine state is rebuilt from
 * them on load and written back on save.
 */
import { get, query, run, transaction } from '../db/index.js';
import * as engine from '../game-engine/engine.js';
import { legalMoves } from '../game-engine/rules.js';
import { GAME_CONFIG } from '../config/index.js';
import { publicPlayer } from './player.service.js';
import { conflict, notFound, forbidden, MESSAGES } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export const findGameById = (gameId) => get('SELECT * FROM games WHERE id = ?', gameId);

/** Rebuilds engine state from the normalized rows. */
export function loadState(gameId) {
  const g = findGameById(gameId);
  if (!g) return null;

  const players = query(
    'SELECT * FROM game_players WHERE game_id = ? ORDER BY seat',
    gameId,
  ).map((p) => ({
    seat: p.seat,
    userId: p.player_id,
    color: p.color,
    status: p.status,
    connected: Boolean(p.connected),
    finishedRank: p.finished_rank,
    tokensFinished: p.tokens_finished,
    captures: p.captures,
    timesCaptured: p.times_captured,
    sixesRolled: p.sixes_rolled,
    movesMade: p.moves_made,
    consecutiveTimeouts: p.timeouts,
  }));

  const tokens = query(
    'SELECT * FROM game_tokens WHERE game_id = ? ORDER BY seat, token_index',
    gameId,
  ).map((t) => ({
    seat: t.seat,
    userId: t.player_id,
    color: t.color,
    tokenIndex: t.token_index,
    progress: t.progress,
    state: t.state,
  }));

  const rankings = players
    .filter((p) => p.finishedRank != null)
    .sort((a, b) => a.finishedRank - b.finishedRank)
    .map((p) => ({ seat: p.seat, userId: p.userId, rank: p.finishedRank }));

  return {
    id: g.id,
    roomId: g.room_id,
    status: g.status,
    playerCount: g.player_count,
    players,
    tokens,
    rankings,
    currentSeat: g.current_seat,
    turnNumber: g.turn_number,
    diceValue: g.dice_value,
    diceRolled: Boolean(g.dice_rolled),
    consecutiveSixes: g.consecutive_sixes,
    stateVersion: g.state_version,
    turnStartedAt: g.turn_started_at ? Date.parse(g.turn_started_at) : null,
    turnDeadlineAt: g.turn_deadline_at ? Date.parse(g.turn_deadline_at) : null,
    winnerSeat: g.winner_id ? players.find((p) => p.userId === g.winner_id)?.seat ?? null : null,
    endReason: g.end_reason,
    /**
     * Stored settings layer over the defaults — except the rules that are not
     * per-room options. EXACT_FINISH_REQUIRED is a core rule, not a lobby
     * toggle, so it is pinned to the current default: a game created before the
     * rule changed would otherwise keep the old behaviour forever, and a token
     * in the home column would still offer moves that overshoot the centre.
     */
    config: {
      ...GAME_CONFIG,
      ...JSON.parse(g.config_json || '{}'),
      EXACT_FINISH_REQUIRED: GAME_CONFIG.EXACT_FINISH_REQUIRED,
    },
  };
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

function saveState(state) {
  run(
    `UPDATE games SET status = ?, current_seat = ?, turn_number = ?, dice_value = ?,
            dice_rolled = ?, consecutive_sixes = ?, state_version = ?,
            turn_started_at = ?, turn_deadline_at = ?, winner_id = ?, end_reason = ?
      WHERE id = ?`,
    state.status,
    state.currentSeat,
    state.turnNumber,
    state.diceValue,
    state.diceRolled ? 1 : 0,
    state.consecutiveSixes,
    state.stateVersion,
    iso(state.turnStartedAt),
    iso(state.turnDeadlineAt),
    state.winnerSeat != null
      ? state.players.find((p) => p.seat === state.winnerSeat)?.userId ?? null
      : null,
    state.endReason ?? null,
    state.id,
  );

  for (const p of state.players) {
    run(
      `UPDATE game_players SET status = ?, connected = ?, finished_rank = ?, tokens_finished = ?,
              captures = ?, times_captured = ?, sixes_rolled = ?, moves_made = ?, timeouts = ?
        WHERE game_id = ? AND seat = ?`,
      p.status,
      p.connected ? 1 : 0,
      p.finishedRank,
      p.tokensFinished,
      p.captures,
      p.timesCaptured,
      p.sixesRolled,
      p.movesMade,
      p.consecutiveTimeouts ?? 0,
      state.id,
      p.seat,
    );
  }

  for (const t of state.tokens) {
    run(
      'UPDATE game_tokens SET progress = ?, state = ? WHERE game_id = ? AND seat = ? AND token_index = ?',
      t.progress,
      t.state,
      state.id,
      t.seat,
      t.tokenIndex,
    );
  }
}

function recordEvents(gameId, stateVersion, events) {
  if (!events.length) return;
  let seq = get('SELECT COALESCE(MAX(seq), 0) AS seq FROM game_events WHERE game_id = ?', gameId).seq;
  for (const e of events) {
    seq += 1;
    const { type, ...payload } = e;
    run(
      'INSERT INTO game_events (game_id, seq, state_version, type, payload_json) VALUES (?, ?, ?, ?, ?)',
      gameId,
      seq,
      stateVersion,
      type,
      JSON.stringify(payload),
    );
  }
}

// ------------------------------------------------------------- creation ---

export function startGame({ roomId, members, settings = {} }) {
  return transaction(() => {
    const colors = GAME_CONFIG.SEATING[members.length];
    if (!colors) throw conflict('BAD_PLAYER_COUNT', 'Ludo needs between 2 and 4 players.');

    // Re-index seats to 0..n-1 so colour assignment is contiguous even if a
    // middle seat was vacated in the lobby.
    const seated = [...members]
      .sort((a, b) => a.seat - b.seat)
      .map((m, i) => ({ userId: m.id, seat: i, color: colors[i] }));

    const config = {
      ...GAME_CONFIG,
      TURN_DURATION_MS: settings.turnDurationMs ?? GAME_CONFIG.TURN_DURATION_MS,
      EXTRA_TURN_ON_SIX: settings.extraTurnOnSix ?? GAME_CONFIG.EXTRA_TURN_ON_SIX,
      EXTRA_TURN_ON_CAPTURE: settings.extraTurnOnCapture ?? GAME_CONFIG.EXTRA_TURN_ON_CAPTURE,
      STACKING_ENABLED: settings.stackingEnabled ?? GAME_CONFIG.STACKING_ENABLED,
      SAFE_CELLS_ENABLED: settings.safeCellsEnabled ?? GAME_CONFIG.SAFE_CELLS_ENABLED,
      BLOCKING_ENABLED: settings.blockingEnabled ?? GAME_CONFIG.BLOCKING_ENABLED,
    };

    const state = engine.createInitialState({ players: seated, config, now: Date.now() });

    const res = run(
      `INSERT INTO games (room_id, status, player_count, current_seat, turn_number,
                          state_version, turn_started_at, turn_deadline_at, config_json)
       VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      roomId,
      seated.length,
      state.currentSeat,
      state.turnNumber,
      state.stateVersion,
      iso(state.turnStartedAt),
      iso(state.turnDeadlineAt),
      JSON.stringify(config),
    );
    const gameId = Number(res.lastInsertRowid);

    for (const p of seated) {
      run(
        'INSERT INTO game_players (game_id, player_id, seat, color) VALUES (?, ?, ?, ?)',
        gameId,
        p.userId,
        p.seat,
        p.color,
      );
      for (let i = 0; i < GAME_CONFIG.TOKEN_COUNT; i += 1) {
        run(
          'INSERT INTO game_tokens (game_id, player_id, seat, color, token_index) VALUES (?, ?, ?, ?, ?)',
          gameId,
          p.userId,
          p.seat,
          p.color,
          i,
        );
      }
    }

    run(
      "UPDATE rooms SET status = 'in_game', game_id = ?, updated_at = datetime('now') WHERE id = ?",
      gameId,
      roomId,
    );
    run('UPDATE room_players SET is_ready = 0 WHERE room_id = ?', roomId);

    recordEvents(gameId, state.stateVersion, [
      { type: engine.EVENTS.GAME_STARTED, players: seated },
      {
        type: engine.EVENTS.TURN_STARTED,
        seat: state.currentSeat,
        turnNumber: state.turnNumber,
        deadlineAt: state.turnDeadlineAt,
      },
    ]);

    logger.info('game.started', { gameId, roomId, players: seated.length });
    return { ...state, id: gameId };
  });
}

// -------------------------------------------------------------- actions ---

export const seatOf = (state, playerId) =>
  state.players.find((p) => p.userId === playerId)?.seat ?? null;

function assertPlayer(state, playerId) {
  const seat = seatOf(state, playerId);
  if (seat === null) throw forbidden('NOT_IN_GAME', MESSAGES.NOT_IN_GAME);
  return seat;
}

/** Server-side dice. The client never supplies a value — it only asks. */
export function rollDice({ gameId, playerId }) {
  return transaction(() => {
    const state = loadState(gameId);
    if (!state) throw notFound('GAME_NOT_FOUND', MESSAGES.GAME_NOT_FOUND);
    if (state.status !== 'active') throw conflict('GAME_OVER', 'This game has finished.');

    const seat = assertPlayer(state, playerId);
    if (state.currentSeat !== seat) throw conflict('NOT_YOUR_TURN', MESSAGES.NOT_YOUR_TURN);
    if (state.diceRolled) throw conflict('ALREADY_ROLLED', MESSAGES.ALREADY_ROLLED);

    const result = engine.rollDice(state, { seat, now: Date.now() });
    if (result.error) {
      throw conflict(result.error, MESSAGES[result.error] ?? 'That action is not allowed.');
    }

    saveState(result.state);
    recordEvents(gameId, result.state.stateVersion, result.events);
    if (result.state.status === 'finished') finalizeGame(result.state);
    return result;
  });
}

export function moveToken({ gameId, playerId, tokenIndex }) {
  return transaction(() => {
    const state = loadState(gameId);
    if (!state) throw notFound('GAME_NOT_FOUND', MESSAGES.GAME_NOT_FOUND);
    if (state.status !== 'active') throw conflict('GAME_OVER', 'This game has finished.');

    const seat = assertPlayer(state, playerId);
    if (state.currentSeat !== seat) throw conflict('NOT_YOUR_TURN', MESSAGES.NOT_YOUR_TURN);
    if (!state.diceRolled) throw conflict('NOT_ROLLED', MESSAGES.NOT_ROLLED);

    const result = engine.applyMove(state, { seat, tokenIndex, now: Date.now() });
    if (result.error) {
      throw conflict(result.error, MESSAGES[result.error] ?? 'That move is not allowed.');
    }

    saveState(result.state);
    recordEvents(gameId, result.state.stateVersion, result.events);
    if (result.state.status === 'finished') finalizeGame(result.state);
    return result;
  });
}

/** Called by the turn scheduler; ignores a timer whose turn already moved on. */
export function applyTimeout({ gameId, expectedTurnNumber }) {
  return transaction(() => {
    const state = loadState(gameId);
    if (!state || state.status !== 'active') return null;
    if (expectedTurnNumber != null && state.turnNumber !== expectedTurnNumber) return null;

    const result = engine.handleTimeout(state, { seat: state.currentSeat, now: Date.now() });
    if (!result.events.length) return null;

    saveState(result.state);
    recordEvents(gameId, result.state.stateVersion, result.events);
    if (result.state.status === 'finished') finalizeGame(result.state);
    return result;
  });
}

export function setPlayerConnected({ gameId, playerId, connected }) {
  return transaction(() => {
    const state = loadState(gameId);
    if (!state || state.status !== 'active') return null;
    const seat = seatOf(state, playerId);
    if (seat === null) return null;

    const result = engine.setConnected(state, { seat, connected, now: Date.now() });
    if (!result.events.length) return null;

    run(
      'UPDATE game_players SET connected = ?, disconnected_at = ? WHERE game_id = ? AND seat = ?',
      connected ? 1 : 0,
      connected ? null : new Date().toISOString(),
      gameId,
      seat,
    );
    saveState(result.state);
    recordEvents(gameId, result.state.stateVersion, result.events);
    return result;
  });
}

export function removePlayer({ gameId, playerId, reason = 'left' }) {
  return transaction(() => {
    const state = loadState(gameId);
    if (!state || state.status !== 'active') return null;
    const seat = seatOf(state, playerId);
    if (seat === null) return null;

    const result = engine.removePlayer(state, { seat, reason, now: Date.now() });
    if (!result.events.length) return null;

    run("UPDATE game_players SET left_at = datetime('now') WHERE game_id = ? AND seat = ?", gameId, seat);
    saveState(result.state);
    recordEvents(gameId, result.state.stateVersion, result.events);
    if (result.state.status === 'finished') finalizeGame(result.state);
    logger.info('game.player_removed', { gameId, playerId, reason });
    return result;
  });
}

export function cancelGame({ gameId, reason = 'abandoned' }) {
  return transaction(() => {
    const state = loadState(gameId);
    if (!state || state.status !== 'active') return null;
    const result = engine.cancelGame(state, { reason, now: Date.now() });
    run(
      "UPDATE games SET status = 'cancelled', ended_at = datetime('now'), end_reason = ? WHERE id = ?",
      reason,
      gameId,
    );
    run("UPDATE rooms SET status = 'open', game_id = NULL WHERE game_id = ?", gameId);
    recordEvents(gameId, result.state.stateVersion, result.events);
    return result;
  });
}

/** Settles a finished game: duration and final ranks. Runs in the caller's txn. */
function finalizeGame(state) {
  const g = findGameById(state.id);
  if (!g || g.ended_at) return null;

  const startedAt = Date.parse(`${g.started_at}Z`) || Date.now();
  const durationMs = Math.max(0, Date.now() - startedAt);
  const rankings = engine.finalRankings(state);

  run(
    "UPDATE games SET status = 'finished', ended_at = datetime('now'), duration_ms = ?, end_reason = ? WHERE id = ?",
    durationMs,
    state.endReason ?? 'completed',
    state.id,
  );
  // The room reopens so "play again" can reuse it with the same people.
  run("UPDATE rooms SET status = 'open', game_id = NULL WHERE game_id = ?", state.id);

  for (const r of rankings) {
    run(
      'UPDATE game_players SET finished_rank = ? WHERE game_id = ? AND seat = ?',
      r.rank,
      state.id,
      r.seat,
    );
  }

  logger.info('game.finished', { gameId: state.id, winnerSeat: state.winnerSeat, durationMs });
  return { rankings, durationMs };
}

/** Result payload for the end screen. */
export function gameResults(gameId) {
  const g = findGameById(gameId);
  if (!g) return null;

  // Columns listed explicitly: `gp.*` would bring game_players.id along and
  // shadow p.id, so every standing would carry a row id instead of a player id.
  const rows = query(
    `SELECT p.id AS id, p.name, p.avatar,
            gp.seat, gp.color, gp.status, gp.finished_rank, gp.tokens_finished,
            gp.captures, gp.times_captured, gp.sixes_rolled, gp.moves_made
       FROM game_players gp
       JOIN players p ON p.id = gp.player_id
      WHERE gp.game_id = ?
      ORDER BY COALESCE(gp.finished_rank, 99), gp.seat`,
    gameId,
  );

  return {
    gameId,
    roomId: g.room_id,
    status: g.status,
    endReason: g.end_reason,
    durationMs: g.duration_ms,
    winnerId: g.winner_id,
    standings: rows.map((r) => ({
      ...publicPlayer(r),
      seat: r.seat,
      color: r.color,
      rank: r.finished_rank,
      status: r.status,
      tokensFinished: r.tokens_finished,
      captures: r.captures,
      timesCaptured: r.times_captured,
      sixesRolled: r.sixes_rolled,
      movesMade: r.moves_made,
    })),
  };
}

// ------------------------------------------------------------------ DTO ---

/**
 * The wire format every client receives. Includes the viewer's own legal moves
 * so the UI can highlight tokens without ever computing a rule itself.
 */
export function gameDto(state, viewerId = null) {
  const viewerSeat = viewerId != null ? seatOf(state, viewerId) : null;
  const isViewersTurn = viewerSeat !== null && state.currentSeat === viewerSeat;

  const profiles = query(
    `SELECT gp.seat, p.id, p.name, p.avatar
       FROM game_players gp JOIN players p ON p.id = gp.player_id
      WHERE gp.game_id = ?`,
    state.id,
  );
  const bySeat = new Map(profiles.map((p) => [p.seat, p]));

  return {
    id: state.id,
    roomId: state.roomId,
    status: state.status,
    stateVersion: state.stateVersion,
    playerCount: state.playerCount,
    currentSeat: state.currentSeat,
    turnNumber: state.turnNumber,
    diceValue: state.diceValue,
    diceRolled: state.diceRolled,
    turnStartedAt: state.turnStartedAt,
    turnDeadlineAt: state.turnDeadlineAt,
    serverTime: Date.now(),
    winnerSeat: state.winnerSeat,
    endReason: state.endReason,
    config: {
      turnDurationMs: state.config.TURN_DURATION_MS,
      tokenCount: state.config.TOKEN_COUNT,
      safeCellsEnabled: state.config.SAFE_CELLS_ENABLED,
      stackingEnabled: state.config.STACKING_ENABLED,
    },
    you: viewerSeat === null ? null : {
      seat: viewerSeat,
      color: state.players.find((p) => p.seat === viewerSeat)?.color,
    },
    players: state.players.map((p) => ({
      seat: p.seat,
      color: p.color,
      status: p.status,
      connected: p.connected,
      finishedRank: p.finishedRank,
      tokensFinished: p.tokensFinished,
      captures: p.captures,
      sixesRolled: p.sixesRolled,
      player: publicPlayer(bySeat.get(p.seat)),
      isYou: p.userId === viewerId,
    })),
    tokens: state.tokens.map((t) => ({
      seat: t.seat,
      color: t.color,
      tokenIndex: t.tokenIndex,
      progress: t.progress,
      state: t.state,
    })),
    rankings: state.rankings,
    legalMoves:
      isViewersTurn && state.diceRolled && state.status === 'active'
        ? legalMoves(state, viewerSeat, state.diceValue).map((m) => ({
            tokenIndex: m.tokenIndex,
            from: m.from,
            to: m.to,
            path: m.path,
            captures: m.captures.length,
            finishes: m.finishes,
            releases: m.releases,
          }))
        : [],
  };
}

export function gameDtoFor(gameId, viewerId) {
  const state = loadState(gameId);
  return state ? gameDto(state, viewerId) : null;
}

/** The active game a player belongs to — drives resume-on-reload. */
export function activeGameFor(playerId) {
  const row = get(
    `SELECT g.id FROM games g
       JOIN game_players gp ON gp.game_id = g.id
      WHERE gp.player_id = ? AND g.status = 'active' AND gp.status = 'playing'
      ORDER BY g.id DESC LIMIT 1`,
    playerId,
  );
  return row?.id ?? null;
}

/** Events a reconnecting client missed. */
export function eventsSince(gameId, sinceVersion, limit = 200) {
  return query(
    `SELECT seq, state_version, type, payload_json FROM game_events
      WHERE game_id = ? AND state_version > ? ORDER BY seq ASC LIMIT ?`,
    gameId,
    sinceVersion,
    limit,
  ).map((e) => ({
    seq: e.seq,
    stateVersion: e.state_version,
    type: e.type,
    ...JSON.parse(e.payload_json),
  }));
}

export { legalMoves };
