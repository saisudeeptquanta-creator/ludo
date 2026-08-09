/**
 * The board screen.
 *
 * Renders the server's authoritative snapshot and sends intents. It computes
 * nothing about the rules: which tokens glow comes from `game.legalMoves`, which
 * the server calculated for this viewer alone.
 *
 * Layout is a fixed three-row grid — seats, board, controls — so the board never
 * gets pushed off-screen and the dice stays under the thumb.
 */
import { useEffect, useMemo, useState } from 'react';
import { useGame, useSession } from '../store/game.js';
import { send, onStatus, getStatus } from '../lib/socket.js';
import { Board } from '../components/board/Board.jsx';
import { Dice } from '../components/game/Dice.jsx';
import { SeatCard } from '../components/game/SeatCard.jsx';
import { GameResult } from '../components/game/GameResult.jsx';
import { useGameAnimator } from '../components/game/useGameAnimator.js';
import { Button, Sheet, LoadingScreen, cx } from '../components/ui/index.jsx';
import './game-screen.css';

const EMOTES = ['😂', '🔥', '😎', '👏', '😱', '🎉', '😡', '👍'];

export default function GameScreen({ onExit }) {
  const {
    game, dice, walking, captured, emotes, results, pending, banner, queue, animating,
    setGame, roll, move, reset, emote,
  } = useGame();

  /**
   * Block input while the animator is still replaying.
   *
   * A six grants an extra turn, so without this a player can roll again while
   * the previous move is mid-walk — the die then shows the new value beside a
   * token still walking the old one, which looks like the wrong count.
   */
  const replaying = animating || queue.length > 0 || Boolean(walking);
  const session = useSession();

  const [connection, setConnection] = useState(getStatus());
  const [emoteOpen, setEmoteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState(null);

  useGameAnimator();

  const gameId = game?.id ?? session.activeGameId;

  // Join the game channel; on reconnect, catch up from our last version.
  useEffect(() => {
    if (!gameId) return undefined;
    let cancelled = false;

    const join = async () => {
      try {
        const dto = await send('game:join', { gameId });
        if (!cancelled) setGame(dto);
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setTimeout(onExit, 1500);
        }
      }
    };
    join();

    const off = onStatus(async (status) => {
      setConnection(status);
      if (status !== 'connected') return;
      try {
        const result = await send('game:sync', {
          gameId,
          lastStateVersion: useGame.getState().game?.stateVersion ?? 0,
        });
        if (result?.snapshot && !cancelled) {
          useGame.getState().setGame(result.snapshot);
          if (result.events?.length && !result.resynced) {
            useGame.getState().enqueue(result.events);
          }
        }
      } catch {
        /* the join above will have surfaced anything fatal */
      }
    });

    return () => {
      cancelled = true;
      off();
    };
  }, [gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  const yourSeat = game?.you?.seat ?? null;
  const isYourTurn = game && game.status === 'active' && game.currentSeat === yourSeat;
  const canRoll = Boolean(
    isYourTurn && !game.diceRolled && !pending && !replaying && connection === 'connected',
  );
  const movable = useMemo(
    () => (game?.legalMoves ?? []).map((m) => m.tokenIndex),
    [game?.legalMoves],
  );

  // The clock is the server's; correct for the offset between machines.
  const serverSkew = useMemo(
    () => (game?.serverTime ? game.serverTime - Date.now() : 0),
    [game?.serverTime],
  );

  const emoteBySeat = useMemo(() => {
    const map = new Map();
    for (const e of emotes) map.set(e.seat, e);
    return map;
  }, [emotes]);

  if (!game) return <LoadingScreen message={error ?? 'Loading board…'} />;

  const current = game.players.find((p) => p.seat === game.currentSeat);
  const turnText =
    game.status !== 'active'
      ? 'Game over'
      : isYourTurn
        ? 'YOUR TURN'
        : `${current?.player?.name ?? 'Player'}'s turn`;

  const act = async (fn) => {
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(err.message);
      setTimeout(() => setError(null), 2200);
    }
  };

  /**
   * Seats are placed in the four corners around the board, matching where each
   * colour's yard sits after the board is rotated to put YOU bottom-left.
   *
   * Rotation moves every yard by the same offset, so a seat's corner is simply
   * its position relative to yours, walking clockwise from the near corner.
   */
  const CORNERS = ['bl', 'tl', 'tr', 'br']; // clockwise from bottom-left
  const YARD_ORDER = ['RED', 'GREEN', 'YELLOW', 'BLUE']; // clockwise on the board
  const myColorIndex = YARD_ORDER.indexOf(game.you?.color ?? 'RED');

  const seatsByCorner = {};
  for (const p of game.players) {
    const offset = (YARD_ORDER.indexOf(p.color) - myColorIndex + 4) % 4;
    seatsByCorner[CORNERS[offset]] = p;
  }

  const seatProps = (p) => ({
    player: p,
    isCurrent: p.seat === game.currentSeat && game.status === 'active',
    deadlineAt: game.turnDeadlineAt,
    serverSkew,
    turnDurationMs: game.config.turnDurationMs,
    tokenCount: game.config.tokenCount,
    emote: emoteBySeat.get(p.seat),
  });

  const hint =
    game.status !== 'active'
      ? ''
      : replaying
        ? 'Moving…'
        : !isYourTurn
          ? 'Waiting…'
          : !game.diceRolled
            ? 'Tap to roll'
            : movable.length === 0
              ? 'No moves'
              : movable.length === 1
                ? 'Tap the glowing token'
                : `${movable.length} moves`;

  return (
    <div className="gs">
      {connection !== 'connected' && (
        <div className="gs__offline" role="status">
          <span className="gs__offline-dot" />
          {connection === 'reconnecting' ? 'Reconnecting…' : 'Offline'}
        </div>
      )}

      {/* --------------------------------------------------------- header */}
      <header className="gs__head safe-top">
        <button className="gs__icon" onClick={() => setMenuOpen(true)} aria-label="Menu">
          ☰
        </button>
        <div className="gs__turn">
          <span className={cx('gs__turn-text', isYourTurn && 'is-you')}>{turnText}</span>
          <span className="gs__turn-sub">Turn {game.turnNumber}</span>
        </div>
        <button className="gs__icon" onClick={() => setEmoteOpen(true)} aria-label="Send emote">
          😀
        </button>
      </header>

      {/* ------------------------------------------- board + corner seats */}
      <main className="gs__arena">
        <div className="gs__corner gs__corner--tl">
          {seatsByCorner.tl && <SeatCard {...seatProps(seatsByCorner.tl)} />}
        </div>
        <div className="gs__corner gs__corner--tr">
          {seatsByCorner.tr && <SeatCard {...seatProps(seatsByCorner.tr)} />}
        </div>

        <div className="gs__board">
          <Board
            game={game}
            movableTokens={movable}
            onTokenClick={replaying ? undefined : (i) => act(() => move(i))}
            animating={walking}
            capturedTokens={captured}
          />
          {banner && (
            <div className="gs__banner" key={banner.at}>
              <span>{banner.text}</span>
            </div>
          )}
        </div>

        {/* Bottom-left is always you — the same corner your yard now occupies. */}
        <div className="gs__corner gs__corner--bl">
          {seatsByCorner.bl && <SeatCard {...seatProps(seatsByCorner.bl)} isMine />}
        </div>
        <div className="gs__corner gs__corner--br">
          {seatsByCorner.br && <SeatCard {...seatProps(seatsByCorner.br)} />}
        </div>
      </main>

      {/* -------------------------------------------------------- controls */}
      <footer className="gs__controls safe-bottom">
        {error && <p className="gs__error">{error}</p>}
        <Dice
          value={dice.value}
          phase={dice.phase}
          canRoll={canRoll}
          onRoll={() => act(() => roll())}
          disabled={pending}
          hint={hint}
        />
      </footer>

      {results && <GameResult results={results} yourSeat={yourSeat} onExit={onExit} />}

      {/* ---------------------------------------------------------- sheets */}
      <Sheet open={emoteOpen} onClose={() => setEmoteOpen(false)} title="Send a reaction">
        <div className="gs__emotes">
          {EMOTES.map((e) => (
            <button
              key={e}
              onClick={() => {
                act(() => emote(e));
                setEmoteOpen(false);
              }}
              aria-label={`Send ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title="Game menu"
        footer={
          <>
            <Button variant="secondary" size="lg" full onClick={() => setMenuOpen(false)}>
              Keep playing
            </Button>
            <Button
              variant="danger"
              size="lg"
              full
              onClick={async () => {
                await act(() => send('game:leave', { gameId: game.id }));
                reset();
                onExit();
              }}
            >
              Leave game
            </Button>
          </>
        }
      >
        <p className="gs__menu-note">
          Leaving removes your tokens from the board and the others carry on without you.
        </p>
      </Sheet>
    </div>
  );
}
