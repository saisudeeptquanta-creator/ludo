/**
 * Replays the server's event stream as visible motion.
 *
 * ===========================================================================
 * How this works
 * ===========================================================================
 *
 * A move is shown by walking `event.path` — one hop per entry — and the die
 * beside it is `event.dice`, BOTH read off the same event object at the same
 * instant. Nothing else writes either one, so the number of squares travelled
 * cannot disagree with the number on the die.
 *
 * ---------------------------------------------------------------------------
 * Motion
 * ---------------------------------------------------------------------------
 *
 * Each hop is driven by requestAnimationFrame, not by a `setTimeout` writing a
 * position that a CSS transition then chases. The walker publishes a
 * FRACTIONAL progress (`from` -> `to`, eased) on every frame, and the board
 * draws exactly where it is told.
 *
 * This is the important difference from the previous approach. There, the step
 * timer and the CSS transition were two independent clocks, and whenever the
 * transition outlasted the step it was cut off mid-slide — the piece skipped
 * squares and arrived early, which is what made the travelled count look wrong.
 * With one clock there is nothing to fall behind: the hop is finished before
 * the next one is started, always.
 *
 * The token also arcs upward across each hop, so a move reads as a sequence of
 * distinct jumps you can count, rather than one continuous slide.
 *
 * ---------------------------------------------------------------------------
 * Concurrency
 * ---------------------------------------------------------------------------
 *
 * Exactly one replay runs process-wide. `runToken` is bumped whenever the board
 * resets; any in-flight replay holding a stale token exits at its next
 * checkpoint, so a reset can never leave a ghost walker behind.
 */
import { useEffect } from 'react';
import { useGame } from '../../store/game.js';
import { sfx } from '../../lib/audio.js';

/* --------------------------------------------------------------- timings -- */

/**
 * Duration of a single hop, square to square.
 *
 * Fast enough that a six takes well under a second, slow enough that the hops
 * stay individually countable — below roughly 70ms they blur into one slide
 * and the move stops being readable.
 */
const HOP_MS = 105;
/** Hop duration once a path is long, so a six does not drag. */
const HOP_FAST_MS = 82;
const LONG_PATH = 4;
/** Beat between hops — the pause is what makes them read as separate jumps. */
const HOP_GAP_MS = 14;

/** How long the die visibly tumbles before showing its value. */
const DICE_SPIN_MS = 440;
/** How long the settled value is held before the token starts moving. */
const DICE_HOLD_MS = 190;

const LAND_MS = 110;
const CAPTURE_MS = 300;
const FINISH_MS = 240;
const NOTICE_MS = 190;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------- state -- */

let running = false;
let mounted = 0;
let unsubscribe = null;
/** Bumped on reset; a replay whose token is stale aborts. */
let runToken = 0;

const alive = (token) => token === runToken && mounted > 0;

/* ------------------------------------------------------------------ hop -- */

/** Ease-in-out: the token leaves and arrives gently, sprints in between. */
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Animates one square-to-square hop and resolves when it has fully landed.
 *
 * Resolving only at the end is what serialises the walk: the caller cannot
 * start the next hop while this one is still in the air, so no hop is ever
 * truncated and the piece lands on every square it is supposed to touch.
 */
function hop(base, from, to, duration, token) {
  return new Promise((resolve) => {
    const start = performance.now();

    const frame = (now) => {
      if (!alive(token)) {
        resolve();
        return;
      }
      const t = Math.min(1, (now - start) / duration);
      const e = ease(t);

      useGame.getState().setWalking({
        ...base,
        // Whole square the token belongs to — what the board resolves to a cell.
        progress: to,
        // Fractional position for drawing: the board interpolates `from`->`to`.
        fromProgress: from,
        hopT: e,
        // A half-sine arc: zero at both ends, highest at the midpoint.
        lift: Math.sin(Math.PI * t),
      });

      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };

    requestAnimationFrame(frame);
  });
}

/**
 * Walks one token along `event.path`.
 *
 * `path` is authoritative and complete: it lists every square the token passes
 * through, ending on the destination. Its length always equals the number of
 * squares the move is worth — 1 for a release out of the yard, and for a bounce
 * off the centre it already includes the squares walked back down. The walk
 * follows `path` and never re-derives a count from the dice.
 */
async function walk(event, token) {
  const path = event.path ?? [];
  if (path.length === 0) return;

  const duration = path.length >= LONG_PATH ? HOP_FAST_MS : HOP_MS;
  const base = {
    seat: event.seat,
    tokenIndex: event.tokenIndex,
    color: event.color,
    // The die travels WITH the walker, so whatever is on screen beside the
    // piece is by construction the value this move was made with.
    dice: event.dice ?? null,
  };

  // A release out of the yard has no origin square to leave from; it hops in
  // place onto the entry square.
  let cursor = event.from >= 0 ? event.from : path[0];

  useGame.getState().setWalking({ ...base, progress: cursor, fromProgress: cursor, hopT: 1, lift: 0 });
  await sleep(30);
  if (!alive(token)) return;

  for (let i = 0; i < path.length; i += 1) {
    if (!alive(token)) return;
    sfx.tokenStep(i);
    await hop(base, cursor, path[i], duration, token);
    cursor = path[i];
    if (i < path.length - 1) await sleep(HOP_GAP_MS);
  }

  if (!alive(token)) return;
  sfx.tokenLand();
  useGame.getState().setWalking({
    ...base,
    progress: cursor,
    fromProgress: cursor,
    hopT: 1,
    lift: 0,
    landed: true,
  });
  await sleep(LAND_MS);
}

/* ------------------------------------------------------------------ roll -- */

/**
 * Shows the die tumbling, then settles it on the value being replayed.
 *
 * Both the roller and the watchers get the same visible tumble. Previously the
 * roller skipped it — the store had already started spinning on tap — which
 * made the die look like it stopped early and then changed its mind.
 */
async function showRoll(event, token) {
  useGame.getState().setDice({ value: null, phase: 'rolling' });
  sfx.diceRoll();
  await sleep(DICE_SPIN_MS);
  if (!alive(token)) return;

  useGame.getState().setDice({ value: event.value, phase: 'result' });
  sfx.diceResult(event.value);
  await sleep(DICE_HOLD_MS);
}

/* ---------------------------------------------------------------- replay -- */

async function replay() {
  if (running) return;
  running = true;
  const token = runToken;
  useGame.getState().setAnimating(true);

  try {
    while (alive(token)) {
      const event = useGame.getState().shift();
      if (!event) break;

      // A deep backlog means we are catching up after a reconnect or a
      // backgrounded tab. Skip the theatre and converge on the truth.
      const catchUp = useGame.getState().queue.length > 8;
      const mySeat = useGame.getState().game?.you?.seat;

      switch (event.type) {
        case 'DICE_ROLLED':
          if (catchUp) useGame.getState().setDice({ value: event.value, phase: 'result' });
          else await showRoll(event, token);
          break;

        case 'TOKEN_MOVED':
          if (catchUp) useGame.getState().setWalking(null);
          else await walk(event, token);
          break;

        case 'TOKEN_CAPTURED':
          useGame.getState().setCaptured([{ seat: event.seat, tokenIndex: event.tokenIndex }]);
          if (event.bySeat === mySeat) {
            sfx.capture();
            useGame.getState().flashBanner('CAPTURE!');
          } else if (event.seat === mySeat) {
            sfx.captured();
            useGame.getState().flashBanner('CAPTURED!');
          } else {
            sfx.capture();
          }
          if (!catchUp) await sleep(CAPTURE_MS);
          useGame.getState().setCaptured([]);
          break;

        case 'PLAYER_FINISHED':
          sfx.tokenHome();
          if (event.seat === mySeat) useGame.getState().flashBanner('ALL HOME!');
          if (!catchUp) await sleep(FINISH_MS);
          break;

        case 'EXTRA_TURN':
          if (event.seat === mySeat) {
            sfx.extraTurn();
            useGame
              .getState()
              .flashBanner(event.reason === 'six' ? 'ROLL AGAIN!' : 'EXTRA TURN!');
          }
          if (!catchUp) await sleep(NOTICE_MS);
          break;

        case 'NO_LEGAL_MOVE':
          if (event.seat === mySeat) useGame.getState().flashBanner('NO MOVES');
          if (!catchUp) await sleep(NOTICE_MS);
          break;

        case 'TURN_FORFEITED':
          if (event.seat === mySeat) {
            useGame
              .getState()
              .flashBanner(event.reason === 'three_sixes' ? 'THREE SIXES!' : 'TIME UP');
          }
          if (!catchUp) await sleep(NOTICE_MS);
          break;

        default:
          break;
      }
    }
  } finally {
    running = false;
    if (alive(token)) {
      // Drop the walker only now: the snapshot already holds the token at its
      // destination, so the piece stays exactly where the walk left it.
      useGame.getState().setWalking(null);
      useGame.getState().setAnimating(false);
      useGame.getState().clearDice();
    }
    // Events that arrived while the loop was finishing.
    if (useGame.getState().queue.length > 0) replay();
  }
}

/** Aborts any in-flight replay. Called when the board is torn down. */
export function abortReplay() {
  runToken += 1;
  running = false;
}

/* ------------------------------------------------------------------ hook -- */

export function useGameAnimator() {
  useEffect(() => {
    mounted += 1;

    // Let a store reset abort a walk in progress (see `reset` in the store).
    useGame.getState().setResetHook(abortReplay);

    if (!unsubscribe) {
      unsubscribe = useGame.subscribe((state, prev) => {
        if (state.queue.length > 0 && state.queue !== prev.queue) replay();
      });
    }
    if (useGame.getState().queue.length > 0) replay();

    return () => {
      mounted -= 1;
      if (mounted === 0) {
        unsubscribe?.();
        unsubscribe = null;
      }
    };
  }, []);
}
