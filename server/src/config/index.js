/**
 * Central configuration. Every tunable rule, timeout and limit lives here so it
 * can be changed in one place — nothing game-relevant is hard-coded elsewhere.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const int = (v, fallback) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const ENV = process.env.NODE_ENV ?? 'development';
export const IS_PROD = ENV === 'production';

export const SERVER = {
  port: int(process.env.PORT, 4000),
  host: process.env.HOST ?? '0.0.0.0',

  /**
   * Allowed browser origins.
   *
   * In production the server also serves the built client, so the game runs
   * same-origin and browsers send no Origin header at all — the list is only
   * consulted if you host the client somewhere separate. In development it
   * defaults to the Vite dev server.
   */
  corsOrigins: (process.env.CORS_ORIGINS ?? (IS_PROD ? '' : 'http://localhost:5173,http://127.0.0.1:5173'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Every managed host (Render, Railway, Fly, Heroku) puts a proxy in front of
   * the app, so req.ip must come from X-Forwarded-For or rate limiting would
   * key every player to the same proxy address. Defaults on in production.
   */
  trustProxy: process.env.TRUST_PROXY
    ? process.env.TRUST_PROXY === 'true'
    : IS_PROD,
};

export const DB = {
  file: process.env.DB_FILE ?? path.join(ROOT, 'data', 'ludo.db'),
  migrationsDir: path.join(__dirname, '..', 'db', 'migrations'),
};

/** GAME_CONFIG — the rule surface, read by the engine and the game service. */
export const GAME_CONFIG = {
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 4,
  TOKEN_COUNT: 4,

  TURN_DURATION_MS: int(process.env.TURN_DURATION_MS, 25_000),
  START_COUNTDOWN_MS: 3_000,

  /** Dice value required to bring a token out of the yard. */
  TOKEN_RELEASE_ROLL: 6,
  RELEASE_ON_ANY_ROLL_WHEN_STUCK: false,

  EXTRA_TURN_ON_SIX: true,
  EXTRA_TURN_ON_CAPTURE: true,
  EXTRA_TURN_ON_FINISH: true,
  /** Three sixes in a row forfeits the turn (classic anti-stall rule). */
  MAX_CONSECUTIVE_SIXES: 3,

  STACKING_ENABLED: true,
  BLOCKING_ENABLED: false,
  SAFE_CELLS_ENABLED: true,
  // false = overshooting the centre bounces back down the home column, so a
  // token near home can always move. true suppressed the move entirely, which
  // stranded tokens and silently passed the turn.
  EXACT_FINISH_REQUIRED: false,

  ON_TIMEOUT: 'auto_move', // 'auto_move' | 'skip'
  /**
   * Consecutive missed turns before a seat is dropped.
   *
   * The server auto-plays a timed-out turn, so a distracted player loses
   * nothing by missing one — which means dropping them is only for someone who
   * has genuinely walked away. Set high: in a 2-player game dropping a seat
   * ends the game immediately, and ending someone's game because they looked
   * away for a minute is far worse than letting a stalled game run on.
   */
  MAX_CONSECUTIVE_TIMEOUTS: int(process.env.MAX_CONSECUTIVE_TIMEOUTS, 20),

  /** How long a disconnected player keeps their seat. */
  RECONNECT_GRACE_MS: int(process.env.RECONNECT_GRACE_MS, 90_000),

  /** Turn order around the board. Seats are assigned from these lists. */
  COLORS: ['RED', 'GREEN', 'YELLOW', 'BLUE'],
  SEATING: {
    2: ['RED', 'YELLOW'],
    3: ['RED', 'GREEN', 'YELLOW'],
    4: ['RED', 'GREEN', 'YELLOW', 'BLUE'],
  },
};

export const ROOM = {
  codeLength: 5,
  codeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // no I/O/0/1 ambiguity
  codePrefix: '',
  emptyRoomTtlMs: 15 * 60_000,
};

/**
 * Abuse limits, tunable by environment so automated runs can raise them without
 * editing code. The defaults are what a human player will ever need.
 */
export const RATE_LIMITS = {
  api: { windowMs: 60_000, max: int(process.env.RATE_API_MAX, 300) },
  socketAction: { windowMs: 10_000, max: int(process.env.RATE_SOCKET_MAX, 90) },
  chat: { windowMs: 10_000, max: int(process.env.RATE_CHAT_MAX, 10) },
};
