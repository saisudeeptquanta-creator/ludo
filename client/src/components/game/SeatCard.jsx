/**
 * A player's seat in the game HUD: who they are, tokens home, connection, and —
 * on their turn — a countdown ring driven by the server's deadline rather than a
 * local timer that could drift.
 */
import { useEffect, useState } from 'react';
import { Avatar, cx } from '../ui/index.jsx';
import './seat-card.css';

export function SeatCard({
  player,
  isCurrent,
  deadlineAt,
  serverSkew = 0,
  turnDurationMs = 25000,
  emote,
  tokenCount = 4,
  isMine,
}) {
  const [remaining, setRemaining] = useState(null);

  useEffect(() => {
    if (!isCurrent || !deadlineAt) {
      setRemaining(null);
      return undefined;
    }
    const tick = () =>
      setRemaining(Math.max(0, (deadlineAt - (Date.now() + serverSkew)) / 1000));
    tick();
    const id = setInterval(tick, 120);
    return () => clearInterval(id);
  }, [isCurrent, deadlineAt, serverSkew]);

  const finished = player.tokensFinished ?? 0;
  const seconds = remaining == null ? null : Math.ceil(remaining);
  const urgent = seconds != null && seconds <= 5;
  const fraction = remaining == null ? 0 : Math.min(1, remaining / (turnDurationMs / 1000));

  const R = 20;
  const CIRC = 2 * Math.PI * R;

  return (
    <div
      className={cx(
        'seatcard',
        `c-${player.color}`,
        isMine && 'seatcard--mine',
        isCurrent && 'seatcard--turn',
        !player.connected && 'seatcard--off',
        player.status === 'finished' && 'seatcard--done',
        player.status === 'left' && 'seatcard--left',
      )}
    >
      <div className="seatcard__avatar">
        <Avatar name={player.player?.name ?? '?'} avatar={player.player?.avatar ?? 0} size={38} />
        {isCurrent && seconds != null && (
          <svg className="seatcard__timer" viewBox="0 0 48 48" aria-hidden="true">
            <circle className="seatcard__timer-bg" cx="24" cy="24" r={R} />
            <circle
              className={cx('seatcard__timer-fg', urgent && 'is-urgent')}
              cx="24"
              cy="24"
              r={R}
              style={{ strokeDasharray: CIRC, strokeDashoffset: CIRC * (1 - fraction) }}
            />
          </svg>
        )}
        {!player.connected && <span className="seatcard__off-badge">⚠</span>}
      </div>

      <div className="seatcard__info">
        <span className="seatcard__name">
          {player.player?.name ?? 'Player'}
          {player.isYou && <span className="seatcard__you"> (you)</span>}
        </span>
        <span className="seatcard__pips" aria-label={`${finished} of ${tokenCount} home`}>
          {Array.from({ length: tokenCount }, (_, i) => (
            <i key={i} className={cx(i < finished && 'is-home')} />
          ))}
        </span>
      </div>

      {player.status === 'finished' && (
        <span className="seatcard__rank">#{player.finishedRank}</span>
      )}
      {isCurrent && seconds != null && (
        <span className={cx('seatcard__seconds', urgent && 'is-urgent')}>{seconds}</span>
      )}

      {emote && (
        <span className="seatcard__emote" key={emote.id}>
          {emote.emote}
        </span>
      )}
    </div>
  );
}
