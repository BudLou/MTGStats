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
    res.status(500).send("Failed to verify player profile.");
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
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
    res.status(500).send("Registration failed.");
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

    return res.redirect("/add-game.html");
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).send("Login failed.");
  }
});

app.get("/profile-setup.html", requireDatabase, requireLogin, async (req, res) => {
  try {
    const linkedPlayer = await getPlayerByUserId(req.session.user.id);

    if (linkedPlayer) {
      return res.redirect("/add-game.html");
    }

    res.sendFile(path.join(PUBLIC_DIR, "profile_setup.html"));
  } catch (error) {
    console.error("Error loading profile setup page:", error);
    res.status(500).send("Failed to load profile setup page.");
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
      return res.redirect("/add-game.html");
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

    return res.redirect("/add-game.html");
  } catch (error) {
    console.error("Error creating player profile:", error);
    res.status(500).send("Profile setup failed.");
  }
});

app.get("/add-game.html", requireDatabase, requireLogin, requirePlayerProfile, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "add-game.html"));
});

app.post("/add-game", requireDatabase, requireLogin, requirePlayerProfile, async (req, res) => {
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

    res.redirect("/add-game.html");
  } catch (error) {
    console.error("Error adding game:", error);
    res.status(500).send("Failed to add game.");
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
      return res.status(500).send("Logout failed.");
    }

    res.redirect("/sign.html");
  });
});

app.use((req, res) => {
  res.status(404).send("Page not found.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});