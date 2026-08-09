/**
 * Fullscreen and mobile viewport handling.
 *
 * Two separate problems:
 *
 *  1. Real fullscreen — only grantable from a user gesture, and unsupported on
 *     iOS Safari for arbitrary elements. Treated as a bonus, never depended on.
 *  2. The mobile viewport itself: `100vh` on mobile includes the browser chrome
 *     that later slides away, so a `100vh` layout is taller than the screen and
 *     the page scrolls. `--vh` and `--app-height` below are measured from the
 *     real visual viewport instead.
 */

let installed = false;

export function isFullscreen() {
  return Boolean(document.fullscreenElement ?? document.webkitFullscreenElement);
}

export function isFullscreenSupported() {
  const el = document.documentElement;
  return Boolean(el.requestFullscreen ?? el.webkitRequestFullscreen);
}

export async function enterFullscreen() {
  const el = document.documentElement;
  const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (!request) return false;
  try {
    await request.call(el, { navigationUI: 'hide' });
    // Best-effort: only works on Android and only when already fullscreen.
    try {
      await screen.orientation?.lock?.('portrait');
    } catch {
      /* iOS and desktop reject this; harmless */
    }
    return true;
  } catch {
    return false;
  }
}

export async function exitFullscreen() {
  const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
  if (!exit) return false;
  try {
    await exit.call(document);
    return true;
  } catch {
    return false;
  }
}

export async function toggleFullscreen() {
  return isFullscreen() ? exitFullscreen() : enterFullscreen();
}

/**
 * Publishes the true viewport height as CSS variables and blocks the rubber-band
 * scroll that makes a web game feel like a web page.
 */
export function installViewportFix() {
  if (installed) return;
  installed = true;

  const apply = () => {
    // visualViewport reflects the area actually visible once the URL bar has
    // collapsed and the on-screen keyboard is accounted for.
    const height = window.visualViewport?.height ?? window.innerHeight;
    document.documentElement.style.setProperty('--vh', `${height * 0.01}px`);
    document.documentElement.style.setProperty('--app-height', `${height}px`);
  };

  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 120));
  window.visualViewport?.addEventListener('resize', apply);

  // Stop two-finger pinch zoom and double-tap zoom inside the game.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  let lastTouch = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      /**
       * Never swallow a tap on an actual control.
       *
       * `preventDefault()` here also cancels the synthetic click the browser
       * would have fired, so a quick second tap on a button did nothing at all.
       * That matters most for the fullscreen prompt: the API only grants the
       * request from inside a genuine gesture, so a suppressed click means the
       * button silently fails. Zoom is only worth blocking on inert areas.
       */
      const onControl = e.target.closest?.('button, a, input, select, textarea, [role="button"]');
      if (!onControl && now - lastTouch < 300) e.preventDefault();
      lastTouch = now;
    },
    { passive: false },
  );

  // Prevent overscroll bounce, but leave genuinely scrollable panels alone.
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) {
        e.preventDefault();
        return;
      }
      const scrollable = e.target.closest?.('[data-scroll]');
      if (!scrollable) e.preventDefault();
    },
    { passive: false },
  );
}

/** Keeps the screen awake during a game where supported. */
let wakeLock = null;
export async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && !wakeLock) {
        try {
          wakeLock = await navigator.wakeLock?.request('screen');
        } catch {
          /* denied; the screen will simply dim */
        }
      }
    });
  } catch {
    /* unsupported or denied — not important enough to surface */
  }
}

export function releaseWakeLock() {
  try {
    wakeLock?.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}
