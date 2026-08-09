/**
 * The whole app.
 *
 * One screen at a time, driven by state rather than URLs — the game opens
 * straight onto the home screen with no landing page, no login and no routing.
 * The four phases are: HOME → LOBBY → GAME → RESULT.
 */
import { useEffect, useState } from 'react';
import { connectSocket, onMany, onStatus } from './lib/socket.js';
import { installViewportFix, requestWakeLock } from './lib/fullscreen.js';
import { hasProfile } from './lib/device.js';
import { useGame, useRoom, useSession } from './store/game.js';
import { sfx, unlock } from './lib/audio.js';
import { GameBackground, LoadingScreen, FullscreenButton } from './components/ui/index.jsx';
import { FullscreenPrompt } from './components/ui/FullscreenPrompt.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import Home from './screens/Home.jsx';
import Lobby from './screens/Lobby.jsx';
import GameScreen from './screens/GameScreen.jsx';
import Countdown from './screens/Countdown.jsx';

export default function App() {
  const [screen, setScreen] = useState(hasProfile() ? 'booting' : 'home');
  const session = useSession();
  const { room, setRoom, clear: clearRoom, setCountdown, flash } = useRoom();
  const game = useGame((s) => s.game);
  const setGame = useGame((s) => s.setGame);
  const resetGame = useGame((s) => s.reset);

  // Viewport sizing and scroll-locking must be installed before first paint.
  useEffect(() => {
    installViewportFix();
    const kick = () => unlock();
    window.addEventListener('pointerdown', kick, { once: true });
    return () => window.removeEventListener('pointerdown', kick);
  }, []);

  /**
   * Socket listeners are registered ONCE, for the life of the app — never
   * conditionally. A previous version bailed out early when no saved name
   * existed, so a first-time player registered no listeners at all: they typed a
   * name, connected from Home, and `session_ready` was never heard. That left
   * `session.player` null, which made the lobby unable to recognise its own
   * seat and the Ready button appear stuck.
   *
   * Connecting is what depends on having a name; listening is not.
   */
  useEffect(() => {
    if (hasProfile()) connectSocket();
    else setScreen('home');

    const offStatus = onStatus((status) => {
      if (status === 'rejected') setScreen('home');
    });

    const off = onMany({
      session_ready: ({ player, activeGameId, room: currentRoom }) => {
        session.set({ player, ready: true, activeGameId });
        // Land the player back exactly where they were.
        if (activeGameId) {
          setScreen('game');
        } else if (currentRoom) {
          setRoom(currentRoom);
          setScreen('lobby');
        } else {
          setScreen('home');
        }
      },

      'room:updated': ({ room: next, message, closed }) => {
        if (closed) {
          clearRoom();
          setScreen('home');
          flash('Room closed');
          return;
        }
        if (next) setRoom(next);
        if (message) flash(message);
      },

      'room:kicked': () => {
        clearRoom();
        resetGame();
        setScreen('home');
        flash('The host removed you');
      },

      'game:countdown': ({ gameId, startsAt }) => {
        setCountdown({ gameId, startsAt });
        setScreen('countdown');
      },

      'game:started': (dto) => {
        setCountdown(null);
        resetGame();
        setGame(dto);
        setScreen('game');
      },

      'game:state': (dto) => {
        setGame(dto);
        setScreen((s) => (s === 'countdown' ? 'game' : s));
      },

      'game:events': ({ events }) => useGame.getState().enqueue(events),

      'game:emote': ({ seat, emote, text }) =>
        useGame.getState().pushEmote({ seat, emote, text }),

      'game:finished': (results) => {
        useGame.getState().setResults(results);
        const you = useGame.getState().game?.you?.seat;
        const mine = results.standings?.find((s) => s.seat === you);
        // Only celebrate an earned win — not one handed over by a player
        // leaving, which would be a fanfare for nothing.
        const byDefault =
          results.endReason === 'opponents_left' || results.endReason === 'abandoned';
        if (mine?.rank === 1 && !byDefault && mine?.tokensFinished === 4) sfx.win();
        else sfx.lose();
      },

      'game:presence': ({ seat, connected }) => {
        const g = useGame.getState().game;
        const p = g?.players.find((x) => x.seat === seat);
        if (p) flash(`${p.player?.name ?? 'A player'} ${connected ? 'reconnected' : 'disconnected'}`);
      },

      action_error: ({ message }) => flash(message),
    });

    return () => {
      off();
      offStatus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the screen awake while a game is on.
  useEffect(() => {
    if (screen === 'game') requestWakeLock();
  }, [screen]);

  const goHome = () => {
    resetGame();
    clearRoom();
    setScreen('home');
  };

  return (
    <ErrorBoundary onReset={goHome}>
      <GameBackground />

      {/* Offered once per tab, over whatever screen is showing. Fullscreen
          needs a real tap to be granted, so it cannot be done automatically. */}
      <FullscreenPrompt />

      {screen === 'booting' && <LoadingScreen message="Connecting…" />}
      {screen === 'home' && <Home onEnterLobby={() => setScreen('lobby')} />}
      {screen === 'lobby' && room && <Lobby onLeave={goHome} />}
      {screen === 'countdown' && <Countdown />}
      {screen === 'game' && <GameScreen onExit={goHome} />}

      {/* Screens without a header of their own (booting, countdown) still need
          the toggle, so it floats over them. The screens that DO have a header
          place it there instead, which is why those are excluded here. */}
      {(screen === 'booting' || screen === 'countdown') && (
        <FullscreenButton className="fs-btn--floating" />
      )}

      {/* A room that vanished under us (host closed it) falls back home. */}
      {screen === 'lobby' && !room && <Home onEnterLobby={() => setScreen('lobby')} />}
      {screen === 'game' && !game && <LoadingScreen message="Loading board…" />}
    </ErrorBoundary>
  );
}
