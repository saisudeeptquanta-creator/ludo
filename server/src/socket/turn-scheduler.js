/**
 * Server-side turn clock.
 *
 * The client's countdown is cosmetic — it renders `turnDeadlineAt` against a
 * server timestamp it was handed. This module owns the real deadline: when it
 * fires, the server plays or skips the turn, so a player who closes their
 * laptop cannot stall a game.
 *
 * Timers are keyed by gameId with the turn number they were armed for, which
 * makes a stale timer harmless: the game service ignores it if the turn already
 * moved on.
 */
import { logger } from '../utils/logger.js';

export class TurnScheduler {
  /**
   * @param {(gameId:number, turnNumber:number) => void} onExpire
   */
  constructor(onExpire) {
    this.onExpire = onExpire;
    /** gameId -> { timer, turnNumber } */
    this.timers = new Map();
  }

  /** Arms (or re-arms) the clock for a game's current turn. */
  arm(gameId, turnNumber, deadlineAt) {
    this.clear(gameId);
    if (!deadlineAt) return;

    const delay = Math.max(0, deadlineAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(gameId);
      try {
        this.onExpire(gameId, turnNumber);
      } catch (err) {
        logger.error('turn_scheduler.expire_failed', { err, gameId, turnNumber });
      }
    }, delay);
    timer.unref?.();
    this.timers.set(gameId, { timer, turnNumber });
  }

  /** Arms from a game DTO / engine state. */
  sync(state) {
    if (!state || state.status !== 'active' || !state.turnDeadlineAt) {
      this.clear(state?.id);
      return;
    }
    this.arm(state.id, state.turnNumber, state.turnDeadlineAt);
  }

  clear(gameId) {
    if (gameId == null) return;
    const entry = this.timers.get(gameId);
    if (entry) {
      clearTimeout(entry.timer);
      this.timers.delete(gameId);
    }
  }

  clearAll() {
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  get size() {
    return this.timers.size;
  }
}
