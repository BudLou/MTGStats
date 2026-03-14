require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
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

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const SCHEMA_PATH = path.join(ROOT_DIR, "schema.sql");

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
    return res.redirect("/sign.html");
  }
  next();
}

function publicFile(name) {
  return path.join(PUBLIC_DIR, name);
}

async function getPlayerByUserId(userId) {
  const result = await pool.query(
    `
    SELECT id, name, user_id
    FROM players
    WHERE user_id = $1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

async function requirePlayerProfile(req, res, next) {
  try {
    const linkedPlayer = await getPlayerByUserId(req.session.user.id);

    if (!linkedPlayer) {
      return res.redirect("/profile-setup.html");
    }

    req.player = linkedPlayer;
    next();
  } catch (error) {
    console.error("Error checking player profile:", error);
    res.status(500).send(error.message || "Failed to verify player profile.");
  }
}

async function ensureSchema() {
  if (!pool) {
    throw new Error("DATABASE_URL is not set.");
  }

  const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf8");
  await pool.query(schemaSql);
  console.log("Schema ensured.");
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

app.get("/health/schema", requireDatabase, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users', 'players', 'decks', 'matches', 'match_players')
      ORDER BY table_name
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

    await pool.query(
      `
      INSERT INTO users (username, password_hash, role)
      VALUES ($1, $2, 'player')
      `,
      [cleanUsername, passwordHash]
    );

    res.redirect("/sign.html");
  } catch (error) {
    console.error("Error registering user:", error);
    res.status(500).send(error.message || "Registration failed.");
  }
});

app.post("/login", requireDatabase, async (req, res) => {
  try {
    const { user, pass } = req.body;

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

    if (!linkedPlayer) {
      return res.redirect("/profile-setup.html");
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

    if (linkedPlayer) {
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
    const { player_name } = req.body;

    if (!player_name || !player_name.trim()) {
      return res.status(400).send("Player name is required.");
    }

    const existingLinkedPlayer = await getPlayerByUserId(userId);

    if (existingLinkedPlayer) {
      return res.redirect("/add_game.html");
    }

    const cleanPlayerName = player_name.trim();

    const existingName = await pool.query(
      `
      SELECT id
      FROM players
      WHERE name = $1
      `,
      [cleanPlayerName]
    );

    if (existingName.rows.length > 0) {
      return res.status(409).send("That player name is already in use.");
    }

    await pool.query(
      `
      INSERT INTO players (name, user_id)
      VALUES ($1, $2)
      `,
      [cleanPlayerName, userId]
    );

    return res.redirect("/add_game.html");
  } catch (error) {
    console.error("Error creating player profile:", error);
    res.status(500).send(error.message || "Profile setup failed.");
  }
});

app.get("/add_game.html", requireDatabase, requireLogin, requirePlayerProfile, (req, res) => {
  res.sendFile(publicFile("add_game.html"));
});

app.post("/add_game", requireDatabase, requireLogin, requirePlayerProfile, async (req, res) => {
  try {
    const { location, notes, result, deck_id } = req.body;

    if (!result || !["win", "loss", "draw"].includes(result)) {
      return res.status(400).send("A valid result is required.");
    }

    const matchInsert = await pool.query(
      `
      INSERT INTO matches (location, notes, created_by_user_id)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      [location || null, notes || null, req.session.user.id]
    );

    const matchId = matchInsert.rows[0].id;

    let safeDeckId = null;

    if (deck_id) {
      const deckCheck = await pool.query(
        `
        SELECT id
        FROM decks
        WHERE id = $1
        `,
        [deck_id]
      );

      if (deckCheck.rows.length > 0) {
        safeDeckId = deck_id;
      }
    }

    await pool.query(
      `
      INSERT INTO match_players (match_id, player_id, deck_id, result)
      VALUES ($1, $2, $3, $4)
      `,
      [matchId, req.player.id, safeDeckId, result]
    );

    res.redirect("/add_game.html");
  } catch (error) {
    console.error("Error adding game:", error);
    res.status(500).send(error.message || "Failed to add game.");
  }
});

app.get("/api/players", requireDatabase, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, name, created_at, user_id
      FROM players
      ORDER BY name ASC
      `
    );

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
        p.name AS player_name
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

    res.redirect("/sign.html");
  });
});

app.use((req, res) => {
  res.status(404).send("Page not found.");
});

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Server startup failed:", error);
    process.exit(1);
  });