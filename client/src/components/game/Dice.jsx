/**
 * A real 3D die.
 *
 * ===========================================================================
 * How this works
 * ===========================================================================
 *
 * Six faces on a CSS cube. While rolling, the cube spins continuously from a
 * keyframe animation — no JS per frame, so the tumble cannot stutter when the
 * main thread is busy replaying a move. When the roll ends, the animation is
 * removed and ONE transform is written: the fixed rotation that brings the
 * server's face to the camera.
 *
 * That last part is the whole design. The value is never invented here and
 * never interpolated toward — `FACE_ROTATION[value]` is a constant, so the face
 * you end up looking at is exactly the number the server rolled.
 *
 * The earlier cube failed because it drove the spin and the settle as two
 * competing transitions on the same property; the browser coalesced them and
 * the die appeared to hang mid-tumble and then snap. Here the two states are
 * mutually exclusive: `--rolling` runs an animation and no transition,
 * `--settled` runs a transition and no animation.
 */
import { useEffect, useRef, useState } from 'react';
import './dice.css';

/**
 * Rotation that brings each face to the front.
 *
 * These must match the face layout in the markup below. Front=1, back=6,
 * right=5, left=2, top=3, bottom=4 — opposite faces sum to seven, as on a
 * real die.
 */
const FACE_ROTATION = {
  1: { x: 0, y: 0 },
  2: { x: 0, y: 90 },
  3: { x: -90, y: 0 },
  4: { x: 90, y: 0 },
  5: { x: 0, y: -90 },
  6: { x: 0, y: 180 },
};

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

function Face({ value, className }) {
  return (
    <span className={`die__face ${className}`}>
      {PIPS[value].map(([col, row], i) => (
        <span key={i} className="die__pip" style={{ gridColumn: col, gridRow: row }} />
      ))}
    </span>
  );
}

export function Dice({ value, phase, canRoll, onRoll, disabled, hint }) {
  const rolling = phase === 'rolling';

  /**
   * Whole turns accumulated so far.
   *
   * The settle always rotates FORWARD from wherever the tumble left off — it
   * adds a multiple of 360 to the target angle. Without this the die would
   * visibly spin backwards to reach the same face, which reads as the die
   * changing its mind about the result.
   */
  const turns = useRef(0);
  const [settle, setSettle] = useState(null);

  useEffect(() => {
    if (rolling) {
      // Each roll winds the die on a few more whole turns than the last, so
      // consecutive rolls never settle from the same angle.
      turns.current += 3 + Math.floor(Math.random() * 3);
      setSettle(null);
      return;
    }
    if (!value || !FACE_ROTATION[value]) return;

    const target = FACE_ROTATION[value];
    setSettle({
      x: turns.current * 360 + target.x,
      y: turns.current * 360 + target.y,
    });
  }, [rolling, value]);

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
        <span className="die__stage">
          <span
            className="die"
            style={
              settle
                ? { transform: `rotateX(${settle.x}deg) rotateY(${settle.y}deg)` }
                : undefined
            }
          >
            <Face value={1} className="die__face--front" />
            <Face value={6} className="die__face--back" />
            <Face value={5} className="die__face--right" />
            <Face value={2} className="die__face--left" />
            <Face value={3} className="die__face--top" />
            <Face value={4} className="die__face--bottom" />
          </span>
        </span>
      </button>

      {hint && <span className="dice-zone__hint">{hint}</span>}
    </div>
  );
}
