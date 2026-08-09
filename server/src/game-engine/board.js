/**
 * Board geometry for a standard 15x15 Ludo board.
 *
 * The single source of truth for a token's location is its `progress`:
 *
 *   -1        in the yard (not yet released)
 *    0..50    on the shared 52-cell ring; ringIndex = (START[color] + progress) % 52
 *    51..55   in the colour's private home column (5 cells)
 *    56       finished, on the centre
 *
 * That means "how far along am I" is colour-relative, while "which square am I
 * standing on" is absolute — collisions and captures are resolved on the
 * absolute ring index, never on progress.
 *
 * This module is pure geometry: no game state, no rules, no I/O. It is shared
 * verbatim by the server engine and the client renderer.
 */

export const COLORS = ['RED', 'GREEN', 'YELLOW', 'BLUE'];

export const GRID_SIZE = 15;
export const RING_LENGTH = 52;
/**
 * Six squares, running from the ring inward until the last one is orthogonally
 * adjacent to the centre. The 15x15 cross has 81 squares, accounted for as
 * 52 ring + 4x6 home column + 1 centre + 4 decorative centre corners.
 */
export const HOME_COLUMN_LENGTH = 6;

/**
 * Last progress value still on the ring. A token walks its entry square plus 50
 * more, i.e. 51 of the 52 ring squares — it turns into its home column one
 * square before completing the loop.
 */
export const LAST_RING_PROGRESS = RING_LENGTH - 2; // 50
/** progress value that means "on the centre / finished". */
export const FINISH_PROGRESS = LAST_RING_PROGRESS + HOME_COLUMN_LENGTH + 1; // 57

/**
 * The ring, walked clockwise starting from RED's entry square at [13,6].
 * Built from straight segments so the 52 coordinates cannot drift apart from
 * each other by a hand-editing mistake.
 */
function buildRing() {
  const seg = (from, to) => {
    const [r1, c1] = from;
    const [r2, c2] = to;
    const dr = Math.sign(r2 - r1);
    const dc = Math.sign(c2 - c1);
    const steps = Math.max(Math.abs(r2 - r1), Math.abs(c2 - c1));
    const cells = [];
    for (let i = 0; i <= steps; i += 1) cells.push([r1 + dr * i, c1 + dc * i]);
    return cells;
  };

  return [
    ...seg([13, 6], [9, 6]),   //  0.. 4  up RED's approach column
    ...seg([8, 5], [8, 0]),    //  5..10  left along the west arm
    ...seg([7, 0], [7, 0]),    // 11      west corner
    ...seg([6, 0], [6, 5]),    // 12..17  right along the west arm (GREEN entry at 13)
    ...seg([5, 6], [0, 6]),    // 18..23  up GREEN's approach column
    ...seg([0, 7], [0, 7]),    // 24      north corner
    ...seg([0, 8], [5, 8]),    // 25..30  down the north arm (YELLOW entry at 26)
    ...seg([6, 9], [6, 14]),   // 31..36  right along the north arm
    ...seg([7, 14], [7, 14]),  // 37      east corner
    ...seg([8, 14], [8, 9]),   // 38..43  left along the east arm (BLUE entry at 39)
    ...seg([9, 8], [14, 8]),   // 44..49  down BLUE's approach column
    ...seg([14, 7], [14, 7]),  // 50      south corner
    ...seg([14, 6], [14, 6]),  // 51      last square before RED's entry
  ];
}

export const RING = buildRing();

if (RING.length !== RING_LENGTH) {
  throw new Error(`Board geometry broken: ring has ${RING.length} cells, expected ${RING_LENGTH}`);
}

/** Ring index each colour enters the track on. Evenly spaced 13 apart. */
export const START_INDEX = { RED: 0, GREEN: 13, YELLOW: 26, BLUE: 39 };

/**
 * Squares where tokens cannot be captured: the four entry squares plus the four
 * starred squares eight steps further on.
 */
export const SAFE_RING_INDICES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/** The four starred squares (entry squares are drawn in the owner's colour). */
export const STAR_RING_INDICES = new Set([8, 21, 34, 47]);

/** Private home columns, ordered from the ring inward. Centre is separate. */
export const HOME_COLUMN = {
  RED:    [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]],
  GREEN:  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
  YELLOW: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]],
  BLUE:   [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
};

export const CENTER_CELL = [7, 7];

/**
 * The four squares at the corners of the centre block. They are neither track
 * nor home column — purely decorative — but the renderer needs to know they
 * exist so it does not draw them as playable squares.
 */
export const CENTER_CORNERS = [[6, 6], [6, 8], [8, 6], [8, 8]];

/**
 * The four places the track rounds the centre block diagonally. A token stepping
 * across one of these moves corner-to-corner; the client eases through them
 * rather than drawing an impossible orthogonal step.
 */
export const DIAGONAL_RING_STEPS = new Set([4, 17, 30, 43]);

/** Where the four un-released tokens sit inside each 6x6 corner yard. */
export const YARD_SLOTS = {
  RED:    [[10, 1], [10, 4], [13, 1], [13, 4]],
  GREEN:  [[1, 1], [1, 4], [4, 1], [4, 4]],
  YELLOW: [[1, 10], [1, 13], [4, 10], [4, 13]],
  BLUE:   [[10, 10], [10, 13], [13, 10], [13, 13]],
};

/** Top-left corner of each colour's 6x6 yard quadrant. */
export const YARD_ORIGIN = {
  RED: [9, 0],
  GREEN: [0, 0],
  YELLOW: [0, 9],
  BLUE: [9, 9],
};

// --------------------------------------------------------------- queries ---

export const isInYard = (progress) => progress < 0;
export const isOnRing = (progress) => progress >= 0 && progress <= LAST_RING_PROGRESS;
export const isInHomeColumn = (progress) =>
  progress > LAST_RING_PROGRESS && progress < FINISH_PROGRESS;
export const isFinished = (progress) => progress >= FINISH_PROGRESS;

/** Absolute ring square a token stands on, or null if it is not on the ring. */
export function ringIndexFor(color, progress) {
  if (!isOnRing(progress)) return null;
  return (START_INDEX[color] + progress) % RING_LENGTH;
}

/** Index within the colour's home column (0..4), or null. */
export function homeColumnIndexFor(progress) {
  if (!isInHomeColumn(progress)) return null;
  return progress - LAST_RING_PROGRESS - 1;
}

export const isSafeRingIndex = (ringIndex) => SAFE_RING_INDICES.has(ringIndex);

/**
 * A token is safe from capture in the yard, in its own home column, on the
 * centre, or on one of the eight safe squares.
 */
export function isSafeProgress(color, progress) {
  if (!isOnRing(progress)) return true;
  return isSafeRingIndex(ringIndexFor(color, progress));
}

/**
 * Stable key for "which square is this token standing on". Two tokens collide
 * exactly when their cell keys match — ring squares are shared between colours,
 * home columns and yards are not.
 */
export function cellKey(color, progress) {
  if (isInYard(progress)) return `Y:${color}`;
  if (isFinished(progress)) return `F:${color}`;
  if (isInHomeColumn(progress)) return `H:${color}:${homeColumnIndexFor(progress)}`;
  return `R:${ringIndexFor(color, progress)}`;
}

/** Grid coordinate [row, col] for rendering. Yard needs the token's slot. */
export function coordFor(color, progress, tokenIndex = 0) {
  if (isInYard(progress)) return YARD_SLOTS[color][tokenIndex];
  if (isFinished(progress)) return CENTER_CELL;
  if (isInHomeColumn(progress)) return HOME_COLUMN[color][homeColumnIndexFor(progress)];
  return RING[ringIndexFor(color, progress)];
}

/**
 * Every square a token passes through moving `from` -> `to`, excluding the
 * origin and including the destination. Drives step-by-step animation on the
 * client and blocking checks on the server.
 */
export function pathBetween(color, from, to) {
  // Releasing from the yard (from === -1) is a single hop onto the entry
  // square, which this loop already produces as [0].
  const path = [];
  for (let p = Math.max(from, -1) + 1; p <= to; p += 1) path.push(p);
  return path;
}

/** Which colour owns a given ring square as its entry point, if any. */
export function entryOwner(ringIndex) {
  for (const color of COLORS) if (START_INDEX[color] === ringIndex) return color;
  return null;
}
