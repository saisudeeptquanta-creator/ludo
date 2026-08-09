/**
 * Socket manager.
 *
 * One connection per tab. Identity travels on the handshake as a device id, so
 * a reconnect automatically reclaims the player's seat with no login step.
 */
import { io } from 'socket.io-client';
import { getDeviceId, loadProfile } from './device.js';

let socket = null;
let status = 'idle'; // idle | connecting | connected | reconnecting | disconnected | rejected
const listeners = new Set();
/** Handlers registered before a socket existed, replayed on connect. */
let pending = [];

function setStatus(next) {
  if (status === next) return;
  status = next;
  for (const fn of listeners) fn(next);
}

export const getStatus = () => status;

export function onStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

export function connectSocket() {
  if (socket) return socket;
  const profile = loadProfile();
  // The server rejects an unusable name; connecting without one would only
  // produce a spurious 'rejected' status on first load.
  if (profile.name.trim().length < 2) return null;

  setStatus('connecting');
  socket = io({
    auth: { deviceId: getDeviceId(), name: profile.name, avatar: profile.avatar },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 400,
    reconnectionDelayMax: 4000,
    timeout: 10_000,
  });

  // Attach everything that subscribed before the socket existed.
  for (const [event, handler] of pending) socket.on(event, handler);
  pending = [];

  socket.on('connect', () => setStatus('connected'));
  socket.on('disconnect', (reason) => {
    setStatus(reason === 'io server disconnect' ? 'disconnected' : 'reconnecting');
  });
  socket.io.on('reconnect_attempt', () => setStatus('reconnecting'));
  socket.on('connect_error', (err) => {
    // A name the server will not accept is terminal — retrying cannot fix it.
    if (err.message === 'INVALID_NAME' || err.message === 'IDENTIFY_FAILED') {
      setStatus('rejected');
      socket.disconnect();
    } else {
      setStatus('reconnecting');
    }
  });

  return socket;
}

/** Re-handshakes with an updated name so the change reaches the server. */
export function reconnectWithProfile() {
  if (!socket) return connectSocket();
  const profile = loadProfile();
  socket.auth = { deviceId: getDeviceId(), name: profile.name, avatar: profile.avatar };
  socket.disconnect().connect();
  return socket;
}

export function disconnectSocket() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  setStatus('idle');
}

export const getSocket = () => socket;

/** Emits with an ack; resolves with the server's data or rejects with its error. */
export function send(event, payload = {}, { timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(Object.assign(new Error('You are offline. Reconnecting…'), { code: 'OFFLINE' }));
      return;
    }
    const timer = setTimeout(
      () => reject(Object.assign(new Error('The server did not respond.'), { code: 'TIMEOUT' })),
      timeout,
    );
    socket.emit(event, payload, (reply) => {
      clearTimeout(timer);
      if (!reply) reject(Object.assign(new Error('No response.'), { code: 'NO_ACK' }));
      else if (reply.ok) resolve(reply.data);
      else reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
    });
  });
}

/**
 * Registers a listener without forcing a connection.
 *
 * Listening and connecting are deliberately separate: the app subscribes at
 * startup, but a guest has no name until they type one, and connecting with an
 * empty name is rejected by the server. Handlers registered before the socket
 * exists are replayed onto it the moment `connectSocket()` runs.
 */
export function on(event, handler) {
  if (socket) {
    socket.on(event, handler);
  } else {
    pending.push([event, handler]);
  }
  return () => {
    if (socket) socket.off(event, handler);
    const i = pending.findIndex(([e, h]) => e === event && h === handler);
    if (i !== -1) pending.splice(i, 1);
  };
}

export function onMany(map) {
  const offs = Object.entries(map).map(([event, handler]) => on(event, handler));
  return () => offs.forEach((off) => off());
}
