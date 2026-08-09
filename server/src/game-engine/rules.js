/**
 * Move legality. Pure functions over a game state — no I/O, no randomness, no
 * mutation. `legalMoves()` is the only place that decides what a player may do,
 * and both the socket handler and the turn-timeout auto-player call it, so a
 * hand-crafted client packet is checked against exactly the same code path a
 * legitimate click takes.
 */
import * as B from './board.js';

export const TOKEN_STATE = {
  HOME: 'HOME',
  ACTIVE: 'ACTIVE',
  SAFE: 'SAFE',
  FINISHED: 'FINISHED',
};

/** Token state is derived from progress — never stored independently. */
export function tokenStateFor(color, progress) {
  if (B.isInYard(progress)) return TOKEN_STATE.HOME;
  if (B.isFinished(progress)) return TOKEN_STATE.FINISHED;
  return B.isSafeProgress(color, progress) ? TOKEN_STATE.SAFE : TOKEN_STATE.ACTIVE;
}

export const tokensOf = (state, seat) => state.tokens.filter((t) => t.seat === seat);

export const playerBySeat = (state, seat) => state.players.find((p) => p.seat === seat) ?? null;

/** Seats that can still take a turn. */
export const activeSeats = (state) =>
  state.players.filter((p) => p.status === 'playing').map((p) => p.seat).sort((a, b) => a - b);

/**
 * Map of cellKey -> tokens standing there. Ring squares are shared between
 * colours, so this is what capture and stacking checks run against.
 */
export function occupancy(state) {
  const map = new Map();
  for (const t of state.tokens) {
    if (B.isInYard(t.progress) || B.isFinished(t.progress)) continue;
    const key = B.cellKey(t.color, t.progress);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return map;
}

/**
 * A ring square is a block when it holds two or more tokens of one colour and
 * that colour is not the mover's. Only consulted when BLOCKING_ENABLED.
 */
function isBlockedFor(occupants, moverSeat) {
  if (!occupants || occupants.length < 2) return false;
  const bySeat = new Map();
  for (const t of occupants) bySeat.set(t.seat, (bySeat.get(t.seat) ?? 0) + 1);
  for (const [seat, count] of bySeat) if (seat !== moverSeat && count >= 2) return true;
  return false;
}

/**
 * Every move the given seat may legally make with `dice`.
 * Returns [] when the player must forfeit the turn.
 */
export function legalMoves(state, seat, dice) {
  const cfg = state.config;
  const player = playerBySeat(state, seat);
  if (!player || player.status !== 'playing') return [];
  if (!Number.isInteger(dice) || dice < 1 || dice > 6) return [];

  const occ = occupancy(state);
  const mine = tokensOf(state, seat);
  const moves = [];

  for (const token of mine) {
    const from = token.progress;
    if (B.isFinished(from)) continue;

    const releasing = B.isInYard(from);
    if (releasing && dice !== cfg.TOKEN_RELEASE_ROLL) continue;

    let to = releasing ? 0 : from + dice;

    /**
     * Overshooting the centre.
     *
     * BOUNCE (default): the token walks up to the centre and the remaining
     * steps carry it back down the home column, so the full dice value is
     * always travelled. This is the standard rule and, crucially, it keeps the
     * move LEGAL — the previous behaviour dropped the move entirely, so a token
     * near home could not move at all and the turn silently passed.
     *
     * When EXACT_FINISH_REQUIRED is set the move is suppressed instead.
     */
    let bounced = false;
    if (to > B.FINISH_PROGRESS) {
      if (cfg.EXACT_FINISH_REQUIRED) continue;
      to = B.FINISH_PROGRESS - (to - B.FINISH_PROGRESS);
      bounced = true;
      // A bounce can never leave the home column, so this stays > ring range.
      if (to <= B.LAST_RING_PROGRESS) continue;
    }

    const destKey = B.cellKey(token.color, to);
    const destOccupants = occ.get(destKey) ?? [];

    // Own-token stacking.
    const ownAtDest = destOccupants.filter((t) => t.seat === seat);
    if (!cfg.STACKING_ENABLED && ownAtDest.length > 0) continue;

    // Blocks along the way (and on the destination itself).
    if (cfg.BLOCKING_ENABLED) {
      let blocked = false;
      for (const p of B.pathBetween(token.color, from, to, bounced)) {
        const occupants = occ.get(B.cellKey(token.color, p));
        if (isBlockedFor(occupants, seat)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
    }

    // Captures: only on the ring, only on an unsafe square.
    let captures = [];
    if (B.isOnRing(to)) {
      const destRing = B.ringIndexFor(token.color, to);
      const destIsSafe = cfg.SAFE_CELLS_ENABLED && B.isSafeRingIndex(destRing);
      if (!destIsSafe) {
        captures = destOccupants
          .filter((t) => t.seat !== seat)
          .map((t) => ({ seat: t.seat, tokenIndex: t.tokenIndex, color: t.color, from: t.progress }));
      } else if (destOccupants.some((t) => t.seat !== seat)) {
        // Safe square already holding an opponent — shared, never captured.
        captures = [];
      }
    }

    moves.push({
      tokenIndex: token.tokenIndex,
      from,
      to,
      releases: releasing,
      finishes: to === B.FINISH_PROGRESS,
      captures,
      bounced,
      path: B.pathBetween(token.color, from, to, bounced),
    });
  }

  return moves;
}

export function findMove(state, seat, dice, tokenIndex) {
  return legalMoves(state, seat, dice).find((m) => m.tokenIndex === tokenIndex) ?? null;
}

/** True once all four of a seat's tokens are on the centre. */
export function hasWon(state, seat) {
  const mine = tokensOf(state, seat);
  return mine.length > 0 && mine.every((t) => B.isFinished(t.progress));
}

/**
 * Ranks a timed-out or disconnected player's position by progress, used when a
 * game ends early. Higher is better.
 */
export function progressScore(state, seat) {
  return tokensOf(state, seat).reduce((sum, t) => sum + Math.max(t.progress, 0), 0);
}

/**
 * Preferred move when the server has to play for someone (turn timeout).
 * Deterministic and rule-abiding: it uses `legalMoves` output only, and never
 * sees information a player could not see.
 */
export function preferredAutoMove(moves) {
  if (moves.length === 0) return null;
  const rank = (m) => {
    if (m.finishes) return 0;
    if (m.captures.length > 0) return 1;
    if (m.releases) return 2;
    return 3;
  };
  return [...moves].sort(
    (a, b) => rank(a) - rank(b) || b.to - a.to || a.tokenIndex - b.tokenIndex,
  )[0];
}
