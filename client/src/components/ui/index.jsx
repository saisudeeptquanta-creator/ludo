/**
 * The component kit for a mobile game: chunky pressable buttons, sheets that
 * slide from the bottom, and avatars generated from a name so the app ships no
 * image assets.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sfx } from '../../lib/audio.js';
import {
  isFullscreen,
  isFullscreenSupported,
  toggleFullscreen,
} from '../../lib/fullscreen.js';
import './ui.css';

export const cx = (...parts) => parts.filter(Boolean).join(' ');

/* ----------------------------------------------------------------- Button -- */

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  full,
  loading,
  icon,
  className,
  onClick,
  disabled,
  silent,
  ...rest
}) {
  return (
    <button
      className={cx('btn', `btn--${variant}`, `btn--${size}`, full && 'btn--full', className)}
      onClick={(e) => {
        if (loading || disabled) return;
        if (!silent) sfx.tap();
        onClick?.(e);
      }}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      <span className="btn__inner">
        {loading ? <span className="btn__spinner" /> : icon}
        {children}
      </span>
    </button>
  );
}

export function IconButton({ label, children, className, onClick, ...rest }) {
  return (
    <button
      className={cx('icon-btn', className)}
      aria-label={label}
      onClick={(e) => {
        sfx.tap();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- Avatar -- */

/** Twelve hand-picked hues so generated avatars never clash with board colours. */
const AVATAR_HUES = [265, 210, 175, 145, 95, 45, 20, 350, 320, 290, 240, 190];

export const AVATAR_COUNT = AVATAR_HUES.length;

/**
 * Avatars are generated from the name plus a chosen index — no uploads, no
 * image files, and a stable identity for the same person every time.
 */
export function Avatar({ name = '?', avatar = 0, size = 44, color, ring, className }) {
  const hue = AVATAR_HUES[Math.abs(Number(avatar) || 0) % AVATAR_HUES.length];
  const initials = String(name)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <span
      className={cx('avatar', color && `c-${color}`, ring && 'avatar--ring', className)}
      style={{
        '--size': `${size}px`,
        '--a1': `hsl(${hue} 78% 62%)`,
        '--a2': `hsl(${(hue + 40) % 360} 70% 42%)`,
      }}
      aria-hidden="true"
    >
      <span className="avatar__text" style={{ fontSize: size * 0.38 }}>
        {initials || '?'}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ Sheet -- */

/** A bottom sheet — the mobile-native equivalent of a modal. */
export function Sheet({ open, onClose, title, children, footer, dismissible = true }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && dismissible && onClose?.();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, dismissible]);

  if (!open) return null;

  return createPortal(
    <div className="sheet-root">
      <div className="sheet__scrim" onClick={dismissible ? onClose : undefined} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        {dismissible && <div className="sheet__grab" />}
        {title && <h3 className="sheet__title">{title}</h3>}
        <div className="sheet__body" data-scroll>
          {children}
        </div>
        {footer && <div className="sheet__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------- feedback --- */

/**
 * Live fullscreen state.
 *
 * Read from the document rather than tracked locally: the user can leave
 * fullscreen with Esc or a system gesture without ever touching our button, and
 * a local boolean would then disagree with the screen. `fullscreenchange` is
 * the only source of truth.
 */
export function useIsFullscreen() {
  const [full, setFull] = useState(isFullscreen);

  useEffect(() => {
    const sync = () => setFull(isFullscreen());
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    sync();
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  return full;
}

/**
 * Fullscreen toggle, used on every screen.
 *
 * Renders nothing where the browser cannot grant fullscreen — notably iOS
 * Safari, which supports it for video only. A button that silently does nothing
 * is worse than no button, and the viewport fix in `installViewportFix` already
 * gives those browsers a full-bleed layout without it.
 */
export function FullscreenButton({ className, variant = 'icon' }) {
  const full = useIsFullscreen();
  if (!isFullscreenSupported()) return null;

  const label = full ? 'Exit fullscreen' : 'Enter fullscreen';

  if (variant === 'row') {
    return (
      <button className={cx('fs-row', className)} onClick={() => toggleFullscreen()}>
        <span>⛶ Fullscreen</span>
        <span className="subtle">{full ? 'On — tap to exit' : 'Tap to toggle'}</span>
      </button>
    );
  }

  return (
    <button
      className={cx('fs-btn', className)}
      onClick={() => toggleFullscreen()}
      aria-label={label}
      title={label}
      aria-pressed={full}
    >
      {full ? '⤡' : '⛶'}
    </button>
  );
}

export function Spinner({ size = 22 }) {
  return <span className="spinner" style={{ '--s': `${size}px` }} role="status" aria-label="Loading" />;
}

export function LoadingScreen({ message = 'Loading…' }) {
  return (
    <div className="loading">
      <div className="loading__dice" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ animationDelay: `${i * 130}ms` }} />
        ))}
      </div>
      <p className="loading__text">{message}</p>
    </div>
  );
}

export function Chip({ children, tone = 'neutral', className }) {
  return <span className={cx('chip', `chip--${tone}`, className)}>{children}</span>;
}

/** Confetti for the win screen. Unmounted as soon as the screen closes. */
export function Confetti({ pieces = 70 }) {
  const bits = useRef(
    Array.from({ length: pieces }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 2,
      duration: 2.4 + Math.random() * 2,
      hue: Math.floor(Math.random() * 360),
      size: 7 + Math.random() * 8,
    })),
  ).current;

  return (
    <div className="confetti" aria-hidden="true">
      {bits.map((b) => (
        <span
          key={b.id}
          style={{
            left: `${b.left}%`,
            width: b.size,
            height: b.size * 1.5,
            background: `hsl(${b.hue} 88% 62%)`,
            animationDelay: `${b.delay}s`,
            animationDuration: `${b.duration}s`,
          }}
        />
      ))}
    </div>
  );
}

/** Full-bleed animated backdrop used behind every screen. */
export function GameBackground() {
  return (
    <div className="bg" aria-hidden="true">
      <div className="bg__gradient" />
      <div className="bg__blob bg__blob--1" />
      <div className="bg__blob bg__blob--2" />
      <div className="bg__blob bg__blob--3" />
      <div className="bg__grid" />
      <div className="bg__pips">
        {Array.from({ length: 14 }, (_, i) => (
          <span
            key={i}
            style={{
              left: `${(i * 37) % 100}%`,
              animationDelay: `${i * 1.4}s`,
              animationDuration: `${16 + (i % 5) * 4}s`,
              '--pip-size': `${10 + (i % 4) * 6}px`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
