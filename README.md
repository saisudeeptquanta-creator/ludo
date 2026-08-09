# Ludo — Play with Friends

A fullscreen mobile Ludo game. Type a name, create or join a room, play.
**No accounts, no sign-up, no landing page.**

---

## Run it

```bash
npm install
npm run build     # build the client
npm start         # one server, one port, serves everything
```

Open **http://localhost:4000**.

For development with hot reload:

```bash
npm run dev       # server :4000 + client :5173
```

### Play on your phone

`npm run dev` prints a **Network** URL (e.g. `http://192.168.1.x:5173`). Open that on any phone on
the same Wi-Fi. The server accepts local network origins in development, so it works with no config.

For the best experience, use your browser's **Add to Home Screen**. It launches fullscreen with no
browser chrome, locked to portrait.

---

## How it works

```
HOME              LOBBY               GAME
──────────        ─────────────       ──────────────
enter name   →    share room code  →  roll · move · capture
create/join       everyone readies    first player home wins
                  host starts
```

Two to four players. One shares the 5-character room code; everyone else types it in.

### Identity without accounts

Your browser generates a random **device ID** on first load and keeps it in `localStorage`. Your
name plus that ID is your identity.

That is what makes reconnection work: lock your phone, lose signal, or reload the page mid-game and
you drop straight back into your seat with the board untouched. The server holds your seat for 90
seconds.

A device ID is an identifier, not a credential — it proves nothing and can only reclaim a seat in a
room whose code its holder already had. Clearing browser data means a new identity.

---

## The rules

- Roll a **6** to release a token from your yard.
- **Extra turn** on a six, on a capture, and on getting a token home — each configurable per room.
- **Three sixes in a row** forfeits the turn and voids the roll.
- **Capture** by landing on an opponent; their token goes back to its yard.
- **Eight safe squares** — the four coloured entry squares plus four stars — where nobody can be
  captured.
- **Exact roll required** to land on the centre; overshooting is not a legal move.
- **Stacking** and **blocking** are configurable by the host.
- All four tokens home wins. Remaining players keep playing for 2nd, 3rd and 4th.

---

## Architecture

**The server is the only authority.** Clients send intents (`game:roll`, `game:move`); the server
validates against a pure rule engine, mutates state inside a database transaction, and broadcasts
the result. Dice come from `crypto.randomInt` on the server.

A client cannot choose a dice value, move another player's token, act out of turn, or declare a
winner — each has a test that tries and asserts failure.

| Layer | Choice | Why |
|---|---|---|
| Server | Node 22+, Express, Socket.IO | Authoritative loop beside the socket hub |
| Database | `node:sqlite` (built in), WAL | Real transactions, no native build step |
| Engine | Pure functions, no I/O | Same code validates and is unit-tested |
| Client | React + Vite + Zustand | One screen at a time, no router |
| Board | Inline SVG on a 15×15 viewBox | Crisp at any size; no image assets |
| Audio | Web Audio synthesis | No sound files to ship or 404 |

The board geometry module is imported by the client **directly from the server's engine**, so the
square a token is drawn on is by construction the square the rules validated against.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full design.

---

## Testing

```bash
npm test
```

**77 tests, no mocks:**

- **Board geometry (17)** — the 52-square ring is contiguous, the cross tiles to exactly 81 squares,
  entry squares sit 13 apart, home columns reach the centre.
- **Engine (40)** — releasing, capturing, safe squares, extra turns, three-sixes forfeit, exact
  finish, win detection, timeouts, disconnects, plus a **fuzz test playing 25 complete random
  4-player games**.
- **Multiplayer (20)** — real HTTP + Socket.IO driven by real socket clients: identity without
  accounts, reconnect-by-device-id, lobby sync, host-only start, server-authoritative dice,
  turn ownership, concurrent duplicate rolls, turn-clock advancement, and **a full 2-player game
  played to a winner over sockets**.

---

## Mobile details

- **Fullscreen**: PWA manifest with `display: fullscreen`, plus a runtime toggle where the
  Fullscreen API is available.
- **Viewport**: `100vh` is wrong on mobile — it includes browser chrome that later slides away. The
  real height is measured from `visualViewport` and published as `--app-height`.
- **No scrolling or zoom**: pinch-zoom, double-tap zoom and rubber-band overscroll are suppressed;
  panels that genuinely scroll opt in with `data-scroll`.
- **Safe areas**: `viewport-fit=cover` plus `env(safe-area-inset-*)` so nothing hides under a notch.
- **Wake lock**: the screen stays awake during a game where supported.
- **Layout**: a fixed grid — seats, board, dice — so the board never scrolls off and the dice stays
  under your thumb. Landscape moves the board beside the controls.

---

## Configuration

Every rule and timeout lives in `server/src/config/index.js`.

```bash
PORT=4000
TURN_DURATION_MS=25000      # per-turn clock
RECONNECT_GRACE_MS=90000    # how long a seat is held after a drop
CORS_ORIGINS=http://localhost:5173
```

In development any localhost or private LAN origin is accepted on any port, so phone testing and
Vite's port hopping both work without config. In production only `CORS_ORIGINS` is allowed.

---

## Known gaps

Stated plainly rather than faked:

- **Presence and rate limiting are in-memory**, so single-node. Multiple nodes need the Socket.IO
  Redis adapter and a shared limiter store.
- **Clearing browser data loses your identity**, and with it any seat in a running game. That is the
  cost of having no accounts.
- **No browser-level end-to-end test.** Coverage stops at the socket API, which is where the rules
  live; the React layer is verified by build and manual play.
