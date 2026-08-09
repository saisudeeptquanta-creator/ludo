/** The 3 · 2 · 1 · GO between the host starting and the board appearing. */
import { useEffect, useState } from 'react';
import { useRoom } from '../store/game.js';
import { sfx } from '../lib/audio.js';
import './countdown.css';

export default function Countdown() {
  const countdown = useRoom((s) => s.countdown);
  const [left, setLeft] = useState(3);

  useEffect(() => {
    if (!countdown) return undefined;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((countdown.startsAt - Date.now()) / 1000));
      setLeft(seconds);
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [countdown]);

  useEffect(() => {
    if (left > 0) sfx.countdown();
    else sfx.go();
  }, [left]);

  return (
    <div className="countdown">
      <div className="countdown__ring" aria-hidden="true" />
      <div className="countdown__value" key={left} role="status" aria-live="assertive">
        {left > 0 ? left : 'GO!'}
      </div>
      <p className="countdown__label">Get ready…</p>
    </div>
  );
}
