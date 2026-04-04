require("dotenv").config();

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-in-production";

if (!DATABASE_URL) {
  console.warn("Warning: DATABASE_URL is not set.");
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

const PUBLIC_DIR = path.join(__dirname, "public");

async function runStartupMigrations() {
  if (!pool) return;

  try {
    await pool.query(`
      ALTER TABLE decks
      ADD COLUMN IF NOT EXISTS deck_link TEXT;
    `);

    console.log("Startup migrations complete.");
  } catch (error) {
    console.error("Startup migration failed:", error);
  }
}

app.use(express.static(PUBLIC_DIR));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: "lax"
    }
  })
);

function requireDatabase(req, res, next) {
  if (!pool) {
    return res.status(500).send("DATABASE_URL is not set.");
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/sign.html?next=/profile.html");
  }
  next();
}

function publicFile(name) {
  return path.join(PUBLIC_DIR, name);
}

async function getPlayerByUserId(userId) {
  const result = await pool.query(
    `
    SELECT id, name, user_id, deckbuilding_link, discord_contact
    FROM players
    WHERE user_id = $1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

function isProfileComplete(player) {
  return !!(player && player.name && player.name.trim());
}

async function requirePlayerProfile(req, res, next) {
  try {
    const linkedPlayer = await getPlayerByUserId(req.session.user.id);

    if (!isProfileComplete(linkedPlayer)) {
      return res.redirect("/profile-setup.html");
    }

    req.player = linkedPlayer;
    next();
  } catch (error) {
    console.error("Error checking player profile:", error);
    res.status(500).send(error.message || "Failed to verify player profile.");
  }
}

function parsePositiveInteger(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

async function findOrCreateDeck({ playerId, deckName, format, commander, deckLink }) {
  const cleanDeckName = deckName && deckName.trim() ? deckName.trim() : null;
  const cleanCommander = commander && commander.trim() ? commander.trim() : null;
  const cleanFormat = format && format.trim() ? format.trim() : "Commander";
  const cleanDeckLink = deckLink && deckLink.trim() ? deckLink.trim() : null;

  if (!cleanDeckName && !cleanCommander) {
    return null;
  }

  const lookupName = cleanDeckName || cleanCommander;

  const existingDeck = await pool.query(
  `
  SELECT id
  FROM decks
  WHERE player_id = $1
    AND deck_name = $2
  `,
  [playerId, lookupName]
);
if (existingDeck.rows.length > 0) {
  const existing = existingDeck.rows[0];

  if (cleanDeckLink) {
    await pool.query(
      `
      UPDATE decks
      SET deck_link = $1,
          format = $2,
          commander = COALESCE($3, commander)
      WHERE id = $4
      `,
      [cleanDeckLink, cleanFormat, cleanCommander, existing.id]
    );
  }

  return existing.id;
}

  const newDeck = await pool.query(
    `
    INSERT INTO decks (player_id, deck_name, format, commander, deck_link)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [playerId, lookupName, cleanFormat, cleanCommander, cleanDeckLink]
  );

  return newDeck.rows[0].id;
}

app.get("/", (req, res) => {
  res.sendFile(publicFile("index.html"));
});

app.get("/test-db", requireDatabase, async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS now");
    res.json({
      success: true,
      now: result.rows[0].now
    });
  } catch (error) {
    console.error("DB test failed:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

app.get("/init-schema", requireDatabase, async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE players
      ADD COLUMN IF NOT EXISTS user_id INTEGER UNIQUE,
      ADD COLUMN IF NOT EXISTS deckbuilding_link TEXT,
      ADD COLUMN IF NOT EXISTS discord_contact TEXT;
    `);

    await pool.query(`
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
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS decks (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      deck_name TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'Commander',
      commander TEXT,
      deck_link TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE decks
      ADD COLUMN IF NOT EXISTS deck_link TEXT;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        match_date TIMESTAMP NOT NULL DEFAULT NOW(),
        location TEXT,
        notes TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    await pool.query(`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER;
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'matches_created_by_user_id_fkey'
            AND table_name = 'matches'
        ) THEN
          ALTER TABLE matches
          ADD CONSTRAINT matches_created_by_user_id_fkey
          FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await pool.query(`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS player_count INTEGER;
    `);

    await pool.query(`
      ALTER TABLE matches
      DROP CONSTRAINT IF EXISTS matches_player_count_check;
    `);

    await pool.query(`
      ALTER TABLE matches
      ADD CONSTRAINT matches_player_count_check CHECK (player_count IS NULL OR player_count > 1);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_players (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL,
        result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'draw')),
        UNIQUE (match_id, player_id)
      );
    `);

    await pool.query(`
      ALTER TABLE match_players
      ADD COLUMN IF NOT EXISTS player_num INTEGER;
    `);

    await pool.query(`
      ALTER TABLE match_players
      DROP CONSTRAINT IF EXISTS match_players_player_num_check;
    `);

    await pool.query(`
      ALTER TABLE match_players
      ADD CONSTRAINT match_players_player_num_check CHECK (player_num IS NULL OR player_num > 0);
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_match_player_num
      ON match_players(match_id, player_num)
      WHERE player_num IS NOT NULL;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_players_user_id ON players(user_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_decks_player_id ON decks(player_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_matches_created_by_user_id ON matches(created_by_user_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_players_match_id ON match_players(match_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_players_player_id ON match_players(player_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_players_deck_id ON match_players(deck_id);
    `);

    res.send("Schema initialized successfully.");
  } catch (error) {
    console.error("Schema init failed:", error);
    res.status(500).send(error.message || "Schema init failed.");
  }
});

app.get("/health/schema", requireDatabase, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users', 'players', 'decks', 'matches', 'match_players')
      ORDER BY 
        CASE 
          WHEN (wins + losses) = 0 THEN 0
          ELSE (wins::float / (wins + losses))
        END DESC
    `);

    res.json({
      success: true,
      tables: result.rows.map((row) => row.table_name)
    });
  } catch (error) {
    console.error("Schema health check failed:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

app.post("/register", requireDatabase, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).send("Username and password are required.");
    }

    const cleanUsername = username.trim();

    if (!cleanUsername) {
      return res.status(400).send("Username cannot be empty.");
    }

    if (password.length < 6) {
      return res.status(400).send("Password must be at least 6 characters.");
    }

    const existingUser = await pool.query(
      `
      SELECT id
      FROM users
      WHERE username = $1
      `,
      [cleanUsername]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).send("That username is already taken.");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const newUser = await pool.query(
      `
      INSERT INTO users (username, password_hash, role)
      VALUES ($1, $2, 'player')
      RETURNING id, username, role
      `,
      [cleanUsername, passwordHash]
    );

    req.session.user = {
      id: newUser.rows[0].id,
      username: newUser.rows[0].username,
      role: newUser.rows[0].role
    };

    return res.redirect("/profile-setup.html");
  } catch (error) {
    console.error("Error registering user:", error);
    res.status(500).send(error.message || "Registration failed.");
  }
});

app.post("/login", requireDatabase, async (req, res) => {
  try {
    const { user, pass, next } = req.body;

    if (!user || !pass) {
      return res.status(400).send("Username and password are required.");
    }

    const result = await pool.query(
      `
      SELECT id, username, password_hash, role
      FROM users
      WHERE username = $1
      `,
      [user.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).send("Invalid username or password.");
    }

    const dbUser = result.rows[0];
    const passwordMatches = await bcrypt.compare(pass, dbUser.password_hash);

    if (!passwordMatches) {
      return res.status(401).send("Invalid username or password.");
    }

    req.session.user = {
      id: dbUser.id,
      username: dbUser.username,
      role: dbUser.role
    };

    const linkedPlayer = await getPlayerByUserId(dbUser.id);

    if (!isProfileComplete(linkedPlayer)) {
      return res.redirect("/profile-setup.html");
    }

    if (next && next.trim()) {
      return res.redirect(next.trim());
    }

    return res.redirect("/add_game.html");
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).send(error.message || "Login failed.");
  }
});

app.get("/profile-setup.html", requireDatabase, requireLogin, async (req, res) => {
  try {
    const linkedPlayer = await getPlayerByUserId(req.session.user.id);

    if (isProfileComplete(linkedPlayer)) {
      return res.redirect("/add_game.html");
    }

    res.sendFile(publicFile("profile_setup.html"));
  } catch (error) {
    console.error("Error loading profile setup page:", error);
    res.status(500).send(error.message || "Failed to load profile setup page.");
  }
});

app.post("/profile-setup", requireDatabase, requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { player_name, deckbuilding_link, discord_contact } = req.body;

    if (!player_name || !player_name.trim()) {
      return res.status(400).send("Player name is required.");
    }

    const cleanPlayerName = player_name.trim();
    const cleanDeckLink = deckbuilding_link && deckbuilding_link.trim() ? deckbuilding_link.trim() : null;
    const cleanDiscord = discord_contact && discord_contact.trim() ? discord_contact.trim() : null;

    const existingLinkedPlayer = await getPlayerByUserId(userId);

    const duplicateName = await pool.query(
      `
      SELECT id
      FROM players
      WHERE name = $1
        AND (user_id IS NULL OR user_id <> $2)
      `,
      [cleanPlayerName, userId]
    );

    if (duplicateName.rows.length > 0) {
      return res.status(409).send("That player name is already in use.");
    }

    if (existingLinkedPlayer) {
      await pool.query(
        `
        UPDATE players
        SET name = $1,
            deckbuilding_link = $2,
            discord_contact = $3
        WHERE user_id = $4
        `,
        [cleanPlayerName, cleanDeckLink, cleanDiscord, userId]
      );
    } else {
      await pool.query(
        `
        INSERT INTO players (name, user_id, deckbuilding_link, discord_contact)
        VALUES ($1, $2, $3, $4)
        `,
        [cleanPlayerName, userId, cleanDeckLink, cleanDiscord]
      );
    }

    return res.redirect("/add_game.html");
  } catch (error) {
    console.error("Error creating/updating player profile:", error);
    res.status(500).send(error.message || "Profile setup failed.");
  }
});

app.get("/add_game.html", requireDatabase, requireLogin, requirePlayerProfile, (req, res) => {
  res.sendFile(publicFile("add_game.html"));
});

app.get("/join_game.html", requireDatabase, requireLogin, requirePlayerProfile, (req, res) => {
  res.sendFile(publicFile("join_game.html"));
});

app.post("/add-game", requireDatabase, requireLogin, requirePlayerProfile, async (req, res) => {
  try {
    const { location, notes, result, deck_name, deck_link, format, commander, player_count, player_num } = req.body;

    if (!deck_name?.trim() && !commander?.trim()) {
      return res.status(400).send("Please enter a Deck Name or Commander.");
    }

    if (!result || !["win", "loss", "draw"].includes(result)) {
      return res.status(400).send("A valid result is required.");
    }

    const cleanPlayerCount = parsePositiveInteger(player_count);
    const cleanPlayerNum = parsePositiveInteger(player_num);

    if (!cleanPlayerCount || cleanPlayerCount < 2) {
      return res.status(400).send("A valid player count of at least 2 is required.");
    }

    if (!cleanPlayerNum || cleanPlayerNum > cleanPlayerCount) {
      return res.status(400).send("A valid player number is required.");
    }

    const deckId = await findOrCreateDeck({
      playerId: req.player.id,
      deckName: deck_name,
      format,
      commander,
      deckLink: deck_link
    });

    const matchInsert = await pool.query(
      `
      INSERT INTO matches (location, notes, created_by_user_id, player_count)
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [
        location && location.trim() ? location.trim() : null,
        notes && notes.trim() ? notes.trim() : null,
        req.session.user.id,
        cleanPlayerCount
      ]
    );

    const matchId = matchInsert.rows[0].id;

    await pool.query(
      `
      INSERT INTO match_players (match_id, player_id, deck_id, result, player_num)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [matchId, req.player.id, deckId, result, cleanPlayerNum]
    );

    res.redirect(`/join_game.html?match_id=${matchId}`);
  } catch (error) {
    console.error("Error adding game:", error);
    res.status(500).send(error.message || "Failed to add game.");
  }
});

app.post("/join-game", requireDatabase, requireLogin, requirePlayerProfile, async (req, res) => {
  try {
    const { match_id, player_num, result, deck_name, deck_link, format, commander } = req.body;

    if (!deck_name?.trim() && !commander?.trim()) {
      return res.status(400).send("Please enter a Deck Name or Commander.");
    }

    if (!result || !["win", "loss", "draw"].includes(result)) {
      return res.status(400).send("A valid result is required.");
    }

    const cleanMatchId = parsePositiveInteger(match_id);
    const cleanPlayerNum = parsePositiveInteger(player_num);

    if (!cleanMatchId) {
      return res.status(400).send("A valid game ID is required.");
    }

    const matchResult = await pool.query(
      `
      SELECT id, player_count
      FROM matches
      WHERE id = $1
      `,
      [cleanMatchId]
    );

    if (matchResult.rows.length === 0) {
      return res.status(404).send("Game not found.");
    }

    const match = matchResult.rows[0];

    if (!cleanPlayerNum || cleanPlayerNum > match.player_count) {
      return res.status(400).send("That player number is not valid for this game.");
    }

    const alreadyJoined = await pool.query(
      `
      SELECT id
      FROM match_players
      WHERE match_id = $1
        AND player_id = $2
      `,
      [cleanMatchId, req.player.id]
    );

    if (alreadyJoined.rows.length > 0) {
      return res.status(409).send("You have already joined this game.");
    }

    const seatTaken = await pool.query(
      `
      SELECT id
      FROM match_players
      WHERE match_id = $1
        AND player_num = $2
      `,
      [cleanMatchId, cleanPlayerNum]
    );

    if (seatTaken.rows.length > 0) {
      return res.status(409).send("That player number has already been chosen.");
    }

    const joinedCountResult = await pool.query(
      `
      SELECT COUNT(*)::INT AS joined_count
      FROM match_players
      WHERE match_id = $1
      `,
      [cleanMatchId]
    );

    if (joinedCountResult.rows[0].joined_count >= match.player_count) {
      return res.status(409).send("This game is already full.");
    }

    const deckId = await findOrCreateDeck({
      playerId: req.player.id,
      deckName: deck_name,
      format,
      commander,
      deckLink: deck_link
    });

    await pool.query(
      `
      INSERT INTO match_players (match_id, player_id, deck_id, result, player_num)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [cleanMatchId, req.player.id, deckId, result, cleanPlayerNum]
    );

    res.redirect(`/join_game.html?match_id=${cleanMatchId}`);
  } catch (error) {
    console.error("Error joining game:", error);

    if (error.code === "23505") {
      return res.status(409).send("That player number has already been chosen.");
    }

    res.status(500).send(error.message || "Failed to join game.");
  }
});

app.get("/api/matches/:id/open-seats", requireDatabase, requireLogin, async (req, res) => {
  try {
    const matchId = parsePositiveInteger(req.params.id);

    if (!matchId) {
      return res.status(400).json({ success: false, error: "Invalid game ID." });
    }

    const matchResult = await pool.query(
      `
      SELECT id, match_date, location, notes, player_count, created_by_user_id
      FROM matches
      WHERE id = $1
      `,
      [matchId]
    );

    if (matchResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Game not found." });
    }

    const takenResult = await pool.query(
      `
      SELECT mp.player_num, p.name AS player_name
      FROM match_players mp
      JOIN players p ON p.id = mp.player_id
      WHERE mp.match_id = $1
      ORDER BY mp.player_num ASC
      `,
      [matchId]
    );

    const match = matchResult.rows[0];
    const takenSeats = takenResult.rows;
    const openSeats = [];
    const takenSeatNumbers = takenSeats.map((row) => row.player_num);

    for (let seat = 1; seat <= match.player_count; seat++) {
      if (!takenSeatNumbers.includes(seat)) {
        openSeats.push(seat);
      }
    }

    res.json({
      success: true,
      match: {
        id: match.id,
        match_date: match.match_date,
        location: match.location,
        notes: match.notes,
        player_count: match.player_count,
        created_by_user_id: match.created_by_user_id
      },
      taken_seats: takenSeats,
      open_seats: openSeats,
      joined_count: takenSeats.length
    });
  } catch (error) {
    console.error("Error fetching open seats:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

app.get("/api/my-games", requireDatabase, requireLogin, async (req, res) => {
  try {
    const { day, location, deck_name, player_count } = req.query;

    const conditions = [`m.created_by_user_id = $1`];
    const values = [req.session.user.id];
    let paramIndex = 2;

    if (day && day.trim()) {
      conditions.push(`DATE(m.match_date) = $${paramIndex}`);
      values.push(day.trim());
      paramIndex++;
    }

    if (location && location.trim()) {
      conditions.push(`LOWER(COALESCE(m.location, '')) LIKE LOWER($${paramIndex})`);
      values.push(`%${location.trim()}%`);
      paramIndex++;
    }

    if (deck_name && deck_name.trim()) {
      conditions.push(`
        EXISTS (
          SELECT 1
          FROM match_players mp2
          LEFT JOIN decks d2 ON d2.id = mp2.deck_id
          WHERE mp2.match_id = m.id
            AND LOWER(COALESCE(d2.deck_name, '')) LIKE LOWER($${paramIndex})
        )
      `);
      values.push(`%${deck_name.trim()}%`);
      paramIndex++;
    }

    if (player_count && !Number.isNaN(Number(player_count))) {
      conditions.push(`m.player_count = $${paramIndex}`);
      values.push(Number(player_count));
      paramIndex++;
    }

    const query = `
      SELECT
        m.id,
        m.match_date,
        m.location,
        m.notes,
        m.player_count,
        COUNT(mp.id) AS joined_count,
        STRING_AGG(DISTINCT p.name, ', ' ORDER BY p.name) AS players,
        STRING_AGG(DISTINCT d.deck_name, ', ' ORDER BY d.deck_name) AS deck_names
      FROM matches m
      LEFT JOIN match_players mp ON mp.match_id = m.id
      LEFT JOIN players p ON p.id = mp.player_id
      LEFT JOIN decks d ON d.id = mp.deck_id
      WHERE ${conditions.join(" AND ")}
      GROUP BY m.id, m.match_date, m.location, m.notes, m.player_count
      ORDER BY m.match_date DESC, m.id DESC
    `;

    const result = await pool.query(query, values);

    res.json({
      success: true,
      games: result.rows
    });
  } catch (error) {
    console.error("Error fetching user games:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

app.get("/api/players", requireDatabase, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.user_id,
        p.deckbuilding_link,
        p.discord_contact,
        p.created_at,
        COUNT(mp.id) AS total_games,
        COUNT(*) FILTER (WHERE mp.result = 'win') AS wins,
        COUNT(*) FILTER (WHERE mp.result = 'loss') AS losses,
        COUNT(*) FILTER (WHERE mp.result = 'draw') AS draws,
        CASE
          WHEN COUNT(mp.id) = 0 THEN 0
          ELSE ROUND((COUNT(*) FILTER (WHERE mp.result = 'win')::numeric / COUNT(mp.id)::numeric) * 100, 2)
        END AS win_rate,
        CASE
          WHEN COUNT(mp.id) = 0 THEN 0
          ELSE ROUND((COUNT(*) FILTER (WHERE mp.result = 'loss')::numeric / COUNT(mp.id)::numeric) * 100, 2)
        END AS loss_rate
      FROM players p
      LEFT JOIN match_players mp ON mp.player_id = p.id
      GROUP BY
        p.id,
        p.name,
        p.user_id,
        p.deckbuilding_link,
        p.discord_contact,
        p.created_at
      ORDER BY
        wins DESC,
        total_games DESC,
        p.name ASC
    `);

    res.json({
      success: true,
      players: result.rows
    });
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

app.get("/api/me", requireDatabase, async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({
        success: false,
        error: "Not logged in"
      });
    }

    const userId = req.session.user.id;

    const result = await pool.query(
      `
      SELECT
        u.id AS user_id,
        u.username,
        u.role,
        p.id AS player_id,
        p.name AS player_name,
        p.deckbuilding_link,
        p.discord_contact
      FROM users u
      LEFT JOIN players p ON p.user_id = u.id
      WHERE u.id = $1
      `,
      [userId]
    );

    res.json({
      success: true,
      user: result.rows[0] || null
    });
  } catch (error) {
    console.error("Error fetching current user:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Error destroying session:", error);
      return res.status(500).send(error.message || "Logout failed.");
    }

    res.redirect("/");
  });
});

app.use((req, res) => {
  res.status(404).send("Page not found.");
});

async function startServer() {
  await runStartupMigrations();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();