/**
 * App state.
 *
 * `session` is who you are, `room` is the lobby, `game` is the authoritative
 * board snapshot. Nothing here decides a rule — it holds what the server sent
 * plus purely presentational state (dice phase, walking token, emotes).
 */
import { create } from 'zustand';
import { send } from '../lib/socket.js';
import { sfx } from '../lib/audio.js';

export const useSession = create((set) => ({
  player: null,
  ready: false,
  activeGameId: null,
  set: (patch) => set(patch),
}));

export const useRoom = create((set, get) => ({
  room: null,
  countdown: null,
  toast: null,

  setRoom: (room) => set({ room }),
  clear: () => set({ room: null, countdown: null }),
  setCountdown: (countdown) => set({ countdown }),

  flash(message) {
    if (!message) return;
    set({ toast: { message, at: Date.now() } });
    setTimeout(() => {
      if (Date.now() - (get().toast?.at ?? 0) >= 2400) set({ toast: null });
    }, 2600);
  },

  async create(maxPlayers) {
    const room = await send('room:create', { maxPlayers });
    set({ room });
    return room;
  },
  async join(code) {
    const room = await send('room:join', { code });
    set({ room });
    return room;
  },
  async leave() {
    const room = get().room;
    if (!room) return;
    await send('room:leave', { roomId: room.id });
    get().clear();
  },
  async setReady(isReady) {
    const room = get().room;
    if (room) await send('room:ready', { roomId: room.id, isReady });
  },
  async start() {
    const room = get().room;
    if (room) return send('game:start', { roomId: room.id });
    return null;
  },
  async kick(targetId) {
    const room = get().room;
    if (room) await send('room:kick', { roomId: room.id, targetId });
  },
  async updateSettings(settings) {
    const room = get().room;
    if (room) await send('room:settings', { roomId: room.id, settings });
  },
}));

export const useGame = create((set, get) => ({
  game: null,
  queue: [],
  dice: { value: null, phase: 'idle' }, // idle | rolling | result
  walking: null, // { seat, tokenIndex, progress }
  captured: [],
  emotes: [],
  results: null,
  pending: false,
  banner: null,

  /**
   * Applies an authoritative snapshot.
   *
   * The snapshot deliberately does NOT touch the die.
   *
   * Snapshots arrive as soon as the server processes an action, which is well
   * ahead of the animator replaying it. A roll and the move it causes arrive in
   * SEPARATE batches, so there is always a window where the snapshot already
   * holds the NEXT roll while the previous move is still being walked. Writing
   * the die here during that window is what made the face disagree with the
   * number of squares travelled.
   *
   * The die is written in exactly two places: `setDice`, called by the animator
   * from the event being replayed, and `clearDice` when a turn genuinely ends.
   */
  setGame(game) {
    const previous = get().game;
    set({ game });

    // Announce a turn the player actually owns.
    if (
      game?.you &&
      game.status === 'active' &&
      game.currentSeat === game.you.seat &&
      previous?.currentSeat !== game.currentSeat
    ) {
      sfx.yourTurn();
      get().flashBanner('YOUR TURN');
    }
  },

  /**
   * Clears the die between turns, once the animator has finished replaying.
   * Only the animator calls this, and only when the queue is fully drained.
   */
  clearDice() {
    if (get().queue.length > 0) return;
    const game = get().game;
    if (!game?.diceRolled) set({ dice: { value: null, phase: 'idle' } });
  },

  /** True while the animator is replaying queued events. */
  animating: false,
  setAnimating: (animating) => set({ animating }),

  enqueue: (events) => set({ queue: [...get().queue, ...events] }),
  shift() {
    const [next, ...rest] = get().queue;
    set({ queue: rest });
    return next ?? null;
  },

  setDice: (dice) => set({ dice: { ...get().dice, ...dice } }),
  setWalking: (walking) => set({ walking }),
  setCaptured: (captured) => set({ captured }),
  setResults: (results) => set({ results }),
  setPending: (pending) => set({ pending }),

  flashBanner(text, ms = 1300) {
    set({ banner: { text, at: Date.now() } });
    setTimeout(() => {
      if (Date.now() - (get().banner?.at ?? 0) >= ms - 60) set({ banner: null });
    }, ms);
  },

  pushEmote({ seat, emote }) {
    const id = `${seat}-${Date.now()}-${Math.random()}`;
    set({ emotes: [...get().emotes, { id, seat, emote }] });
    setTimeout(() => set({ emotes: get().emotes.filter((e) => e.id !== id) }), 2400);
  },

  /**
   * Aborts any in-flight replay before wiping state.
   *
   * The animator registers this hook rather than the store importing the
   * animator, which would be a cycle. Without it a replay mid-walk would keep
   * writing `walking` after the reset and strand a ghost token on the board.
   */
  onReset: null,
  setResetHook: (fn) => set({ onReset: fn }),

  reset: () => {
    get().onReset?.();
    set({
      game: null,
      queue: [],
      dice: { value: null, phase: 'idle' },
      walking: null,
      captured: [],
      emotes: [],
      results: null,
      pending: false,
      banner: null,
    });
  },

  // ------------------------------------------------------------- actions --

  /**
   * Ask the server to roll.
   *
   * This asks and nothing more. The ack's value is deliberately discarded:
   * Socket.IO delivers the broadcast (`game:events` + `game:state`) BEFORE it
   * resolves the ack, so writing the ack's value here would land after the
   * authoritative event and stamp a stale face over it.
   *
   * It also does NOT start the tumble. The animator owns the die for the whole
   * roll — spin, settle and clear — from the DICE_ROLLED event. Starting a spin
   * here as well meant two writers racing over one face: the local spin began
   * on tap, the animator's began on the event, and the die visibly stalled
   * between them before snapping to the result.
   */
  async roll() {
    const game = get().game;
    if (!game || get().pending) return null;
    set({ pending: true });
    try {
      return await send('game:roll', { gameId: game.id });
    } finally {
      set({ pending: false });
    }
  },

  /**
   * True while the animator is still replaying queued events.
   *
   * Rolling a six grants an extra turn, so a second roll can be requested while
   * the first move is still walking. The board would then show the newest die
   * beside a token walking the older move — "I rolled 2 but it moved 5".
   * The dice button is disabled until the replay drains.
   */
  isReplaying: () => get().animating || get().queue.length > 0,

  async move(tokenIndex) {
    const game = get().game;
    if (!game || get().pending) return null;
    // Refuse locally only when the SERVER said the move is unavailable.
    if (!game.legalMoves.some((m) => m.tokenIndex === tokenIndex)) return null;
    set({ pending: true });
    sfx.tokenSelect();
    try {
      return await send('game:move', { gameId: game.id, tokenIndex });
    } finally {
      set({ pending: false });
    }
  },

  async emote(emote) {
    const game = get().game;
    if (game) await send('game:emote', { gameId: game.id, emote });
  },

  async leaveGame() {
    const game = get().game;
    if (game) await send('game:leave', { gameId: game.id });
    get().reset();
  },
}));

/**
 * Exposes the store for automated browser tests, which need the authoritative
 * dice value rather than one inferred from a CSS transform mid-tumble. Reading
 * state is harmless — every action is validated server-side regardless.
 */
if (typeof window !== 'undefined') {
  window.__ludo = useGame;
  window.__room = useRoom;
}
