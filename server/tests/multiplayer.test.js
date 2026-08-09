/**
 * End-to-end multiplayer tests for the guest flow.
 *
 * A real HTTP + Socket.IO server driven by real socket clients — no mocks.
 * Covers the things that are hard to get right: identity without accounts,
 * lobby sync, server-authoritative dice, turn ownership, concurrent duplicate
 * actions, reconnect-by-device-id, and a full game played to a winner.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_DB = path.join(os.tmpdir(), `ludo-test-${process.pid}-${Date.now()}.db`);
process.env.DB_FILE = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
// Long turns so tests are not racing the clock; the timeout test sets its own.
process.env.TURN_DURATION_MS = '30000';
process.env.RECONNECT_GRACE_MS = '1500';
// A full game is hundreds of actions played as fast as the socket allows.
process.env.RATE_SOCKET_MAX = '100000';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { createSocketServer } = await import('../src/socket/index.js');
const rooms = await import('../src/services/room.service.js');
const games = await import('../src/services/game.service.js');
const { legalMoves } = await import('../src/game-engine/rules.js');
const { io: ioClient } = await import('socket.io-client');

let server;
let port;
let socketServer;

// ---------------------------------------------------------------- helpers ---

/**
 * A distinct browser: stable device id + display name. Names are padded to the
 * 2-character minimum the server enforces, so a one-letter label in a test does
 * not look like a server bug.
 */
const device = (name, suffix) => ({
  name: name.length >= 2 ? name : `${name}-player`,
  deviceId: `dev${suffix}${'x'.repeat(Math.max(0, 18 - suffix.length))}`,
});

function connect(who) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://localhost:${port}`, {
      auth: { deviceId: who.deviceId, name: who.name, avatar: 0 },
      transports: ['websocket'],
      reconnection: false,
    });
    socket.once('session_ready', (payload) => {
      socket.session = payload;
      resolve(socket);
    });
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error(`${who.name} failed to connect`)), 5000);
  });
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 5000);
    socket.emit(event, payload, (reply) => {
      clearTimeout(timer);
      if (!reply) return reject(new Error(`${event} returned no ack`));
      if (reply.ok) resolve(reply.data);
      else reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
    });
  });
}

function waitFor(socket, event, { timeout = 8000, where } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeout);
    const handler = (payload) => {
      if (where && !where(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function closeSockets(...sockets) {
  for (const s of sockets) s?.close();
  await new Promise((resolve) => setTimeout(resolve, 150));
}

/** Creates a room, seats everyone, readies up, starts, waits for the board. */
async function startGameWith(sockets, settings) {
  const host = sockets[0];
  const room = await emit(host, 'room:create', { maxPlayers: sockets.length });
  if (settings) await emit(host, 'room:settings', { roomId: room.id, settings });

  for (const s of sockets.slice(1)) await emit(s, 'room:join', { code: room.code });
  for (const s of sockets) await emit(s, 'room:ready', { roomId: room.id, isReady: true });

  const started = waitFor(host, 'game:started');
  const { gameId } = await emit(host, 'game:start', { roomId: room.id });
  await started;
  return { room, gameId };
}

// ------------------------------------------------------------------ setup ---

before(async () => {
  migrate();
  server = http.createServer();
  socketServer = createSocketServer(server);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

after(async () => {
  socketServer?.dispose();
  socketServer?.io.disconnectSockets(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  socketServer?.io.close();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));
  closeDb();
  try {
    for (const suffix of ['', '-wal', '-shm']) fs.unlinkSync(TMP_DB + suffix);
  } catch {
    /* best effort */
  }
});

// -------------------------------------------------------------- identity ---

test('a player is identified by name + device id, with no account', async () => {
  const s = await connect(device('Sai', 'A1'));
  assert.equal(s.session.player.name, 'Sai');
  assert.ok(s.session.player.id > 0);
  assert.equal(s.session.activeGameId, null);
  await closeSockets(s);
});

test('the same device keeps its identity across reconnects', async () => {
  const who = device('Kiran', 'A2');
  const first = await connect(who);
  const id = first.session.player.id;
  await closeSockets(first);

  const second = await connect(who);
  assert.equal(second.session.player.id, id, 'same device must map to the same player');
  await closeSockets(second);
});

test('a different device is a different player even with the same name', async () => {
  const a = await connect(device('Alex', 'A3'));
  const b = await connect(device('Alex', 'A4'));
  assert.notEqual(a.session.player.id, b.session.player.id);
  await closeSockets(a, b);
});

test('changing your name updates it without changing who you are', async () => {
  const who = device('Before', 'A5');
  const first = await connect(who);
  const id = first.session.player.id;
  await closeSockets(first);

  const second = await connect({ ...who, name: 'After' });
  assert.equal(second.session.player.id, id);
  assert.equal(second.session.player.name, 'After');
  await closeSockets(second);
});

test('a connection without a usable name or device id is refused', async () => {
  for (const auth of [{}, { deviceId: 'short', name: 'Sai' }, { deviceId: 'devZZZZZZZZZZZZZZZ9', name: 'x' }]) {
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const s = ioClient(`http://localhost:${port}`, {
            auth,
            transports: ['websocket'],
            reconnection: false,
          });
          s.once('connect', () => resolve(s));
          s.once('connect_error', reject);
        }),
      /IDENTIFY_FAILED|INVALID_NAME/,
    );
  }
});

// ----------------------------------------------------------------- lobby ---

test('lobby updates reach everyone without polling', async () => {
  const host = await connect(device('Host', 'B1'));
  const guest = await connect(device('Guest', 'B2'));

  const room = await emit(host, 'room:create', { maxPlayers: 4 });
  assert.equal(room.playerCount, 1);
  assert.equal(room.slots.length, 4);

  const sawJoin = waitFor(host, 'room:updated');
  await emit(guest, 'room:join', { code: room.code });
  const evt = await sawJoin;

  assert.equal(evt.room.playerCount, 2);
  assert.match(evt.message, /joined/);
  assert.equal(evt.room.canStart, false, 'nobody is ready yet');

  await closeSockets(host, guest);
});

test('a room code is case- and prefix-insensitive', async () => {
  const host = await connect(device('Host', 'B3'));
  const guest = await connect(device('Guest', 'B4'));
  const room = await emit(host, 'room:create', { maxPlayers: 2 });

  const joined = await emit(guest, 'room:join', { code: ` ludo-${room.code.toLowerCase()} ` });
  assert.equal(joined.id, room.id);

  await closeSockets(host, guest);
});

test('only the host can start, and only when everyone is ready', async () => {
  const host = await connect(device('Host', 'B5'));
  const guest = await connect(device('Guest', 'B6'));
  const room = await emit(host, 'room:create', { maxPlayers: 2 });
  await emit(guest, 'room:join', { code: room.code });

  await assert.rejects(() => emit(host, 'game:start', { roomId: room.id }), /ready/i);

  await emit(host, 'room:ready', { roomId: room.id, isReady: true });
  await emit(guest, 'room:ready', { roomId: room.id, isReady: true });

  await assert.rejects(() => emit(guest, 'game:start', { roomId: room.id }), /host/i);

  const { gameId } = await emit(host, 'game:start', { roomId: room.id });
  assert.ok(gameId > 0);

  await closeSockets(host, guest);
});

test('a full room refuses another player', async () => {
  const a = await connect(device('A', 'C1'));
  const b = await connect(device('B', 'C2'));
  const c = await connect(device('C', 'C3'));
  const room = await emit(a, 'room:create', { maxPlayers: 2 });
  await emit(b, 'room:join', { code: room.code });

  await assert.rejects(() => emit(c, 'room:join', { code: room.code }), /full/i);
  await closeSockets(a, b, c);
});

test('host leaving transfers the crown instead of closing the room', async () => {
  const host = await connect(device('Host', 'C4'));
  const guest = await connect(device('Guest', 'C5'));
  const room = await emit(host, 'room:create', { maxPlayers: 4 });
  await emit(guest, 'room:join', { code: room.code });

  const sawLeave = waitFor(guest, 'room:updated', { where: (p) => p.leftId != null });
  await emit(host, 'room:leave', { roomId: room.id });
  const evt = await sawLeave;

  assert.equal(evt.closed, false, 'the room must survive');
  assert.equal(evt.newHostId, guest.session.player.id);
  await closeSockets(host, guest);
});

// ------------------------------------------------------------------ game ---

test('the board starts with every token in the yard and correct seating', async () => {
  const a = await connect(device('A', 'D1'));
  const b = await connect(device('B', 'D2'));
  const { gameId } = await startGameWith([a, b]);

  const dto = await emit(a, 'game:join', { gameId });
  assert.equal(dto.status, 'active');
  assert.equal(dto.tokens.length, 8);
  assert.ok(dto.tokens.every((t) => t.progress === -1));
  assert.equal(dto.you.seat, 0);
  assert.equal(dto.you.color, 'RED');
  assert.deepEqual(dto.players.map((p) => p.color), ['RED', 'YELLOW']);

  await closeSockets(a, b);
});

test('a roll is broadcast to the opponent with the same value', async () => {
  const a = await connect(device('A', 'D3'));
  const b = await connect(device('B', 'D4'));
  const { gameId } = await startGameWith([a, b]);

  const opponentSaw = waitFor(b, 'game:events', {
    where: (p) => p.events.some((e) => e.type === 'DICE_ROLLED'),
  });
  const result = await emit(a, 'game:roll', { gameId });
  const seen = await opponentSaw;

  const diceEvent = seen.events.find((e) => e.type === 'DICE_ROLLED');
  assert.equal(diceEvent.value, result.diceValue, 'both players see the same dice');
  assert.ok(diceEvent.value >= 1 && diceEvent.value <= 6);
  assert.equal(diceEvent.seat, 0);

  await closeSockets(a, b);
});

test('the client cannot choose its own dice value', async () => {
  const a = await connect(device('A', 'D5'));
  const b = await connect(device('B', 'D6'));
  const { gameId } = await startGameWith([a, b]);

  const values = [];
  for (let i = 0; i < 30; i += 1) {
    const state = games.loadState(gameId);
    if (state.status !== 'active') break;
    const socket = state.currentSeat === 0 ? a : b;

    if (state.diceRolled) {
      const moves = legalMoves(state, state.currentSeat, state.diceValue);
      if (moves.length) await emit(socket, 'game:move', { gameId, tokenIndex: moves[0].tokenIndex });
      continue;
    }
    // A crafted payload demanding a six — the server ignores these fields.
    const r = await emit(socket, 'game:roll', { gameId, value: 6, diceValue: 6, dice: 6 });
    assert.ok(r.diceValue >= 1 && r.diceValue <= 6, `impossible value ${r.diceValue}`);
    values.push(r.diceValue);
  }

  assert.ok(values.length >= 5, 'expected several rolls');
  assert.ok(values.some((v) => v !== 6), 'every roll was a six — client is choosing the dice');

  await closeSockets(a, b);
});

test('a player cannot act out of turn', async () => {
  const a = await connect(device('A', 'E1'));
  const b = await connect(device('B', 'E2'));
  const { gameId } = await startGameWith([a, b]);

  await assert.rejects(() => emit(b, 'game:roll', { gameId }), /not your turn/i);

  await emit(a, 'game:roll', { gameId });
  const state = games.loadState(gameId);
  const offTurn = state.currentSeat === 0 ? b : a;
  for (let tokenIndex = 0; tokenIndex < 4; tokenIndex += 1) {
    await assert.rejects(
      () => emit(offTurn, 'game:move', { gameId, tokenIndex }),
      /not your turn/i,
      `token ${tokenIndex} was movable by the wrong player`,
    );
  }

  await closeSockets(a, b);
});

test('duplicate simultaneous rolls apply exactly once', async () => {
  const a = await connect(device('A', 'E3'));
  const b = await connect(device('B', 'E4'));
  const { gameId } = await startGameWith([a, b]);

  const before = games.loadState(gameId).stateVersion;
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, () => emit(a, 'game:roll', { gameId })),
  );
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(games.loadState(gameId).stateVersion, before + 1);

  await closeSockets(a, b);
});

test('a non-member cannot join or inspect a game', async () => {
  const a = await connect(device('A', 'E5'));
  const b = await connect(device('B', 'E6'));
  const outsider = await connect(device('Nosy', 'E7'));
  const { gameId } = await startGameWith([a, b]);

  await assert.rejects(() => emit(outsider, 'game:join', { gameId }), /not a player/i);
  await assert.rejects(() => emit(outsider, 'game:sync', { gameId }), /not a player/i);
  await assert.rejects(() => emit(outsider, 'game:roll', { gameId }), /not/i);

  await closeSockets(a, b, outsider);
});

// ----------------------------------------------------------- reconnection ---

test('reconnecting with the same device restores the seat and board', async () => {
  const whoA = device('A', 'F1');
  let a = await connect(whoA);
  const b = await connect(device('B', 'F2'));
  const { gameId } = await startGameWith([a, b]);

  await emit(a, 'game:roll', { gameId });
  const before = games.loadState(gameId);

  const sawDrop = waitFor(b, 'game:presence', { where: (p) => p.connected === false });
  await closeSockets(a);
  const drop = await sawDrop;
  assert.equal(drop.seat, 0);
  assert.ok(drop.graceMs > 0);

  const during = games.loadState(gameId);
  assert.equal(during.status, 'active', 'a disconnect must not end the game');
  assert.deepEqual(
    during.tokens.map((t) => t.progress),
    before.tokens.map((t) => t.progress),
    'the board must be untouched by a disconnect',
  );

  // Same device comes back — session_ready points straight at the live game.
  a = await connect(whoA);
  assert.equal(a.session.activeGameId, gameId, 'the client is told to resume');

  const rejoined = await emit(a, 'game:join', { gameId });
  assert.equal(rejoined.you.seat, 0);
  assert.deepEqual(
    rejoined.tokens.map((t) => t.progress),
    before.tokens.map((t) => t.progress),
    'token positions survived the round trip',
  );

  const sync = await emit(a, 'game:sync', { gameId, lastStateVersion: 1 });
  assert.ok(sync.snapshot.stateVersion >= 2);
  assert.ok(Array.isArray(sync.events));

  await closeSockets(a, b);
});

test('the turn clock advances play when nobody acts', async () => {
  const a = await connect(device('A', 'F3'));
  const b = await connect(device('B', 'F4'));
  // This room gets a deliberately short turn so the clock fires during the test.
  const { gameId } = await startGameWith([a, b], { turnDurationMs: 5000 });

  const startTurn = games.loadState(gameId).turnNumber;
  await waitFor(b, 'game:events', {
    timeout: 14_000,
    where: (p) => p.events.some((e) => e.type === 'TURN_STARTED' || e.type === 'TURN_FORFEITED'),
  });
  assert.ok(games.loadState(gameId).turnNumber > startTurn, 'the server must move play on');

  await closeSockets(a, b);
});

// ----------------------------------------------------------- full game ---

test('two players can play a complete game to a winner over sockets', async () => {
  const a = await connect(device('A', 'G1'));
  const b = await connect(device('B', 'G2'));
  const { gameId } = await startGameWith([a, b]);

  let guard = 0;
  while (guard < 4000) {
    guard += 1;
    const state = games.loadState(gameId);
    if (state.status !== 'active') break;

    const socket = state.currentSeat === 0 ? a : b;
    if (!state.diceRolled) {
      await emit(socket, 'game:roll', { gameId });
      continue;
    }
    const moves = legalMoves(state, state.currentSeat, state.diceValue);
    if (moves.length === 0) {
      await new Promise((r) => setTimeout(r, 15));
      continue;
    }
    await emit(socket, 'game:move', { gameId, tokenIndex: moves[0].tokenIndex });
  }

  const final = games.loadState(gameId);
  assert.equal(final.status, 'finished', `game did not finish after ${guard} actions`);
  assert.notEqual(final.winnerSeat, null);
  assert.ok(
    final.tokens.filter((t) => t.seat === final.winnerSeat).every((t) => t.state === 'FINISHED'),
    'the winner must have all four tokens home',
  );

  const results = games.gameResults(gameId);
  assert.equal(results.status, 'finished');
  assert.deepEqual(results.standings.map((s) => s.rank), [1, 2]);
  assert.ok(results.standings.every((s) => s.name && s.id > 0), 'standings carry real player ids');
  assert.equal(results.standings[0].id, results.winnerId);

  await closeSockets(a, b);
});

test('a 4-player game seats all four colours and ranks everyone', async () => {
  const sockets = [];
  for (let i = 0; i < 4; i += 1) sockets.push(await connect(device(`P${i}`, `H${i}`)));
  const { gameId } = await startGameWith(sockets);

  const dto = await emit(sockets[0], 'game:join', { gameId });
  assert.equal(dto.playerCount, 4);
  assert.deepEqual(dto.players.map((p) => p.color), ['RED', 'GREEN', 'YELLOW', 'BLUE']);
  assert.equal(dto.tokens.length, 16);

  await closeSockets(...sockets);
});

test('ready state is reflected back to the player who tapped it', async () => {
  // Regression: the lobby could not recognise its own seat, so the Ready button
  // stayed on "I'm Ready" forever even though the server had recorded the tap.
  const host = await connect(device('Host', 'R1'));
  const guest = await connect(device('Guest', 'R2'));
  const room = await emit(host, 'room:create', { maxPlayers: 2 });
  await emit(guest, 'room:join', { code: room.code });

  const hostId = host.session.player.id;
  const guestId = guest.session.player.id;
  assert.ok(hostId > 0 && guestId > 0, 'session_ready must deliver a player id');

  // The ack must let the caller find itself and see its own flag flipped.
  const afterReady = await emit(host, 'room:ready', { roomId: room.id, isReady: true });
  const meInAck = afterReady.players.find((p) => p.id === hostId);
  assert.ok(meInAck, 'the acking player must appear in the room payload');
  assert.equal(meInAck.isReady, true, 'the tapping player must see themselves as ready');
  assert.equal(afterReady.readyCount, 1);

  // And it must be possible to toggle back off.
  const afterUnready = await emit(host, 'room:ready', { roomId: room.id, isReady: false });
  assert.equal(afterUnready.players.find((p) => p.id === hostId).isReady, false);
  assert.equal(afterUnready.readyCount, 0);

  await closeSockets(host, guest);
});

test('every player in a room payload carries a resolvable id', async () => {
  // The lobby matches its own seat by id; a missing or shadowed id there is what
  // makes controls appear stuck.
  const host = await connect(device('Host', 'R3'));
  const guest = await connect(device('Guest', 'R4'));
  const room = await emit(host, 'room:create', { maxPlayers: 4 });
  const joined = await emit(guest, 'room:join', { code: room.code });

  for (const p of joined.players) {
    assert.ok(Number.isInteger(p.id) && p.id > 0, `player ${p.name} has no usable id`);
    assert.ok(typeof p.name === 'string' && p.name.length >= 2);
    assert.ok(['RED', 'GREEN', 'YELLOW', 'BLUE'].includes(p.color));
  }
  assert.equal(joined.players.find((p) => p.id === host.session.player.id)?.isHost, true);

  await closeSockets(host, guest);
});
