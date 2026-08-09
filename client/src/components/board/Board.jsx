/**
 * The Ludo board.
 *
 * One inline SVG on a 15x15 unit viewBox: every coordinate below is simply a
 * board square, and the whole thing scales crisply from a 320px phone to a
 * desktop. Geometry comes from the server's engine module, so the square a token
 * is drawn on is by construction the square the rules validated against.
 *
 * The board rotates so YOUR colour is always bottom-left; tokens counter-rotate
 * to stay upright.
 */
import { memo, useMemo } from 'react';
import * as B from '@engine/board.js';
import './board.css';

const N = B.GRID_SIZE; // 15

/** Spin that brings each colour's yard to the bottom-left corner. */
const SEAT_ROTATION = { RED: 0, GREEN: -90, YELLOW: 180, BLUE: 90 };

/** Unit vector from the centre out along each colour's home triangle. */
const HOME_DIRECTION = {
  RED: { x: 0, y: 1 },
  GREEN: { x: -1, y: 0 },
  YELLOW: { x: 0, y: -1 },
  BLUE: { x: 1, y: 0 },
};

/** Direction of travel at each entry square, for the arrow marker. */
const ENTRY_ROTATION = { RED: -90, GREEN: 0, YELLOW: 90, BLUE: 180 };

const RING_INFO = B.RING.map((cell, index) => ({
  row: cell[0],
  col: cell[1],
  index,
  entryColor: B.entryOwner(index),
  isStar: B.STAR_RING_INDICES.has(index),
}));

/** Five-pointed star centred on (0,0). */
function starPath(outer = 0.3, inner = 0.13) {
  const points = [];
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    points.push(`${(Math.cos(a) * r).toFixed(4)},${(Math.sin(a) * r).toFixed(4)}`);
  }
  return `M${points.join('L')}Z`;
}
const STAR = starPath();

const CENTER_TRIANGLES = [
  { color: 'YELLOW', points: '6,6 9,6 7.5,7.5' },
  { color: 'BLUE', points: '9,6 9,9 7.5,7.5' },
  { color: 'RED', points: '9,9 6,9 7.5,7.5' },
  { color: 'GREEN', points: '6,9 6,6 7.5,7.5' },
];

/* ------------------------------------------------------------------ token -- */

function Token({
  x, y, color, size, movable, dimmed, walking, landed, captured, finished,
  count, boardRotation, onClick, label,
}) {
  const r = size / 2;
  return (
    <g
      className={[
        'tk',
        `c-${color}`,
        movable && 'tk--movable',
        dimmed && 'tk--dim',
        walking && 'tk--walking',
        landed && 'tk--landed',
        captured && 'tk--captured',
        finished && 'tk--finished',
      ].filter(Boolean).join(' ')}
      style={{ transform: `translate(${x}px, ${y}px)` }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick(e) : undefined}
      aria-label={label}
    >
      {movable && <circle className="tk__halo" r={r * 1.4} />}

      {/* `tk__spin` keeps the piece upright against the board rotation.
          There is deliberately NO `key={hop}` here: re-keying remounted this
          subtree on every square, which restarted the CSS transform transition
          from scratch mid-slide and made the token visibly skip squares — the
          count on the board then disagreed with the die. The piece now slides
          continuously and lands on exactly the square the server sent. */}
      <g className="tk__lift">
        <g className="tk__spin" style={{ transform: `rotate(${-boardRotation}deg)` }}>
          {/* Contact shadow, then a solid disc with a rim and a highlight.
              A filled disc reads far better at thumbnail size than an outlined
              pawn, which washed out against the coloured yards. */}
          <ellipse className="tk__shadow" cx="0" cy={r * 0.5} rx={r * 0.72} ry={r * 0.24} />
          <circle className="tk__rim" r={r * 0.92} />
          <circle className="tk__disc" r={r * 0.74} />
          <circle className="tk__inner" r={r * 0.4} />
          <ellipse className="tk__gloss" cx={-r * 0.24} cy={-r * 0.34} rx={r * 0.3} ry={r * 0.2} />

          {count > 1 && (
            <g className="tk__stack" transform={`translate(${r * 0.62}, ${r * 0.62})`}>
              <circle r={r * 0.44} />
              <text dy={r * 0.16} textAnchor="middle">{count}</text>
            </g>
          )}
        </g>
      </g>
    </g>
  );
}

/* ---------------------------------------------------------------- surface -- */

const BoardSurface = memo(function BoardSurface() {
  return (
    <>
      <defs>
        <linearGradient id="feltGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fdfdff" />
          <stop offset="100%" stopColor="#e8ecf8" />
        </linearGradient>
        <radialGradient id="yardShade" cx="42%" cy="34%" r="76%">
          <stop offset="0%" stopColor="rgb(255 255 255 / 0.30)" />
          <stop offset="100%" stopColor="rgb(0 0 0 / 0.26)" />
        </radialGradient>
        <filter id="pieceShadow" x="-70%" y="-70%" width="240%" height="240%">
          <feDropShadow dx="0" dy="0.09" stdDeviation="0.07" floodColor="#0a0d1c" floodOpacity="0.5" />
        </filter>
        <filter id="innerSoft" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0.05" stdDeviation="0.05" floodColor="#000" floodOpacity="0.22" />
        </filter>
      </defs>

      <rect x="0" y="0" width={N} height={N} rx="0.5" fill="url(#feltGrad)" />

      {/* Corner yards. */}
      {B.COLORS.map((color) => {
        const [r, c] = B.YARD_ORIGIN[color];
        return (
          <g key={color} className={`yard c-${color}`}>
            <rect x={c} y={r} width="6" height="6" rx="0.8" className="yard__field" />
            <rect x={c} y={r} width="6" height="6" rx="0.8" fill="url(#yardShade)" />
            <rect
              x={c + 0.8} y={r + 0.8} width="4.4" height="4.4" rx="0.6"
              className="yard__pocket" filter="url(#innerSoft)"
            />
            {B.YARD_SLOTS[color].map(([sr, sc], i) => (
              <g key={i}>
                <circle cx={sc + 0.5} cy={sr + 0.5} r="0.44" className="yard__ring" />
                <circle cx={sc + 0.5} cy={sr + 0.5} r="0.3" className="yard__dot" />
              </g>
            ))}
          </g>
        );
      })}

      {/* Track. */}
      {RING_INFO.map((sq) => (
        <g key={sq.index} className={sq.entryColor ? `c-${sq.entryColor}` : undefined}>
          <rect
            x={sq.col} y={sq.row} width="1" height="1" rx="0.1"
            className={`sq ${sq.entryColor ? 'sq--entry' : sq.isStar ? 'sq--star' : 'sq--plain'}`}
          />
          {sq.isStar && (
            <path d={STAR} className="sq__star" transform={`translate(${sq.col + 0.5}, ${sq.row + 0.5})`} />
          )}
          {sq.entryColor && (
            <path
              d="M0,-0.24 L0.19,0.1 L0,0.02 L-0.19,0.1 Z"
              className="sq__arrow"
              transform={`translate(${sq.col + 0.5}, ${sq.row + 0.5}) rotate(${ENTRY_ROTATION[sq.entryColor]})`}
            />
          )}
        </g>
      ))}

      {/* Home columns. */}
      {B.COLORS.map((color) => (
        <g key={color} className={`c-${color}`}>
          {B.HOME_COLUMN[color].map(([r, c], i) => (
            <rect key={i} x={c} y={r} width="1" height="1" rx="0.1" className="sq sq--home" />
          ))}
        </g>
      ))}

      {B.CENTER_CORNERS.map(([r, c], i) => (
        <rect key={i} x={c} y={r} width="1" height="1" className="sq sq--corner" />
      ))}

      {/* Centre. */}
      <g className="centre">
        {CENTER_TRIANGLES.map((t) => (
          <polygon key={t.color} points={t.points} className={`centre__tri c-${t.color}`} />
        ))}
        <circle cx="7.5" cy="7.5" r="0.66" className="centre__hub" />
        <path d={starPath(0.44, 0.19)} className="centre__star" transform="translate(7.5, 7.5)" />
      </g>

      {/* Hairlines on top so squares read as a grid. */}
      <g className="grid-lines">
        {RING_INFO.map((sq) => (
          <rect key={sq.index} x={sq.col} y={sq.row} width="1" height="1" rx="0.1" />
        ))}
        {B.COLORS.flatMap((color) =>
          B.HOME_COLUMN[color].map(([r, c], i) => (
            <rect key={`${color}-${i}`} x={c} y={r} width="1" height="1" rx="0.1" />
          )),
        )}
      </g>
    </>
  );
});

/* ------------------------------------------------------------------ board -- */

export function Board({ game, movableTokens = [], onTokenClick, animating, capturedTokens = [] }) {
  const tokens = game?.tokens ?? [];
  const yourSeat = game?.you?.seat ?? null;
  const isYourTurn = game?.currentSeat === yourSeat && game?.status === 'active';
  const rotation = SEAT_ROTATION[game?.you?.color] ?? 0;

  const placed = useMemo(() => {
    const isWalker = (t) =>
      animating && animating.seat === t.seat && animating.tokenIndex === t.tokenIndex;

    /**
     * Group tokens by square so stacks can be fanned out. The walking token is
     * excluded: it passes over occupied squares, and joining each group in turn
     * would shove it sideways every step.
     */
    const byCell = new Map();
    for (const t of tokens) {
      if (isWalker(t)) continue;
      const key = B.cellKey(t.color, t.progress);
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push(t);
    }

    const out = [];
    for (const group of byCell.values()) {
      group.forEach((t, i) => {
        const [row, col] = B.coordFor(t.color, t.progress, t.tokenIndex);
        let x = col + 0.5;
        let y = row + 0.5;
        let count = i === 0 ? group.length : 0;

        if (B.isFinished(t.progress)) {
          // Every colour's finished tokens share the centre cell, so fan them
          // along their own home triangle instead of piling up.
          const dir = HOME_DIRECTION[t.color];
          const lane = (i - (group.length - 1) / 2) * 0.3;
          x = 7.5 + dir.x * 0.85 + dir.y * lane;
          y = 7.5 + dir.y * 0.85 - dir.x * lane;
          count = 0;
        } else if (group.length > 1) {
          const a = (i / group.length) * Math.PI * 2 - Math.PI / 2;
          x += Math.cos(a) * 0.16;
          y += Math.sin(a) * 0.16;
        }

        out.push({
          ...t,
          x, y, count,
          inYard: B.isInYard(t.progress),
          finished: B.isFinished(t.progress),
        });
      });
    }

    // The walker is drawn last, centred, entirely from animation state — the
    // snapshot already holds it at its destination.
    if (animating) {
      const [row, col] = B.coordFor(animating.color, animating.progress, animating.tokenIndex);
      out.push({
        seat: animating.seat,
        tokenIndex: animating.tokenIndex,
        color: animating.color,
        x: col + 0.5,
        y: row + 0.5,
        count: 0,
        inYard: B.isInYard(animating.progress),
        finished: B.isFinished(animating.progress),
      });
    }
    return out;
  }, [tokens, animating]);

  return (
    <div className="board-wrap">
      <svg className="board" viewBox={`0 0 ${N} ${N}`} role="img" aria-label="Ludo board">
        <g
          className="board__rotor"
          style={{ transform: `rotate(${rotation}deg)`, transformOrigin: `${N / 2}px ${N / 2}px` }}
        >
          <BoardSurface />

          <g className="tokens" filter="url(#pieceShadow)">
            {placed.map((t) => {
              const yours = t.seat === yourSeat;
              const movable = yours && isYourTurn && movableTokens.includes(t.tokenIndex);
              const walking =
                animating?.seat === t.seat && animating?.tokenIndex === t.tokenIndex;
              const captured = capturedTokens.some(
                (c) => c.seat === t.seat && c.tokenIndex === t.tokenIndex,
              );
              return (
                <Token
                  key={`${t.seat}-${t.tokenIndex}`}
                  x={t.x}
                  y={t.y}
                  color={t.color}
                  size={t.inYard ? 0.76 : 0.88}
                  movable={movable}
                  dimmed={isYourTurn && yours && movableTokens.length > 0 && !movable}
                  walking={walking}
                  landed={walking && animating.landed}
                  captured={captured}
                  finished={t.finished}
                  count={t.count}
                  boardRotation={rotation}
                  onClick={movable ? () => onTokenClick?.(t.tokenIndex) : undefined}
                  label={`${t.color} token ${t.tokenIndex + 1}${movable ? ', tap to move' : ''}`}
                />
              );
            })}
          </g>
        </g>
      </svg>
    </div>
  );
}
