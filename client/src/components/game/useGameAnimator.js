/**
 * Replays the server's event stream as visible motion.
 *
 * ===========================================================================
 * How this works, and why it is built this way
 * ===========================================================================
 *
 * The server emits events in BATCHES, and a roll and the move it causes land in
 * SEPARATE batches — the roll is sent when you tap, the move only once you pick
 * a token. Observed from the live server:
 *
 *     batch n   : ROLL(seat1)=6
 *     batch n+1 : MOVE(seat1) dice=6 len=1 (-1 -> 0) | EXTRA_TURN | TURN_STARTED
 *     batch n+2 : ROLL(seat1)=4
 *     batch n+3 : MOVE(seat1) dice=4 len=4 (0 -> 4) | TURN_STARTED
 *
 * Two consequences drive the whole design:
 *
 *  1. Events must be replayed as ONE continuous ordered stream. Treating each
 *     batch independently, or pairing a roll with a move inside a batch, gets
 *     the wrong dice against the wrong move.
 *
 *  2. A six grants an extra turn, so a NEW roll can arrive while the previous
 *     move is still animating. The die must therefore be driven by the event
 *     being replayed — never by the latest snapshot, and never by the roll
 *     acknowledgement, both of which run ahead of the animation.
 *
 * The invariants this module guarantees:
 *
 *  - Exactly one drain loop exists, process-wide. React StrictMode and remounts
 *    cannot create a second one (a per-component guard previously allowed two
 *    loops to walk the same token, doubling every move).
 *  - Events are consumed strictly in order, one at a time.
 *  - A token walks exactly `event.path` — never `event.dice`. They differ for a
 *    release, which costs a six but is a single hop out of the yard.
 *  - The die face shown during a move is the dice of THAT move.
 */
import { useEffect } from 'react';
import { useGame } from '../../store/game.js';
import { sfx } from '../../lib/audio.js';

/* --------------------------------------------------------------- timings -- */

const TIMING = {
  /** Per square walked. */
  step: 170,
  /** Faster when a move is long, so a six does not drag. */
  stepLong: 135,
  longMoveThreshold: 4,
  /** Beat on the origin square before the first hop, so it is visible. */
  liftOff: 60,
  /** Settle after the final square. */
  land: 190,
  /** Tumble shown for another player's roll (ours is already tumbling). */
  tumble: 460,
  /** Beat after the die settles, before the move plays. */
  afterRoll: 260,
  capture: 620,
  finish: 500,
  extraTurn: 260,
  notice: 380,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------ single-drainer control -- */

/** True while the drain loop is running. Module scope: exactly one loop ever. */
let draining = false;
/** Number of mounted animators; the loop stops when this reaches zero. */
let liveCount = 0;
/** The one store subscription, owned by whichever animator mounted first. */
let unsubscribe = null;

/* ------------------------------------------------------------ the replay -- */

/**
 * Walks one token along the path the server sent.
 *
 * `path` is authoritative and self-contained: it lists every square the token
 * passes through, ending on the destination. Its length equals the dice value
 * for a normal move, and is 1 for a release. Following it — rather than
 * counting out `dice` squares — is what makes both cases correct.
 */
async function playMove(event) {
  const path = event.path ?? [];
  if (path.length === 0) return;

  const token = {
    seat: event.seat,
    tokenIndex: event.tokenIndex,
    color: event.color,
  };
  const store = useGame.getState();
  const isRelease = event.from < 0;
  const step = path.length > TIMING.longMoveThreshold ? TIMING.stepLong : TIMING.step;

  // Show the token on its origin first so the first hop reads as movement.
  // A release has no origin square — it simply appears on the entry square.
  if (!isRelease) {
    store.setWalking({ ...token, progress: event.from, hop: -1 });
    await sleep(TIMING.liftOff);
  }

  for (let i = 0; i < path.length; i += 1) {
    if (liveCount === 0) return;
    // `hop` re-keys the arc animation so every square gets its own hop.
    useGame.getState().setWalking({ ...token, progress: path[i], hop: i });
    sfx.tokenStep(i);
    await sleep(step);
  }

  // Hold the landing pose so the arrival has weight.
  useGame.getState().setWalking({
    ...token,
    progress: path[path.length - 1],
    hop: path.length,
    landed: true,
  });
  await sleep(TIMING.land);
  useGame.getState().setWalking(null);
}

/** Settles the die on the value of the roll being replayed. */
async function playRoll(event, mySeat, fast) {
  const mine = event.seat === mySeat;

  if (mine) {
    // Our own die is already tumbling from the optimistic roll(); let it spin
    // a beat longer, then land it on the server's value.
    if (!fast) await sleep(TIMING.afterRoll);
  } else {
    useGame.getState().setDice({ value: event.value, phase: 'rolling' });
    sfx.diceRoll();
    if (!fast) await sleep(TIMING.tumble);
  }

  useGame.getState().setDice({ value: event.value, phase: 'result' });
  sfx.diceResult(event.value);
  if (!fast) await sleep(mine ? 160 : TIMING.afterRoll);
}

/**
 * Consumes the queue strictly in order until it is empty.
 *
 * Only one instance of this runs at a time; `draining` is module scope so no
 * amount of mounting can start a second.
 */
async function drain() {
  if (draining) return;
  draining = true;
  // Claim the die for the whole replay so snapshots cannot overwrite the face
  // while the move it belongs to is still walking.
  useGame.getState().setAnimating(true);

  try {
    while (liveCount > 0) {
      const event = useGame.getState().shift();
      if (!event) break;

      // A long backlog means we are catching up (reconnect, backgrounded tab).
      // Skip the theatre and converge on the truth.
      const fast = useGame.getState().queue.length > 10;
      const mySeat = useGame.getState().game?.you?.seat;

      switch (event.type) {
        case 'DICE_ROLLED':
          await playRoll(event, mySeat, fast);
          break;

        case 'TOKEN_MOVED':
          if (fast) useGame.getState().setWalking(null);
          else await playMove(event);
          break;

        case 'TOKEN_CAPTURED': {
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
          if (!fast) await sleep(TIMING.capture);
          useGame.getState().setCaptured([]);
          break;
        }

        case 'PLAYER_FINISHED':
          sfx.tokenHome();
          if (event.seat === mySeat) useGame.getState().flashBanner('ALL HOME!');
          if (!fast) await sleep(TIMING.finish);
          break;

        case 'EXTRA_TURN':
          if (event.seat === mySeat) {
            sfx.extraTurn();
            useGame
              .getState()
              .flashBanner(event.reason === 'six' ? 'ROLL AGAIN!' : 'EXTRA TURN!');
          }
          if (!fast) await sleep(TIMING.extraTurn);
          break;

        case 'NO_LEGAL_MOVE':
          if (event.seat === mySeat) useGame.getState().flashBanner('NO MOVES');
          if (!fast) await sleep(TIMING.notice);
          break;

        case 'TURN_FORFEITED':
          if (event.seat === mySeat) {
            useGame
              .getState()
              .flashBanner(event.reason === 'three_sixes' ? 'THREE SIXES!' : 'TIME UP');
          }
          if (!fast) await sleep(TIMING.notice);
          break;

        default:
          break;
      }
    }
  } finally {
    draining = false;
    useGame.getState().setWalking(null);
    useGame.getState().setAnimating(false);
    // Everything queued has now been shown, so the die may safely reset if the
    // turn has moved on. Doing this any earlier races the walk.
    useGame.getState().clearDice();
  }
}

/* -------------------------------------------------------------- the hook -- */

export function useGameAnimator() {
  useEffect(() => {
    liveCount += 1;

    // Only the first mount owns the subscription; later mounts share it.
    if (!unsubscribe) {
      unsubscribe = useGame.subscribe((state, previous) => {
        if (state.queue.length && state.queue !== previous.queue) drain();
      });
    }
    if (useGame.getState().queue.length) drain();

    return () => {
      liveCount -= 1;
      if (liveCount === 0) {
        unsubscribe?.();
        unsubscribe = null;
      }
    };
  }, []);
}
