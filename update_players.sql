ALTER TABLE players
ADD COLUMN IF NOT EXISTS user_id INTEGER UNIQUE
REFERENCES users(id) ON DELETE SET NULL;

SELECT column_name
FROM information_schema.columns
WHERE table_name = 'players'
ORDER BY ordinal_position;