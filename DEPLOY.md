# Deploying Ludo

The whole game is **one process on one port**: the server serves the API, the
WebSocket and the built client. There is nothing else to host.

Everything below has been verified by running the production build locally and
playing a full two-player game through it in real browsers.

---

## Before you start

You need a host that gives you:

- **A persistent disk** — the database is a SQLite file. Without a disk, rooms
  and finished games vanish on every redeploy.
- **WebSocket support** — the game is entirely real-time. Any host that only
  proxies plain HTTP will not work.
- **Always-on instances** — a sleeping container drops live games. Avoid
  scale-to-zero.

`render.yaml` and `fly.toml` in this repo already encode all three.

---

## Option A — Render (simplest)

1. Push this repo to GitHub:

   ```bash
   git remote add origin https://github.com/<you>/ludo.git
   git branch -M main
   git push -u origin main
   ```

2. In Render: **New +** → **Blueprint** → pick the repo.
   `render.yaml` is detected and applied, including the 1 GB disk mounted at
   `/data`.

3. Deploy. Your URL is `https://<name>.onrender.com`.

> The blueprint uses the `starter` plan because **a persistent disk requires a
> paid instance**. On the free tier, remove the `disk:` block — the game still
> works, but the database resets whenever the instance restarts.

---

## Option B — Fly.io

```bash
fly launch --no-deploy          # edit `app` in fly.toml to a unique name first
fly volumes create ludo_data --size 1
fly deploy
```

`min_machines_running = 1` keeps a machine awake so live games are not dropped.

---

## Option C — Any Docker host (VPS, Coolify, Dokploy, Cloud Run…)

```bash
docker build -t ludo .
docker volume create ludo-data
docker run -d --name ludo -p 80:4000 \
  -v ludo-data:/data \
  -e NODE_ENV=production \
  ludo
```

The image runs as a non-root user and has a built-in health check on
`/api/health`.

---

## Environment variables

Only `NODE_ENV` and `DB_FILE` really matter; the rest have sensible defaults.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | **Set to `production`.** |
| `PORT` | `4000` | Most hosts inject this automatically. |
| `DB_FILE` | `./data/ludo.db` | **Point at your mounted disk**, e.g. `/data/ludo.db`. |
| `TURN_DURATION_MS` | `25000` | Per-turn clock. |
| `RECONNECT_GRACE_MS` | `90000` | How long a seat is held after a drop. |
| `CORS_ORIGINS` | *(empty in production)* | Only needed if you host the client on a **different** domain. |
| `TRUST_PROXY` | on in production | Required behind a proxy so rate limiting sees real client IPs. |

### About `CORS_ORIGINS`

You normally leave this unset. In production the server serves its own client,
so requests are same-origin and are allowed by matching `Origin` against the
request's own `Host`. Set it only when the client is deployed separately.

---

## Verify a deployment

```bash
curl https://<your-url>/api/health
# {"ok":true,"uptimeSec":12,"online":0}
```

Then open the URL on two phones, create a room on one, join with the code on the
other, and play. That exercises the API, the WebSocket, the database and the
static client in one go.

---

## Two production-only bugs this setup fixes

Both were found by running the built app the way a host runs it, and both are
now covered by tests:

1. **Blank page.** CORS was applied globally, so it also gated the app's own
   JS and CSS. Browsers send an `Origin` header for subresources, and the
   production allow list is empty — every asset returned 403. CORS is now
   scoped to `/api` only.

2. **Game never came online.** Browsers also send `Origin` on same-origin
   WebSocket upgrades, so the deployment rejected its own socket with a 400.
   Origin is now resolved against the request's `Host`.

---

## Scaling

The design is single-node on purpose. Two things are in-memory and would need
changing before running more than one instance:

- **Presence** (`presence.service.js`) — swap for Redis, or derive it from the
  Socket.IO Redis adapter.
- **Rate limiting** — swap the `Map` for a shared store.

The database would also need moving from SQLite to Postgres. `db/index.js` is
the only module that touches SQL directly, and the queries are standard.

For a game played by friends in private rooms, one instance is plenty — a
$7/month container comfortably handles hundreds of concurrent players.
