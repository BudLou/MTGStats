INSERT INTO decks (
    id,
    player_id,
    deck_name,
    format,
    commander,
    created_at
  )
VALUES (
    id:integer,
    player_id:integer,
    'deck_name:text',
    'format:text',
    'commander:text',
    'created_at:timestamp without time zone'
  );CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS decks (
  id SERIAL PRIMARY KEY,
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  deck_name TEXT NOT NULL,
  format TEXT DEFAULT 'Commander',
  commander TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  match_date TIMESTAMP DEFAULT NOW(),
  location TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS match_players (
  id SERIAL PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL,
  result TEXT CHECK (result IN ('win','loss','draw')) NOT NULL,
  UNIQUE(match_id, player_id)
);

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
