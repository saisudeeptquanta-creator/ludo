/**
 * Application errors carry an HTTP status, a stable machine `code`, and a
 * message that is safe to show a player. Anything thrown that is *not* an
 * AppError is treated as a bug and surfaced as a generic 500.
 */
export class AppError extends Error {
  constructor(status, code, message, meta = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.meta = meta;
    this.expose = true;
  }
}

export const badRequest = (code, message, meta) => new AppError(400, code, message, meta);
export const unauthorized = (code = 'UNAUTHORIZED', message = 'Please sign in to continue.') =>
  new AppError(401, code, message);
export const forbidden = (code = 'FORBIDDEN', message = 'You do not have access to this.') =>
  new AppError(403, code, message);
export const notFound = (code = 'NOT_FOUND', message = 'That no longer exists.') =>
  new AppError(404, code, message);
export const conflict = (code, message, meta) => new AppError(409, code, message, meta);
export const tooMany = (code = 'RATE_LIMITED', message = 'Slow down a moment and try again.') =>
  new AppError(429, code, message);

/** Friendly copy for the errors players actually hit. */
export const MESSAGES = {
  ROOM_NOT_FOUND: 'Unable to join room — that code does not match an open room.',
  ROOM_FULL: 'This game is full.',
  ROOM_STARTED: 'This game has already started.',
  GAME_NOT_FOUND: 'Game no longer exists.',
  NOT_YOUR_TURN: 'It is not your turn.',
  TURN_EXPIRED: 'Your turn has expired.',
  NOT_IN_GAME: 'You are not a player in this game.',
  ALREADY_ROLLED: 'You have already rolled this turn.',
  NOT_ROLLED: 'Roll the dice first.',
  ILLEGAL_MOVE: 'That move is not allowed.',
  NOT_YOUR_TOKEN: 'That token is not yours.',
};
