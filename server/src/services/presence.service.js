/**
 * Who is currently connected.
 *
 * In-memory by design — it is derived from live socket connections and must not
 * survive a restart. A player may have several sockets open (a reload races the
 * old one closing), so they count as online while at least one remains.
 */
class Presence {
  constructor() {
    /** playerId -> Set<socketId> */
    this.sockets = new Map();
  }

  connect(playerId, socketId) {
    if (!this.sockets.has(playerId)) this.sockets.set(playerId, new Set());
    this.sockets.get(playerId).add(socketId);
  }

  /** @returns {boolean} true if that was the player's last socket. */
  disconnect(playerId, socketId) {
    const set = this.sockets.get(playerId);
    if (!set) return true;
    set.delete(socketId);
    if (set.size === 0) {
      this.sockets.delete(playerId);
      return true;
    }
    return false;
  }

  isOnline(playerId) {
    return (this.sockets.get(playerId)?.size ?? 0) > 0;
  }

  socketsFor(playerId) {
    return [...(this.sockets.get(playerId) ?? [])];
  }

  onlineCount() {
    return this.sockets.size;
  }
}

export const presence = new Presence();
