/**
 * Room lobby. Everything here is pushed over the socket — seats, ready flags and
 * host changes all arrive as `room:updated`, so this only renders and sends.
 */
import { useState } from 'react';
import { useRoom, useSession } from '../store/game.js';
import { loadProfile } from '../lib/device.js';
import { Avatar, Button, Chip, Sheet, FullscreenButton, cx } from '../components/ui/index.jsx';
import './lobby.css';

const COLOR_NAME = { RED: 'Red', GREEN: 'Green', YELLOW: 'Yellow', BLUE: 'Blue' };

export default function Lobby({ onLeave }) {
  const { room, toast, ...actions } = useRoom();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState(null);

  if (!room) return null;

  /**
   * Who am I in this room?
   *
   * `session.player.id` is authoritative, but it only arrives with
   * `session_ready`. Falling back to the saved name keeps the lobby usable if
   * that handshake is late — without it, an unrecognised seat makes the Ready
   * button look permanently stuck even though the server accepted the tap.
   */
  const myId = session.player?.id;
  const myName = loadProfile().name.trim();
  const me =
    room.players.find((p) => p.id === myId) ??
    (myName ? room.players.find((p) => p.name === myName) : undefined);
  const isHost = me ? room.hostId === me.id : false;

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(`Room code: ${room.code}`);
    }
  };

  const share = async () => {
    const text = `Join my Ludo game! Code: ${room.code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Ludo', text, url: window.location.origin });
        return;
      } catch {
        /* dismissed */
      }
    }
    copyCode();
  };

  return (
    <div className="lobby">
      <header className="lobby__top safe-top">
        <button className="lobby__back" onClick={() => run(async () => { await actions.leave(); onLeave(); })}>
          ←
        </button>
        <h2>Game Room</h2>
        <div className="lobby__top-actions">
          <FullscreenButton />
          {isHost && (
            <button className="lobby__back" onClick={() => setSettingsOpen(true)} aria-label="Rules">
              ⚙️
            </button>
          )}
        </div>
      </header>

      <div className="lobby__body" data-scroll>
        {/* ------------------------------------------------------ code */}
        <div className="lobby__code-card">
          <span className="lobby__code-label">Room Code</span>
          <button className="lobby__code" onClick={copyCode}>
            {room.code}
            <span className="lobby__code-copy">{copied ? '✓ Copied' : 'Tap to copy'}</span>
          </button>
          <Button variant="secondary" size="sm" onClick={share} icon="📤">
            Share invite
          </Button>
        </div>

        {/* ----------------------------------------------------- seats */}
        <div className="lobby__seats">
          {room.slots.map((slot) =>
            slot.empty ? (
              <div key={slot.seat} className={cx('seat', 'seat--empty', `c-${slot.color}`)}>
                <div className="seat__pin" />
                <div className="seat__avatar seat__avatar--empty">＋</div>
                <div className="seat__info">
                  <strong className="subtle">Waiting…</strong>
                  <span className="subtle">{COLOR_NAME[slot.color]}</span>
                </div>
              </div>
            ) : (
              <div
                key={slot.seat}
                className={cx('seat', `c-${slot.color}`, slot.isReady && 'seat--ready')}
              >
                <div className="seat__pin" />
                <Avatar
                  name={slot.name}
                  avatar={slot.avatar}
                  size={48}
                  color={slot.color}
                  ring
                  className="seat__avatar"
                />
                <div className="seat__info">
                  <strong>
                    {slot.name}
                    {slot.id === me?.id && <span className="subtle"> (you)</span>}
                  </strong>
                  <div className="seat__tags">
                    {slot.isHost && <Chip tone="gold">HOST</Chip>}
                    <span className="subtle">{COLOR_NAME[slot.color]}</span>
                    {!slot.online && <Chip tone="danger">offline</Chip>}
                  </div>
                </div>
                <div className="seat__state">
                  {slot.isReady ? <Chip tone="success">READY</Chip> : <Chip>waiting</Chip>}
                  {isHost && slot.id !== me?.id && (
                    <button
                      className="seat__kick"
                      onClick={() => run(() => actions.kick(slot.id))}
                      aria-label={`Remove ${slot.name}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ),
          )}
        </div>

        {error && <p className="lobby__error">{error}</p>}
        {toast && <p className="lobby__toast">{toast.message}</p>}
      </div>

      {/* -------------------------------------------------------- footer */}
      <footer className="lobby__footer safe-bottom">
        <p className="lobby__status">
          {room.canStart
            ? isHost
              ? 'Everyone is ready!'
              : 'Waiting for the host to start'
            : room.startBlockedReason}
        </p>
        <div className="lobby__buttons">
          <Button
            size="lg"
            variant={me?.isReady ? 'secondary' : 'success'}
            full
            disabled={busy}
            onClick={() => run(() => actions.setReady(!me?.isReady))}
          >
            {me?.isReady ? 'Not Ready' : "I'm Ready"}
          </Button>
          {isHost && (
            <Button
              size="lg"
              variant="gold"
              full
              disabled={!room.canStart || busy}
              onClick={() => run(() => actions.start())}
            >
              Start Game
            </Button>
          )}
        </div>
      </footer>

      <RulesSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        room={room}
        onSave={(settings) => run(() => actions.updateSettings(settings))}
      />
    </div>
  );
}

function RulesSheet({ open, onClose, room, onSave }) {
  const [draft, setDraft] = useState(room.settings);
  const toggle = (key) => setDraft((d) => ({ ...d, [key]: !d[key] }));

  const rules = [
    ['extraTurnOnSix', 'Extra turn on a 6'],
    ['extraTurnOnCapture', 'Extra turn on capture'],
    ['safeCellsEnabled', 'Safe squares'],
    ['stackingEnabled', 'Stack your own tokens'],
    ['blockingEnabled', 'Stacks block opponents'],
  ];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Game rules"
      footer={
        <Button
          size="lg"
          full
          onClick={() => {
            onSave(draft);
            onClose();
          }}
        >
          Save rules
        </Button>
      }
    >
      <p className="lobby__sheet-hint">Changing the rules clears everyone's ready flag.</p>

      <div className="lobby__rule">
        <span>Turn timer</span>
        <strong>{Math.round((draft.turnDurationMs ?? 25000) / 1000)}s</strong>
      </div>
      <input
        type="range"
        min={10000}
        max={60000}
        step={5000}
        value={draft.turnDurationMs ?? 25000}
        onChange={(e) => setDraft((d) => ({ ...d, turnDurationMs: Number(e.target.value) }))}
        className="lobby__slider"
      />

      {rules.map(([key, label]) => (
        <button key={key} className="lobby__rule lobby__rule--tap" onClick={() => toggle(key)}>
          <span>{label}</span>
          <span className={cx('home__switch', draft[key] && 'is-on')} />
        </button>
      ))}
    </Sheet>
  );
}
