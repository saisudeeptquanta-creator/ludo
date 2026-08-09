/**
 * The die.
 *
 * ===========================================================================
 * How this works
 * ===========================================================================
 *
 * The die is a flat 2D face that CYCLES through random faces while rolling and
 * then stops on the server's value. There is no 3D cube and no CSS transition
 * driving the outcome.
 *
 * That is the whole point of this design. A transition-based cube has to be
 * told "spin now" and later "settle there" as two separate style writes, and
 * whichever way you sequence them the browser can coalesce the two into one
 * transition — the die then appears to hang on some arbitrary face and jump
 * straight to the result without a visible tumble.
 *
 * Here the face shown while rolling is just state, advanced on a timer. When
 * the roll ends we write the real value once. The last frame of the tumble and
 * the result are rendered by the same code path, so there is nothing to
 * interrupt and nothing to settle: the number simply stops changing.
 */
import { useEffect, useRef, useState } from 'react';
import './dice.css';

/** How often the face changes mid-tumble. */
const CYCLE_MS = 70;

/**
 * Pip positions per face as explicit [column, row] on a 3x3 grid.
 *
 * Placing each pip by coordinate — rather than filling nine cells in order —
 * keeps every face aligned: the grid tracks are fixed, so a face with two pips
 * and a face with six share identical geometry.
 */
const PIPS = {
  1: [[2, 2]],
  2: [[1, 1], [3, 3]],
  3: [[1, 1], [2, 2], [3, 3]],
  4: [[1, 1], [3, 1], [1, 3], [3, 3]],
  5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]],
  6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]],
};

function Face({ value }) {
  return (
    <span className="die__face">
      {(PIPS[value] ?? PIPS[1]).map(([col, row], i) => (
        <span key={i} className="die__pip" style={{ gridColumn: col, gridRow: row }} />
      ))}
    </span>
  );
}

export function Dice({ value, phase, canRoll, onRoll, disabled, hint }) {
  const rolling = phase === 'rolling';

  // The face currently painted. While rolling this is decorative noise; the
  // moment the roll ends it is replaced by the server's value, below.
  const [face, setFace] = useState(1);
  const timer = useRef(null);

  useEffect(() => {
    if (!rolling) {
      clearInterval(timer.current);
      return undefined;
    }
    // Cycle faces, never repeating the one on screen — a repeat reads as the
    // die having stopped early, which is exactly the stutter being fixed.
    timer.current = setInterval(() => {
      setFace((prev) => {
        let next = prev;
        while (next === prev) next = 1 + Math.floor(Math.random() * 6);
        return next;
      });
    }, CYCLE_MS);
    return () => clearInterval(timer.current);
  }, [rolling]);

  // The authoritative write. Once the animator leaves the rolling phase, the
  // face IS the server's number — this is the only place a result is shown.
  useEffect(() => {
    if (!rolling && value) setFace(value);
  }, [rolling, value]);

  const shown = rolling ? face : (value ?? face);

  const label = rolling
    ? 'Rolling'
    : value
      ? `Dice shows ${value}`
      : canRoll
        ? 'Tap to roll the dice'
        : 'Dice';

  return (
    <div className="dice-zone">
      <button
        className={[
          'die-btn',
          canRoll && !disabled && 'die-btn--ready',
          rolling && 'die-btn--rolling',
          !rolling && value && 'die-btn--settled',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={canRoll && !disabled ? onRoll : undefined}
        disabled={!canRoll || disabled}
        aria-label={label}
        aria-live="polite"
      >
        <span className="die-btn__glow" aria-hidden="true" />
        {/* Keyed on the face so each change restarts the shake/pop keyframes,
            giving the tumble motion without any transition to interrupt. */}
        <span className="die__body" key={rolling ? `r${shown}` : `s${shown}`}>
          <Face value={shown} />
        </span>
      </button>

      {hint && <span className="dice-zone__hint">{hint}</span>}
    </div>
  );
}
