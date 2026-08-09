/**
 * Home: the first thing you see. Type a name, then create or join.
 * No landing page, no sign-up, no navigation.
 */
import { useEffect, useState } from 'react';
import { loadProfile, saveProfile } from '../lib/device.js';
import { connectSocket, getStatus, onStatus, reconnectWithProfile } from '../lib/socket.js';
import { useRoom, useSession } from '../store/game.js';
import {
  Avatar, Button, AVATAR_COUNT, Sheet, FullscreenButton, cx,
} from '../components/ui/index.jsx';
import { getAudioPrefs, setAudioPrefs, sfx } from '../lib/audio.js';
import './home.css';

export default function Home({ onEnterLobby }) {
  const stored = loadProfile();
  const [name, setName] = useState(stored.name);
  const [avatar, setAvatar] = useState(stored.avatar);
  const [status, setStatus] = useState(getStatus());
  const [joinOpen, setJoinOpen] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [audio, setAudio] = useState(getAudioPrefs());

  const room = useRoom();
  const session = useSession();

  useEffect(() => onStatus(setStatus), []);

  const trimmed = name.trim();
  const nameOk = trimmed.length >= 2;

  /** Persists the name, then makes sure the socket handshake carries it. */
  const ensureConnected = async () => {
    saveProfile({ name: trimmed, avatar });
    if (!getSocketConnected()) {
      reconnectWithProfile();
    } else if (session.player?.name !== trimmed) {
      // The name changed since the handshake — redo it so others see the update.
      reconnectWithProfile();
    }
    await waitForConnection();
  };

  const createGame = async (maxPlayers) => {
    setBusy(true);
    setError(null);
    try {
      await ensureConnected();
      await room.create(maxPlayers);
      setSizeOpen(false);
      onEnterLobby();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const joinGame = async (e) => {
    e?.preventDefault();
    const trimmedCode = code.trim();
    if (!trimmedCode) return;
    setBusy(true);
    setError(null);
    try {
      await ensureConnected();
      await room.join(trimmedCode);
      setJoinOpen(false);
      onEnterLobby();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const updateAudio = (patch) => setAudio(setAudioPrefs(patch));

  return (
    <div className="home">
      <header className="home__top safe-top">
        <button
          className="home__icon"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
        >
          ⚙️
        </button>
        <span className={cx('home__status', `is-${status}`)}>
          <span className="home__status-dot" />
          {status === 'connected' ? 'Online' : status === 'connecting' ? 'Connecting' : 'Offline'}
        </span>
        <FullscreenButton className="home__icon" />
      </header>

      <div className="home__body" data-scroll>
        {/* ------------------------------------------------------- logo */}
        <div className="home__brand">
          <div className="home__logo" aria-hidden="true">
            <span className="home__logo-die">
              {[0, 1, 2, 3, 4].map((i) => (
                <i key={i} />
              ))}
            </span>
          </div>
          <h1 className="home__title">LUDO</h1>
          <p className="home__tagline">Roll · Move · Conquer</p>
        </div>

        {/* ------------------------------------------------------- name */}
        <div className="home__card">
          <label className="home__label" htmlFor="playerName">
            Your name
          </label>
          <div className="home__name-row">
            <Avatar name={trimmed || '?'} avatar={avatar} size={54} />
            <input
              id="playerName"
              className="home__input"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 14))}
              placeholder="Enter your name"
              maxLength={14}
              autoComplete="off"
              autoCapitalize="words"
              spellCheck="false"
              enterKeyHint="done"
            />
          </div>

          <div className="home__avatars">
            {Array.from({ length: AVATAR_COUNT }, (_, i) => (
              <button
                key={i}
                className={cx('home__avatar', avatar === i && 'is-active')}
                onClick={() => {
                  sfx.tap();
                  setAvatar(i);
                  saveProfile({ name: trimmed, avatar: i });
                }}
                aria-label={`Avatar ${i + 1}`}
                aria-pressed={avatar === i}
              >
                <Avatar name={trimmed || '?'} avatar={i} size={38} />
              </button>
            ))}
          </div>
        </div>

        {error && <p className="home__error" role="alert">{error}</p>}

        {/* ------------------------------------------------------ actions */}
        <div className="home__actions">
          <Button
            size="xl"
            variant="gold"
            full
            disabled={!nameOk || busy}
            onClick={() => setSizeOpen(true)}
          >
            🎲 Create Game
          </Button>
          <Button
            size="xl"
            variant="primary"
            full
            disabled={!nameOk || busy}
            onClick={() => setJoinOpen(true)}
          >
            🔑 Join Game
          </Button>
          {!nameOk && <p className="home__hint">Enter a name to start playing</p>}
        </div>

        <p className="home__footnote">
          Play with 2–4 friends on any device. Share the room code and go.
        </p>
      </div>

      {/* -------------------------------------------------- create sheet */}
      <Sheet open={sizeOpen} onClose={() => setSizeOpen(false)} title="How many players?">
        <div className="home__sizes">
          {[2, 3, 4].map((n) => (
            <button
              key={n}
              className="home__size"
              onClick={() => createGame(n)}
              disabled={busy}
            >
              <span className="home__size-pips" aria-hidden="true">
                {Array.from({ length: n }, (_, i) => (
                  <i key={i} className={`c-${['RED', 'GREEN', 'YELLOW', 'BLUE'][i]}`} />
                ))}
              </span>
              <strong>{n} Players</strong>
              <span className="subtle">
                {n === 2 ? 'Head to head' : n === 3 ? 'Three way' : 'Full board'}
              </span>
            </button>
          ))}
        </div>
      </Sheet>

      {/* ---------------------------------------------------- join sheet */}
      <Sheet
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        title="Join a game"
        footer={
          <Button size="lg" full loading={busy} disabled={!code.trim()} onClick={joinGame}>
            Join Game
          </Button>
        }
      >
        <form onSubmit={joinGame}>
          <p className="home__sheet-hint">Enter the code your friend shared</p>
          <input
            className="home__code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 8))}
            placeholder="ABC12"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck="false"
            inputMode="text"
            enterKeyHint="go"
            autoFocus
          />
        </form>
      </Sheet>

      {/* ------------------------------------------------ settings sheet */}
      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings">
        <div className="home__settings">
          <button
            className="home__toggle"
            onClick={() => updateAudio({ soundEnabled: !audio.soundEnabled })}
          >
            <span>🔊 Sound effects</span>
            <span className={cx('home__switch', audio.soundEnabled && 'is-on')} />
          </button>
          <button
            className="home__toggle"
            onClick={() => updateAudio({ musicEnabled: !audio.musicEnabled })}
          >
            <span>🎵 Background music</span>
            <span className={cx('home__switch', audio.musicEnabled && 'is-on')} />
          </button>
          <FullscreenButton variant="row" className="home__toggle" />
        </div>
      </Sheet>
    </div>
  );
}

/* --------------------------------------------------------------- helpers -- */

function getSocketConnected() {
  return getStatus() === 'connected';
}

/** Resolves once the socket is connected, or rejects with a usable message. */
function waitForConnection(timeout = 8000) {
  if (getStatus() === 'connected') return Promise.resolve();
  connectSocket();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('Cannot reach the server. Check your connection.'));
    }, timeout);
    const off = onStatus((status) => {
      if (status === 'connected') {
        clearTimeout(timer);
        off();
        resolve();
      } else if (status === 'rejected') {
        clearTimeout(timer);
        off();
        reject(new Error('That name was not accepted. Try another.'));
      }
    });
  });
}
