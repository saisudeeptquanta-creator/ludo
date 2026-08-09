/**
 * The "go fullscreen" prompt shown once when the app is opened.
 *
 * Why a prompt at all: browsers only grant fullscreen from inside a user
 * gesture. The app cannot simply call `enterFullscreen()` on load — the request
 * is rejected — so a real tap is required, and this is that tap. The handler
 * calls into the Fullscreen API synchronously for the same reason: awaiting
 * anything first would end the gesture and the request would be denied.
 *
 * It shows only when fullscreen is actually available and is not already on, so
 * on iOS Safari (which supports fullscreen for video only) nothing appears —
 * the viewport fix already gives those browsers a full-bleed layout.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  enterFullscreen,
  isFullscreen,
  isFullscreenSupported,
} from '../../lib/fullscreen.js';
import './fullscreen-prompt.css';

/**
 * Remembered for the tab only.
 *
 * `sessionStorage`, not `localStorage`: fullscreen does not survive a reload,
 * so a permanent dismissal would leave the player with no prompt and a
 * windowed game every time afterwards. Per-tab means "you already answered
 * this, for this visit".
 */
const KEY = 'ludo.fullscreenPrompted';

export function FullscreenPrompt() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isFullscreenSupported() || isFullscreen()) return;
    try {
      if (sessionStorage.getItem(KEY)) return;
    } catch {
      /* private mode: just show it */
    }
    setOpen(true);
  }, []);

  // Esc closes it, matching every other dialog in the app.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismiss = () => {
    try {
      sessionStorage.setItem(KEY, '1');
    } catch {
      /* nothing to persist to; the prompt simply returns on next load */
    }
    setOpen(false);
  };

  if (!open) return null;

  return createPortal(
    <div className="fsp" role="dialog" aria-modal="true" aria-labelledby="fsp-title">
      {/* Only one BUTTON, as asked — but tapping outside (or pressing Esc,
          below) still dismisses. Without an escape the prompt would be a trap
          for anyone who simply does not want fullscreen. */}
      <div className="fsp__scrim" onClick={dismiss} />
      <div className="fsp__card">
        <div className="fsp__icon" aria-hidden="true">⛶</div>
        <h2 className="fsp__title" id="fsp-title">Play fullscreen</h2>
        <p className="fsp__text">Hide the browser bars for a bigger board.</p>

        <button
          className="fsp__go"
          autoFocus
          onClick={() => {
            // Fire inside the gesture, then close. Not awaited: closing does
            // not depend on the outcome, and if the browser refuses, the
            // toggle in the header is still there.
            enterFullscreen();
            dismiss();
          }}
        >
          Go Fullscreen
        </button>
      </div>
    </div>,
    document.body,
  );
}
