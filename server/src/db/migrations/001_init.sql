-- ============================================================================
-- 001_init — guest-only Ludo
--
-- There are no accounts. A player is a name plus a device id generated in the
-- browser and kept in localStorage; that pair is what holds a seat across a
-- refresh or a dropped connection. Nothing here stores a credential.
-- ============================================================================

CREATE TABLE players (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  avatar       INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_players_device ON players(device_id);

CREATE TABLE rooms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL,
  host_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status        TEXT    NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','in_game','closed')),
  max_players   INTEGER NOT NULL DEFAULT 4 CHECK (max_players BETWEEN 2 AND 4),
  settings_json TEXT    NOT NULL DEFAULT '{}',
  game_id       INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT
);
CREATE UNIQUE INDEX ux_rooms_code_open ON rooms(code) WHERE status <> 'closed';
CREATE INDEX ix_rooms_status ON rooms(status);

CREATE TABLE room_players (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id   INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seat      INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
  is_ready  INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT    NOT NULL DEFAULT (datetime('now')),
  left_at   TEXT
);
CREATE UNIQUE INDEX ux_room_seat ON room_players(room_id, seat) WHERE left_at IS NULL;
CREATE UNIQUE INDEX ux_room_player ON room_players(room_id, player_id) WHERE left_at IS NULL;

CREATE TABLE games (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id           INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  status            TEXT    NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','finished','cancelled')),
  player_count      INTEGER NOT NULL CHECK (player_count BETWEEN 2 AND 4),
  current_seat      INTEGER NOT NULL DEFAULT 0,
  turn_number       INTEGER NOT NULL DEFAULT 0,
  dice_value        INTEGER,
  dice_rolled       INTEGER NOT NULL DEFAULT 0,
  consecutive_sixes INTEGER NOT NULL DEFAULT 0,
  state_version     INTEGER NOT NULL DEFAULT 0,
  turn_started_at   TEXT,
  turn_deadline_at  TEXT,
  config_json       TEXT    NOT NULL DEFAULT '{}',
  winner_id         INTEGER REFERENCES players(id) ON DELETE SET NULL,
  started_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  ended_at          TEXT,
  duration_ms       INTEGER,
  end_reason        TEXT
);
CREATE INDEX ix_games_status ON games(status);
CREATE INDEX ix_games_room   ON games(room_id);

CREATE TABLE game_players (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seat            INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
  color           TEXT    NOT NULL CHECK (color IN ('RED','GREEN','YELLOW','BLUE')),
  connected       INTEGER NOT NULL DEFAULT 1,
  disconnected_at TEXT,
  left_at         TEXT,
  status          TEXT    NOT NULL DEFAULT 'playing'
                          CHECK (status IN ('playing','finished','left','timed_out')),
  finished_rank   INTEGER,
  tokens_finished INTEGER NOT NULL DEFAULT 0,
  captures        INTEGER NOT NULL DEFAULT 0,
  times_captured  INTEGER NOT NULL DEFAULT 0,
  sixes_rolled    INTEGER NOT NULL DEFAULT 0,
  moves_made      INTEGER NOT NULL DEFAULT 0,
  timeouts        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ux_gp_game_seat   ON game_players(game_id, seat);
CREATE UNIQUE INDEX ux_gp_game_player ON game_players(game_id, player_id);
CREATE INDEX ix_gp_player ON game_players(player_id);

-- Authoritative token positions. `progress` is the engine's canonical measure:
--   -1      in the yard
--   0..50   on the shared ring; ringIndex = (start[color] + progress) % 52
--   51..56  in the colour's home column
--   57      finished, on the centre
CREATE TABLE game_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seat        INTEGER NOT NULL,
  color       TEXT    NOT NULL CHECK (color IN ('RED','GREEN','YELLOW','BLUE')),
  token_index INTEGER NOT NULL CHECK (token_index BETWEEN 0 AND 3),
  progress    INTEGER NOT NULL DEFAULT -1,
  state       TEXT    NOT NULL DEFAULT 'HOME'
                      CHECK (state IN ('HOME','ACTIVE','SAFE','FINISHED'))
);
CREATE UNIQUE INDEX ux_tokens_game_seat_idx ON game_tokens(game_id, seat, token_index);
CREATE INDEX ix_tokens_game ON game_tokens(game_id);

-- Append-only log: powers reconnect catch-up.
CREATE TABLE game_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  state_version INTEGER NOT NULL,
  type          TEXT    NOT NULL,
  payload_json  TEXT    NOT NULL DEFAULT '{}',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_events_seq ON game_events(game_id, seq);
CREATE INDEX ix_events_game_version ON game_events(game_id, state_version);
