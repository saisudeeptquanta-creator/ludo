import crypto from 'node:crypto';
import { ROOM } from '../config/index.js';

/** URL-safe public identifier for games (never expose the integer PK). */
export function publicId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Room code body, e.g. "X7K9P". The display form adds the LUDO- prefix. */
export function roomCode() {
  const { codeLength, codeAlphabet } = ROOM;
  let out = '';
  // rejection-sample so every character is uniformly distributed
  const limit = 256 - (256 % codeAlphabet.length);
  while (out.length < codeLength) {
    for (const byte of crypto.randomBytes(codeLength * 2)) {
      if (byte >= limit) continue;
      out += codeAlphabet[byte % codeAlphabet.length];
      if (out.length === codeLength) break;
    }
  }
  return out;
}

export const displayRoomCode = (code) => `${ROOM.codePrefix}${code}`;

/** Accepts "X7K9P", "ludo-x7k9p", " LUDO-X7K9P " and normalises them. */
export function normalizeRoomCode(input) {
  return String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/^LUDO[-\s]?/, '')
    .replace(/[^A-Z0-9]/g, '');
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
