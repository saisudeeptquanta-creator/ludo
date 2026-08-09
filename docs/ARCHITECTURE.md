# Architecture

## 1. The governing principle

> **The client sends intent. The server sends fact.**

Everything below follows from that. A client asks to roll; it does not roll. It asks to move token
2; it does not decide token 2 may move. It renders a board; it does not compute one.

Concretely, the client never has code that can:

| | Where it actually happens |
|---|---|
| Generate a dice value | `crypto.randomInt(1, 7)` in `engine.rollDiceValue()` |
| Decide a move is legal | `rules.legalMoves()` on the server |
| Move a token | `engine.applyMove()` on the server |
| Resolve a capture | `engine.applyMove()` on the server |
| Advance a turn | `engine.beginTurn()` / `grantExtraTurn()` |
| Declare a winner | `engine.concludeIfOver()` |
| Award XP | `game.service.finalizeGame()` |

The client receives a snapshot that already contains `legalMoves` — computed by the server, **for
that viewer only**. That is why token highlighting is both instant and impossible to forge: the UI
is reading an answer, not deriving one.

---

## 2. Layers

```
┌──────────────────────────────────────────────────────────────┐
│  CLIENT (React + Vite)                                       │
│                                                              │
│   pages/          screens, no rules                          │
│   components/     board renderer, dice, cards                │
│   store/          zustand slices: auth · ui · room · game    │
│   lib/            api.js · socket.js · audio.js              │
│         │                                                    │
│         │  intents (socket)          facts (socket)          │
└─────────┼────────────────────────────────▲───────────────────┘
          ▼                                │
┌──────────────────────────────────────────┴───────────────────┐
│  SERVER (Node + Express + Socket.IO)                         │
│                                                              │
│   socket/         auth, handlers, turn scheduler             │
│   routes/         REST: auth, profile, social, rooms, admin  │
│   middleware/     validation, rate limit, error boundary     │
│   services/       auth · user · friend · room · GAME         │
│         │                                                    │
│   game-engine/    board.js · rules.js · engine.js            │
│                   PURE — no I/O, no clock, no randomness     │
│         │                                                    │
│   db/             node:sqlite, WAL, migrations               │
└──────────────────────────────────────────────────────────────┘
```

The engine sits at the bottom on purpose: it depends on nothing, so it can be tested exhaustively
and reused by the renderer.

---

## 3. Board geometry — the one model everything shares

A token's location is a single integer, `progress`:

| `progress` | Meaning |
|---|---|
| `-1` | In the yard |
| `0 … 50` | On the shared 52-square ring; `ringIndex = (START[colour] + progress) % 52` |
| `51 … 56` | In the colour's private 6-square home column |
| `57` | Finished, on the centre |

This split is what makes captures correct. *How far along am I* is colour-relative; *which square am
I standing on* is absolute. Collisions resolve on `cellKey()`, which returns `R:<ringIndex>` for
shared squares and `H:<colour>:<i>` / `Y:<colour>` for private ones. Two colours on ring square 13
collide; two colours on "home column square 2" never do.

The 15×15 cross is exactly 81 squares and is fully tiled, which a test asserts:

```
52 ring + (4 × 6) home column + 1 centre + 4 decorative centre corners = 81
```

The ring is generated from straight segments rather than typed out, so 52 coordinates cannot drift
apart from each other. It rounds the centre block diagonally at exactly four points — a property of
the standard board, asserted rather than assumed.

**The client imports this module directly from the server** through the `@engine` Vite alias. There
is no second copy of the geometry to fall out of sync.

---

## 4. Concurrency: why two rolls cannot both apply

The dangerous case is two packets for the same turn arriving together — a double-click, a laggy
retry, or a scripted client firing five rolls at once.

```js
export function rollDice({ gameId, userId }) {
  return transaction(() => {          // BEGIN IMMEDIATE
    const state = loadState(gameId);  // read authoritative state
    if (state.diceRolled) throw conflict('ALREADY_ROLLED', …);
    const result = engine.rollDice(state, { seat });
    saveState(result.state);          // stateVersion += 1
    recordEvents(…);
    return result;                    // COMMIT
  });
}
```

Two things make this airtight:

1. **`node:sqlite` is synchronous and Node runs one callback at a time.** A `transaction()` block
   here cannot be interleaved by another socket handler — there is no `await` inside it to yield on.
2. **`BEGIN IMMEDIATE`** takes the write lock up front, extending the guarantee across processes.

The read-check-write is therefore atomic. A test fires five simultaneous rolls and asserts exactly
one succeeds and `stateVersion` advanced exactly once.

---

## 5. State versioning and reconnection

Every accepted transition increments `stateVersion` by exactly one and appends to `game_events`.
That single counter powers reconnection:

```
client reconnects
   │
   ├─ game:sync { gameId, lastStateVersion: 41 }
   │
   ├─ gap ≤ 200 → server returns the missed events, client animates through them
   └─ gap > 200 → server returns a fresh snapshot, client resyncs and skips the theatre
```

The snapshot is always the truth; events are only how the eye gets there. If the animator falls more
than twelve events behind it fast-forwards, so a slow tab converges on the correct board rather than
drifting further behind.

**A disconnect never touches the board.** `setConnected()` flips one flag and emits an event; token
positions, the turn and the clock are untouched — asserted by a test that snapshots every token
position across a drop and a rejoin.

---

## 6. The turn clock

A client-side countdown is cosmetic. The real deadline lives in `TurnScheduler`, which arms a
`setTimeout` per game keyed to the turn number it was armed for. When it fires, the server plays or
skips the turn itself.

Stale timers are harmless: `applyTimeout({ expectedTurnNumber })` returns immediately if the turn
already moved on, so a re-armed clock can never double-fire on a turn that was played normally.

Clock skew is handled by shipping `serverTime` in every snapshot; the client renders
`turnDeadlineAt` against its own corrected offset rather than trusting either machine alone.

---

## 7. Data model

Normalized, foreign-keyed, indexed. The tables that carry the game:

```
games          one row per game: status, current_seat, dice, state_version, deadline
game_players   one row per seat: colour, connection, rank, per-player counters
game_tokens    one row per token: progress + derived state  ← authoritative positions
game_moves     append-only: from/to progress, dice, captures  ← powers replay
game_events    append-only: typed event log  ← powers reconnect + admin inspector
```

The normalized tables **are** the source of truth. `loadState()` rebuilds the engine's state object
from them and `saveState()` writes it back. There is no JSON blob shadowing them, which is why the
admin inspector and the replay system read exactly the rows the live game runs on.

Partial unique indexes enforce the rules the application would otherwise have to remember:

```sql
CREATE UNIQUE INDEX ux_room_seat ON room_players(room_id, seat) WHERE left_at IS NULL;
CREATE UNIQUE INDEX ux_rooms_code_open ON rooms(code) WHERE status <> 'closed';
CREATE UNIQUE INDEX ux_freq_pending ON friend_requests(sender_id, receiver_id) WHERE status = 'pending';
```

A seat cannot be double-occupied and a room code cannot be reused while live, at the storage layer
rather than by convention.

---

## 8. Identity without accounts

There is no login. A player is a display name plus a `deviceId` the browser generates once and keeps
in localStorage. That pair travels on the socket handshake and is what returns a seat after a reload
or a dropped connection.

A device id is an **identifier, not a credential**. It proves nothing and grants nothing beyond
"this is the same browser that was here a moment ago"; the only thing it can reclaim is a seat in a
room whose code its holder already had. Nothing stored is a secret, so there is no credential to
leak, no password to hash, and no session to revoke.

The trade is deliberate and has one real cost: clearing browser data means a new identity, and with
it the loss of any seat in a running game. For a pass-and-play-with-friends game that is the right
trade — a login screen would cost every player more than it protects.

Names are sanitised, never trusted:

- C0/C1 control characters, zero-width joiners and the BOM are stripped — they are used to fake
  duplicate names ("Sai" vs "Sai​") and to break layout.
- Whitespace is collapsed, then the result is clamped to 2–14 characters.
- The device id must match `[A-Za-z0-9_-]{16,64}`, so it cannot carry anything into a query.

---

## 9. Anti-cheat

Validation is not a layer that can be skipped — it is the only path. `game:roll` and `game:move`
both re-authenticate the socket, re-load state from the database, and call the same
`rules.legalMoves()` that the timeout auto-player uses. A hand-crafted packet takes exactly the code
path a legitimate click takes.

Rejections are recorded. Reasons that indicate a UI race (`NOT_YOUR_TURN`, `ALREADY_ROLLED`) log at
`info`; reasons that can only come from a crafted packet (`ILLEGAL_MOVE`, `NOT_IN_GAME`) log at
`warn` and raise the player's suspicion score in the admin panel.

---

## 10. Client rendering

The board is a 15×15 CSS grid in a square container. Token positions are percentages, so the entire
board scales to any width without recomputing a coordinate in JavaScript — one renderer serves a
phone in portrait and a desktop monitor.

Movement animation is CSS transitions on `left`/`top`. The animator sets a token's position one
square at a time and the browser interpolates; there is no render loop, and moving one token does
not re-render the board — only that token's style changes.

State is split into four stores (`auth`, `ui`, `room`, `game`) so a dice roll does not re-render the
friends list, and signing out tears down exactly one thing.

---

## 11. What runs where

| Concern | Server | Client |
|---|---|---|
| Dice generation | ✅ | never |
| Move legality | ✅ | never |
| Turn order & timer | ✅ | displays only |
| Captures, win, XP | ✅ | never |
| Board geometry | ✅ | ✅ *(same module)* |
| Animation, sound, layout | — | ✅ |

---

## 12. Scaling beyond one node

Two things are per-process today and are the whole of what stands between this and horizontal scale:

1. **Presence** (`presence.service.js`) is an in-memory `Map`. Swap for Redis, or use the Socket.IO
   Redis adapter and derive presence from adapter room membership.
2. **Rate limiting** is an in-memory `Map`. Swap the store for Redis; the middleware signature does
   not change.

The database already uses WAL and `BEGIN IMMEDIATE`, so the transaction guarantees hold across
processes. For serious concurrency, migrate SQLite → Postgres: the SQL is standard, and `db/index.js`
is the only module that would change.
