/**
 * A real 3D die.
 *
 * Six faces on a CSS cube. Rolling spins it on a random axis; the settle is a
 * fixed rotation per face, so the die always comes to rest showing exactly the
 * value the SERVER chose. The tumbling in between is decoration — the component
 * never invents an outcome.
 */
import { useEffect, useRef, useState } from 'react';
import './dice.css';

/** Rotation that brings each face to the front. */
const FACE_ROTATION = {
  1: { x: 0, y: 0 },
  2: { x: 0, y: -90 },
  3: { x: -90, y: 0 },
  4: { x: 90, y: 0 },
  5: { x: 0, y: 90 },
  6: { x: 0, y: 180 },
};

/**
 * Pip positions per face as explicit [column, row] on a 3x3 grid.
 *
 * Placing each pip by coordinate — rather than filling nine cells in order —
 * is what keeps every face perfectly aligned: the grid tracks are fixed, so a
 * face with two pips and a face with six share identical geometry.
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
    <div className={`die__face ${className}`}>
      {PIPS[value].map(([col, row], i) => (
        <span key={i} className="die__pip" style={{ gridColumn: col, gridRow: row }} />
      ))}
    </div>
  );
}

export function Dice({ value, phase, canRoll, onRoll, disabled, hint }) {
  // Accumulated spin, so consecutive rolls keep turning the same direction
  // instead of snapping backwards between them.
  const spins = useRef({ x: 0, y: 0 });
  const [transform, setTransform] = useState('rotateX(-20deg) rotateY(20deg)');

  useEffect(() => {
    if (phase === 'rolling') {
      // More rotation over a shorter duration, so the die reads as spinning
      // FAST rather than merely turning slowly.
      spins.current = {
        x: spins.current.x + 1440 + Math.floor(Math.random() * 4) * 90,
        y: spins.current.y + 1800 + Math.floor(Math.random() * 4) * 90,
      };
      setTransform(`rotateX(${spins.current.x}deg) rotateY(${spins.current.y}deg)`);
      return;
    }
    if (value && FACE_ROTATION[value]) {
      const target = FACE_ROTATION[value];
      // Land on the requested face at the next multiple of 360 past the spin.
      const x = Math.ceil(spins.current.x / 360) * 360 + target.x;
      const y = Math.ceil(spins.current.y / 360) * 360 + target.y;
      spins.current = { x, y };
      setTransform(`rotateX(${x}deg) rotateY(${y}deg)`);
    }
  }, [phase, value]);

  const label =
    phase === 'rolling'
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
          phase === 'rolling' && 'die-btn--rolling',
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
          <span className="die" style={{ transform }}>
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
