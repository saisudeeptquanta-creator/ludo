/** End-of-game overlay: final standings and a way back. */
import { Avatar, Button, Confetti, Chip, cx } from '../ui/index.jsx';
import './game-result.css';

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

export function GameResult({ results, yourSeat, onExit }) {
  if (!results) return null;

  const you = results.standings.find((s) => s.seat === yourSeat);
  const cancelled = results.status === 'cancelled';
  const minutes = results.durationMs ? Math.round(results.durationMs / 60000) : 0;

  /**
   * A win means four tokens home — not merely being the last one connected.
   * The server flags the difference so we never congratulate someone whose
   * opponent simply walked away.
   */
  const byDefault = results.endReason === 'opponents_left' || results.endReason === 'abandoned';
  const won = you?.rank === 1 && !byDefault && you?.tokensFinished === 4;

  const title = cancelled
    ? 'Game ended'
    : byDefault
      ? 'Game abandoned'
      : won
        ? 'You Win!'
        : 'Good game!';

  const subtitle = cancelled
    ? 'This game finished early.'
    : byDefault
      ? 'The other players left, so the game could not be finished.'
      : won
        ? 'All four tokens home.'
        : `You finished ${you?.rank ? `#${you.rank}` : 'the game'}.`;

  return (
    <div className="result" role="dialog" aria-modal="true" aria-label="Game over">
      {won && <Confetti />}

      <div className="result__card">
        <div className={cx('result__crest', won && 'is-win')} aria-hidden="true">
          {cancelled || byDefault ? '🏳️' : won ? '👑' : MEDAL[you?.rank] ?? '🎲'}
        </div>

        <h2 className="result__title">{title}</h2>
        <p className="result__sub">{subtitle}</p>

        <div className="result__list">
          {results.standings.map((s) => (
            <div
              key={s.id}
              className={cx('result__row', `c-${s.color}`, s.seat === yourSeat && 'is-you')}
            >
              <span className="result__rank">{s.rank ? MEDAL[s.rank] ?? `#${s.rank}` : '—'}</span>
              <Avatar name={s.name} avatar={s.avatar} size={38} color={s.color} ring />
              <div className="result__who">
                <strong>
                  {s.name}
                  {s.seat === yourSeat && <span className="subtle"> (you)</span>}
                </strong>
                <span className="subtle">
                  {s.tokensFinished}/4 home · {s.captures} captures
                </span>
              </div>
              {s.status === 'left' && <Chip tone="danger">left</Chip>}
            </div>
          ))}
        </div>

        {minutes > 0 && <p className="result__meta">Game lasted {minutes} min</p>}

        <div className="result__actions">
          <Button size="lg" variant="gold" full onClick={onExit}>
            Back to Home
          </Button>
        </div>
      </div>
    </div>
  );
}
