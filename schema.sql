CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE players
ADD COLUMN IF NOT EXISTS user_id INTEGER UNIQUE,
ADD COLUMN IF NOT EXISTS deckbuilding_link TEXT,
ADD COLUMN IF NOT EXISTS discord_contact TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'players_user_id_fkey'
      AND table_name = 'players'
  ) THEN
    ALTER TABLE players
    ADD CONSTRAINT players_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS decks (
  id SERIAL PRIMARY KEY,
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  deck_name TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'Commander',
  commander TEXT,
  deck_link TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE decks
ADD COLUMN IF NOT EXISTS deck_link TEXT;

CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  match_date TIMESTAMP NOT NULL DEFAULT NOW(),
  location TEXT,
  notes TEXT,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE matches
ADD COLUMN IF NOT EXISTS player_count INTEGER;

ALTER TABLE matches
DROP CONSTRAINT IF EXISTS matches_player_count_check;

ALTER TABLE matches
ADD CONSTRAINT matches_player_count_check CHECK (player_count IS NULL OR player_count > 1);

CREATE TABLE IF NOT EXISTS match_players (
  id SERIAL PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL,
  result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'draw')),
  UNIQUE (match_id, player_id)
);

ALTER TABLE match_players
ADD COLUMN IF NOT EXISTS player_num INTEGER;

ALTER TABLE match_players
DROP CONSTRAINT IF EXISTS match_players_player_num_check;

ALTER TABLE match_players
ADD CONSTRAINT match_players_player_num_check CHECK (player_num IS NULL OR player_num > 0);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_match_player_num
ON match_players(match_id, player_num)
WHERE player_num IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_players_user_id ON players(user_id);
CREATE INDEX IF NOT EXISTS idx_decks_player_id ON decks(player_id);
CREATE INDEX IF NOT EXISTS idx_matches_created_by_user_id ON matches(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_match_players_match_id ON match_players(match_id);
CREATE INDEX IF NOT EXISTS idx_match_players_player_id ON match_players(player_id);
CREATE INDEX IF NOT EXISTS idx_match_players_deck_id ON match_players(deck_id);