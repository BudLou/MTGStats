-- Drop old tables only if you want a full reset.
-- Uncomment in development only.
-- DROP TABLE IF EXISTS match_players CASCADE;
-- DROP TABLE IF EXISTS matches CASCADE;
-- DROP TABLE IF EXISTS decks CASCADE;
-- DROP TABLE IF EXISTS players CASCADE;
-- DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS decks (
  id SERIAL PRIMARY KEY,
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  deck_name TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'Commander',
  commander TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  match_date TIMESTAMP NOT NULL DEFAULT NOW(),
  location TEXT,
  notes TEXT,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS match_players (
  id SERIAL PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL,
  result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'draw')),
  UNIQUE (match_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_players_user_id ON players(user_id);
CREATE INDEX IF NOT EXISTS idx_decks_player_id ON decks(player_id);
CREATE INDEX IF NOT EXISTS idx_matches_created_by_user_id ON matches(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_match_players_match_id ON match_players(match_id);
CREATE INDEX IF NOT EXISTS idx_match_players_player_id ON match_players(player_id);
CREATE INDEX IF NOT EXISTS idx_match_players_deck_id ON match_players(deck_id);