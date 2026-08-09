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
import { useGameAnimator, abortReplay } from '../components/game/useGameAnimator.js';
import {
  Button, Sheet, LoadingScreen, Confetti, FullscreenButton, cx,
} from '../components/ui/index.jsx';
import './game-screen.css';

const EMOTES = ['😂', '🔥', '😎', '👏', '😱', '🎉', '😡', '👍'];

/** Canned lines. Must stay in step with CHAT_PHRASES in the server config. */
const PHRASES = [
  'Good luck!',
  'Nice move!',
  'Well played',
  'So close!',
  'Oops!',
  'Your turn',
  'Hurry up!',
  'Good game',
];

/** Mirrors GAME_CONFIG.CHAT_MAX_LENGTH — the server truncates to this. */
const CHAT_MAX_LENGTH = 120;

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
  /** Rank whose "you finished" popup has been dismissed, so it shows once. */
  const [finishSeen, setFinishSeen] = useState(null);
  const [chatText, setChatText] = useState('');

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

      if (status !== 'connected') {
        /**
         * The link dropped mid-replay.
         *
         * Whatever was being animated will never be completed by the events
         * that were in flight, and a half-finished walk would leave a token
         * stranded between squares while the snapshot says otherwise. Drop the
         * animation state now so the board shows the plain truth until we are
         * back and can replay properly.
         */
        abortReplay();
        const g = useGame.getState();
        g.setWalking(null);
        g.setAnimating(false);
        g.setCaptured([]);
        return;
      }

      try {
        const result = await send('game:sync', {
          gameId,
          lastStateVersion: useGame.getState().game?.stateVersion ?? 0,
        });
        if (!result?.snapshot || cancelled) return;

        /**
         * Rejoin the game channel too.
         *
         * A reconnect gives us a NEW socket, which is not in the room the
         * broadcasts go to — without this the snapshot below would be correct
         * once and then never update again, so the board would silently freeze
         * on the state it had at reconnect.
         */
        await send('game:join', { gameId }).catch(() => {});
        if (cancelled) return;

        useGame.getState().setGame(result.snapshot);
        // Only replay a small gap. After a long absence the snapshot alone is
        // the truth; animating a hundred stale moves would be nonsense.
        if (result.events?.length && !result.resynced) {
          useGame.getState().enqueue(result.events);
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
  /**
   * Tokens the server says you may move.
   *
   * Empty while the animator is replaying: the snapshot for the NEXT roll
   * arrives before the previous move has finished walking, so without this a
   * token glows (and can be tapped) against a die the player has not visually
   * been shown yet.
   */
  const movable = useMemo(
    () => (replaying ? [] : (game?.legalMoves ?? []).map((m) => m.tokenIndex)),
    [game?.legalMoves, replaying],
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

  /**
   * You are done, but the game is not.
   *
   * The server ranks a player the moment their fourth token comes home and
   * keeps the game `active` until only one seat is still playing. So a finished
   * player has no turn to take and nothing to tap — they stay to watch. The
   * board is fully rendered for them; only the controls go away.
   */
  const me = game.players.find((p) => p.seat === yourSeat);
  const iFinished = me?.status === 'finished' && game.status === 'active';
  const myRank = me?.finishedRank ?? null;

  const turnText =
    game.status !== 'active'
      ? 'Game over'
      : iFinished
        ? 'Spectating'
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
              // The commonest reason by far is a home-column token needing an
              // exact roll, so say that rather than a bare "No moves".
              ? 'Too big — turn passes'
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
        <div className="gs__head-actions">
          <FullscreenButton />
          <button className="gs__icon" onClick={() => setEmoteOpen(true)} aria-label="Send emote">
            😀
          </button>
        </div>
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
        {iFinished ? (
          // No die for someone who has already finished — they have no turn to
          // take. Replacing it (rather than merely disabling it) keeps a dead
          // control from sitting under the thumb for the rest of the game.
          <div className="gs__spectating" role="status">
            <span className="gs__spectating-medal" aria-hidden="true">
              {myRank === 1 ? '👑' : myRank === 2 ? '🥈' : myRank === 3 ? '🥉' : '🎲'}
            </span>
            <span>
              You finished {myRank ? `#${myRank}` : ''} — watching the rest of the game
            </span>
          </div>
        ) : (
          <Dice
            value={dice.value}
            phase={dice.phase}
            canRoll={canRoll}
            onRoll={() => act(() => roll())}
            disabled={pending}
            hint={hint}
          />
        )}
      </footer>

      {/* You came home while the others play on. Dismissable — the game
          continues behind it and is worth watching. */}
      {iFinished && finishSeen !== myRank && (
        <div className="gs__done" role="dialog" aria-modal="true" aria-label="You finished">
          <div className="gs__done-card">
            <Confetti />
            <div className="gs__done-crest" aria-hidden="true">
              {myRank === 1 ? '👑' : myRank === 2 ? '🥈' : myRank === 3 ? '🥉' : '🏅'}
            </div>
            <h2>{myRank === 1 ? 'You Win!' : 'All Home!'}</h2>
            <p>
              {myRank === 1
                ? 'All four tokens home — first place.'
                : `All four tokens home. You finished #${myRank}.`}
            </p>
            <p className="gs__done-note">
              The game carries on until one player is left. You can keep watching.
            </p>
            <Button size="lg" variant="gold" full onClick={() => setFinishSeen(myRank)}>
              Watch the rest
            </Button>
          </div>
        </div>
      )}

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

        {/* Canned lines: the things people actually want to say, one tap away
            and with nothing to type on a phone mid-game. */}
        <div className="gs__phrases">
          {PHRASES.map((p) => (
            <button
              key={p}
              type="button"
              className="gs__phrase"
              onClick={() => {
                act(() => emote({ text: p }));
                setEmoteOpen(false);
              }}
            >
              {p}
            </button>
          ))}
        </div>

        <form
          className="gs__chat"
          onSubmit={(e) => {
            e.preventDefault();
            const value = chatText.trim();
            if (!value) return;
            act(() => emote({ text: value }));
            setChatText('');
            setEmoteOpen(false);
          }}
        >
          <input
            className="gs__chat-input"
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            placeholder="Type a message…"
            // Matches the server's cap, so the field cannot accept more than
            // will actually be sent.
            maxLength={CHAT_MAX_LENGTH}
            aria-label="Message"
            enterKeyHint="send"
          />
          <Button type="submit" variant="gold" disabled={!chatText.trim()}>
            Send
          </Button>
        </form>
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
        <FullscreenButton variant="row" />
        <p className="gs__menu-note">
          Leaving removes your tokens from the board and the others carry on without you.
        </p>
      </Sheet>
    </div>
  );
}
