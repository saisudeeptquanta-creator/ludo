/**
 * The Ludo state machine.
 *
 * Every function here is pure: it takes a state, returns a NEW state plus the
 * list of events that describe the transition. It performs no I/O, reads no
 * clock it was not given, and generates no randomness it was not given — dice
 * values are injected by the caller so that tests are deterministic and so the
 * only real RNG in the system lives in one auditable place (game.service.js).
 *
 * The server persists the returned state; the returned events are what gets
 * broadcast. Clients replay events for animation but always reconcile against
 * the authoritative state and its `stateVersion`.
 */
import crypto from 'node:crypto';
import * as B from './board.js';
import {
  legalMoves,
  findMove,
  hasWon,
  tokensOf,
  playerBySeat,
  activeSeats,
  tokenStateFor,
  preferredAutoMove,
  progressScore,
} from './rules.js';
import { GAME_CONFIG } from '../config/index.js';

export const EVENTS = {
  GAME_STARTED: 'GAME_STARTED',
  TURN_STARTED: 'TURN_STARTED',
  DICE_ROLLED: 'DICE_ROLLED',
  NO_LEGAL_MOVE: 'NO_LEGAL_MOVE',
  TOKEN_MOVED: 'TOKEN_MOVED',
  TOKEN_CAPTURED: 'TOKEN_CAPTURED',
  EXTRA_TURN: 'EXTRA_TURN',
  TURN_FORFEITED: 'TURN_FORFEITED',
  PLAYER_FINISHED: 'PLAYER_FINISHED',
  PLAYER_DISCONNECTED: 'PLAYER_DISCONNECTED',
  PLAYER_RECONNECTED: 'PLAYER_RECONNECTED',
  PLAYER_LEFT: 'PLAYER_LEFT',
  GAME_FINISHED: 'GAME_FINISHED',
};

const clone = (v) => structuredClone(v);

/** Cryptographic dice. The one place a game outcome depends on chance. */
export function rollDiceValue() {
  return crypto.randomInt(1, 7);
}

/**
 * @param {{ userId:number, seat:number, color:string }[]} players
 */
export function createInitialState({ players, config = GAME_CONFIG, now = Date.now() }) {
  const cfg = { ...GAME_CONFIG, ...config };
  const seated = [...players].sort((a, b) => a.seat - b.seat);

  const tokens = [];
  for (const p of seated) {
    for (let i = 0; i < cfg.TOKEN_COUNT; i += 1) {
      tokens.push({
        seat: p.seat,
        userId: p.userId,
        color: p.color,
        tokenIndex: i,
        progress: -1,
        state: 'HOME',
      });
    }
  }

  return {
    status: 'active',
    playerCount: seated.length,
    players: seated.map((p) => ({
      seat: p.seat,
      userId: p.userId,
      color: p.color,
      status: 'playing',
      connected: true,
      finishedRank: null,
      tokensFinished: 0,
      captures: 0,
      timesCaptured: 0,
      sixesRolled: 0,
      movesMade: 0,
      consecutiveTimeouts: 0,
    })),
    tokens,
    currentSeat: seated[0].seat,
    turnNumber: 1,
    diceValue: null,
    diceRolled: false,
    consecutiveSixes: 0,
    stateVersion: 1,
    turnStartedAt: now,
    turnDeadlineAt: now + cfg.TURN_DURATION_MS,
    winnerSeat: null,
    rankings: [],
    endReason: null,
    config: cfg,
  };
}

/** Recomputes derived token states and per-player counters. */
function refresh(state) {
  for (const t of state.tokens) t.state = tokenStateFor(t.color, t.progress);
  for (const p of state.players) {
    p.tokensFinished = tokensOf(state, p.seat).filter((t) => B.isFinished(t.progress)).length;
  }
  return state;
}

function bump(state) {
  state.stateVersion += 1;
  return state;
}

/** Next seat that is still playing, walking around the table. */
function nextPlayingSeat(state, fromSeat) {
  const seats = state.players.map((p) => p.seat).sort((a, b) => a - b);
  const start = seats.indexOf(fromSeat);
  for (let i = 1; i <= seats.length; i += 1) {
    const seat = seats[(start + i) % seats.length];
    if (playerBySeat(state, seat)?.status === 'playing') return seat;
  }
  return null;
}

function beginTurn(state, seat, now, events) {
  state.currentSeat = seat;
  state.turnNumber += 1;
  state.diceValue = null;
  state.diceRolled = false;
  state.consecutiveSixes = 0;
  state.turnStartedAt = now;
  state.turnDeadlineAt = now + state.config.TURN_DURATION_MS;
  events.push({
    type: EVENTS.TURN_STARTED,
    seat,
    turnNumber: state.turnNumber,
    deadlineAt: state.turnDeadlineAt,
  });
}

/** Same player rolls again — the turn number advances but the seat does not. */
function grantExtraTurn(state, now, events, reason) {
  state.diceValue = null;
  state.diceRolled = false;
  state.turnNumber += 1;
  state.turnStartedAt = now;
  state.turnDeadlineAt = now + state.config.TURN_DURATION_MS;
  events.push({ type: EVENTS.EXTRA_TURN, seat: state.currentSeat, reason });
  events.push({
    type: EVENTS.TURN_STARTED,
    seat: state.currentSeat,
    turnNumber: state.turnNumber,
    deadlineAt: state.turnDeadlineAt,
  });
}

function concludeIfOver(state, now, events) {
  const remaining = activeSeats(state);
  if (remaining.length > 1) return false;

  /**
   * Distinguish a real victory from an empty board.
   *
   * The game also ends when everyone else has left or been dropped. That is not
   * a win — announcing "You Win!" to someone with no tokens home, because their
   * opponent's phone locked, is simply wrong. `endReason` lets the client say
   * what actually happened.
   */
  const lastSeat = remaining[0] ?? null;
  const winnerByPlay = state.rankings.length > 0;

  if (lastSeat !== null) {
    const p = playerBySeat(state, lastSeat);
    const allHome = tokensOf(state, lastSeat).every((t) => B.isFinished(t.progress));
    p.status = 'finished';
    p.finishedRank = state.rankings.length + 1;
    state.rankings.push({ seat: p.seat, userId: p.userId, rank: p.finishedRank });
    if (!winnerByPlay && !allHome) state.endReason = 'opponents_left';
  } else if (!winnerByPlay) {
    state.endReason = 'abandoned';
  }

  state.status = 'finished';
  state.endedAt = now;
  state.winnerSeat = state.rankings[0]?.seat ?? null;
  state.endReason = state.endReason ?? 'completed';
  state.diceRolled = false;
  state.diceValue = null;
  state.turnDeadlineAt = null;
  events.push({
    type: EVENTS.GAME_FINISHED,
    winnerSeat: state.winnerSeat,
    rankings: state.rankings,
    reason: state.endReason,
  });
  return true;
}

// ------------------------------------------------------------------ roll ---

/**
 * @param {object} state
 * @param {{ seat:number, value?:number, now?:number }} input `value` is injected
 *        by tests; production passes nothing and gets a crypto roll.
 */
export function rollDice(state, { seat, value, now = Date.now() }) {
  const s = clone(state);
  const events = [];

  if (s.status !== 'active') return { state, events, error: 'GAME_NOT_ACTIVE' };
  if (s.currentSeat !== seat) return { state, events, error: 'NOT_YOUR_TURN' };
  if (s.diceRolled) return { state, events, error: 'ALREADY_ROLLED' };

  const player = playerBySeat(s, seat);
  if (!player || player.status !== 'playing') return { state, events, error: 'NOT_IN_GAME' };

  const dice = value ?? rollDiceValue();
  s.diceValue = dice;
  s.diceRolled = true;
  if (dice === 6) {
    s.consecutiveSixes += 1;
    player.sixesRolled += 1;
  } else {
    s.consecutiveSixes = 0;
  }

  events.push({ type: EVENTS.DICE_ROLLED, seat, value: dice, turnNumber: s.turnNumber });

  // Three sixes in a row forfeits the turn and voids the roll.
  if (dice === 6 && s.consecutiveSixes >= s.config.MAX_CONSECUTIVE_SIXES) {
    events.push({ type: EVENTS.TURN_FORFEITED, seat, reason: 'three_sixes' });
    const next = nextPlayingSeat(s, seat);
    if (next !== null) beginTurn(s, next, now, events);
    return { state: bump(refresh(s)), events, moves: [] };
  }

  const moves = legalMoves(s, seat, dice);
  if (moves.length === 0) {
    events.push({ type: EVENTS.NO_LEGAL_MOVE, seat, value: dice });
    const next = nextPlayingSeat(s, seat);
    if (next !== null && next !== seat) beginTurn(s, next, now, events);
    else grantExtraTurn(s, now, events, 'no_legal_move');
    return { state: bump(refresh(s)), events, moves: [] };
  }

  return { state: bump(refresh(s)), events, moves };
}

// ------------------------------------------------------------------ move ---

export function applyMove(state, { seat, tokenIndex, now = Date.now(), auto = false }) {
  const s = clone(state);
  const events = [];

  if (s.status !== 'active') return { state, events, error: 'GAME_NOT_ACTIVE' };
  if (s.currentSeat !== seat) return { state, events, error: 'NOT_YOUR_TURN' };
  if (!s.diceRolled || s.diceValue == null) return { state, events, error: 'NOT_ROLLED' };

  const move = findMove(s, seat, s.diceValue, tokenIndex);
  if (!move) return { state, events, error: 'ILLEGAL_MOVE' };

  const player = playerBySeat(s, seat);
  const token = s.tokens.find((t) => t.seat === seat && t.tokenIndex === tokenIndex);

  token.progress = move.to;
  player.movesMade += 1;
  player.consecutiveTimeouts = 0;

  events.push({
    type: EVENTS.TOKEN_MOVED,
    seat,
    color: token.color,
    tokenIndex,
    from: move.from,
    to: move.to,
    path: move.path,
    dice: s.diceValue,
    auto,
  });

  // Captures — send every opponent token on the destination back to its yard.
  for (const cap of move.captures) {
    const victim = s.tokens.find((t) => t.seat === cap.seat && t.tokenIndex === cap.tokenIndex);
    victim.progress = -1;
    player.captures += 1;
    const victimPlayer = playerBySeat(s, cap.seat);
    if (victimPlayer) victimPlayer.timesCaptured += 1;
    events.push({
      type: EVENTS.TOKEN_CAPTURED,
      bySeat: seat,
      seat: cap.seat,
      color: cap.color,
      tokenIndex: cap.tokenIndex,
      from: cap.from,
    });
  }

  refresh(s);

  // Did this move finish the player?
  let playerJustFinished = false;
  if (hasWon(s, seat)) {
    player.status = 'finished';
    player.finishedRank = s.rankings.length + 1;
    s.rankings.push({ seat, userId: player.userId, rank: player.finishedRank });
    playerJustFinished = true;
    events.push({ type: EVENTS.PLAYER_FINISHED, seat, rank: player.finishedRank });
  }

  if (concludeIfOver(s, now, events)) return { state: bump(refresh(s)), events, move };

  const cfg = s.config;
  const earnedExtra =
    !playerJustFinished &&
    ((cfg.EXTRA_TURN_ON_SIX && s.diceValue === 6) ||
      (cfg.EXTRA_TURN_ON_CAPTURE && move.captures.length > 0) ||
      (cfg.EXTRA_TURN_ON_FINISH && move.finishes));

  if (earnedExtra) {
    const reason =
      s.diceValue === 6 ? 'six' : move.captures.length > 0 ? 'capture' : 'token_finished';
    grantExtraTurn(s, now, events, reason);
  } else {
    const next = nextPlayingSeat(s, seat);
    if (next !== null) beginTurn(s, next, now, events);
  }

  return { state: bump(refresh(s)), events, move };
}

// --------------------------------------------------------------- timeout ---

/**
 * Turn clock expired. Depending on config the server either plays the best
 * legal move for the player or skips them. Rolling first is required — a player
 * who never rolled gets a roll generated for them.
 */
export function handleTimeout(state, { seat, now = Date.now(), value } = {}) {
  let s = clone(state);
  let events = [];

  if (s.status !== 'active') return { state, events };
  if (s.currentSeat !== seat) return { state, events };

  const player = playerBySeat(s, seat);
  if (!player) return { state, events };
  player.consecutiveTimeouts += 1;

  // Too many timeouts in a row: the seat is dropped from the game.
  if (player.consecutiveTimeouts >= s.config.MAX_CONSECUTIVE_TIMEOUTS) {
    return removePlayer(s, { seat, now, reason: 'timed_out' });
  }

  if (!s.diceRolled) {
    const rolled = rollDice(s, { seat, value, now });
    s = rolled.state;
    events = events.concat(rolled.events);
    // rollDice already advanced the turn if there was nothing to play.
    if (!s.diceRolled || s.currentSeat !== seat) {
      const p = playerBySeat(s, seat);
      if (p) p.consecutiveTimeouts = player.consecutiveTimeouts;
      return { state: s, events };
    }
  }

  if (s.config.ON_TIMEOUT === 'auto_move') {
    const choice = preferredAutoMove(legalMoves(s, seat, s.diceValue));
    if (choice) {
      const moved = applyMove(s, { seat, tokenIndex: choice.tokenIndex, now, auto: true });
      const p = playerBySeat(moved.state, seat);
      // applyMove resets the counter on a successful move; a timeout still counts.
      if (p) p.consecutiveTimeouts = player.consecutiveTimeouts;
      return { state: moved.state, events: events.concat(moved.events) };
    }
  }

  events.push({ type: EVENTS.TURN_FORFEITED, seat, reason: 'timeout' });
  const next = nextPlayingSeat(s, seat);
  if (next !== null) beginTurn(s, next, now, events);
  return { state: bump(refresh(s)), events };
}

// ---------------------------------------------------------- connectivity ---

export function setConnected(state, { seat, connected, now = Date.now() }) {
  const s = clone(state);
  const events = [];
  const player = playerBySeat(s, seat);
  if (!player || player.connected === connected) return { state, events };

  player.connected = connected;
  player.disconnectedAt = connected ? null : now;
  events.push({
    type: connected ? EVENTS.PLAYER_RECONNECTED : EVENTS.PLAYER_DISCONNECTED,
    seat,
    userId: player.userId,
  });
  // A disconnect never pauses or resets the board — the turn clock keeps
  // running and the timeout handler covers the seat.
  return { state: bump(s), events };
}

/**
 * Player is gone for good (left, or exhausted the grace period). Their tokens
 * are removed from play and the remaining players carry on.
 */
export function removePlayer(state, { seat, now = Date.now(), reason = 'left' }) {
  const s = clone(state);
  const events = [];
  const player = playerBySeat(s, seat);
  if (!player || player.status !== 'playing') return { state, events };

  player.status = reason === 'timed_out' ? 'timed_out' : 'left';
  player.connected = false;
  player.leftAt = now;

  // Abandoned tokens leave the board so they cannot block or be captured.
  for (const t of s.tokens) {
    if (t.seat === seat && !B.isFinished(t.progress)) t.progress = -1;
  }

  events.push({ type: EVENTS.PLAYER_LEFT, seat, userId: player.userId, reason });

  const wasTheirTurn = s.currentSeat === seat;
  if (concludeIfOver(s, now, events)) return { state: bump(refresh(s)), events };

  if (wasTheirTurn) {
    const next = nextPlayingSeat(s, seat);
    if (next !== null) beginTurn(s, next, now, events);
  }
  return { state: bump(refresh(s)), events };
}

/** Host cancelled, or everyone vanished. */
export function cancelGame(state, { now = Date.now(), reason = 'abandoned' } = {}) {
  const s = clone(state);
  if (s.status !== 'active') return { state, events: [] };
  s.status = 'cancelled';
  s.endedAt = now;
  s.endReason = reason;
  s.turnDeadlineAt = null;
  return {
    state: bump(s),
    events: [{ type: EVENTS.GAME_FINISHED, winnerSeat: null, rankings: s.rankings, reason }],
  };
}

/**
 * Final standings for a game that ended early: already-finished players keep
 * their rank, everyone else is ordered by how far their tokens got.
 */
export function finalRankings(state) {
  const ranked = [...state.rankings];
  const placed = new Set(ranked.map((r) => r.seat));
  const rest = state.players
    .filter((p) => !placed.has(p.seat))
    .sort((a, b) => progressScore(state, b.seat) - progressScore(state, a.seat));
  for (const p of rest) ranked.push({ seat: p.seat, userId: p.userId });
  return ranked.map((r, i) => ({ seat: r.seat, userId: r.userId, rank: i + 1 }));
}

export { legalMoves, activeSeats, playerBySeat, tokensOf };
