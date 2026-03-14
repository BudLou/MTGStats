require("dotenv").config();

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false }
    })
  : null;

console.log("DATABASE_URL loaded:", !!databaseUrl);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: "mtg-stats-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  })
);

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/sign.html");
  }
  next();
}

app.get("profile-setup.html", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile-setup.html"));
});

app.post("/profile-setup", requireLogin, async (req, res) => {
  // save linked player data
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/test-db", async (req, res) => {
  try {
    if (!pool) {
      throw new Error("DATABASE_URL is not set");
    }

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

app.get("/api/players", async (req, res) => {
  try {
    if (!pool) {
      throw new Error("DATABASE_URL is not set");
    }

    const result = await pool.query(
      "SELECT id, name, created_at, user_id FROM players ORDER BY name ASC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

app.post("/register", async (req, res) => {
  try {
    if (!pool) {
      throw new Error("DATABASE_URL is not set");
    }

    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).send("Username and password are required.");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(
      `
      INSERT INTO users (username, password_hash, role)
      VALUES ($1, $2, $3)
      `,
      [username, passwordHash, role || "player"]
    );

    res.redirect("sign.html");
  } catch (error) {
    console.error("Error registering user:", error);
    res.status(500).send(error.message || "Registration failed");
  }
});

app.post("/login", async (req, res) => {
  try {
    if (!pool) {
      throw new Error("DATABASE_URL is not set");
    }

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
      [user]
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

    const playerResult = await pool.query(
      `
      SELECT id, name
      FROM players
      WHERE user_id = $1
      `,
      [dbUser.id]
    );

    if (playerResult.rows.length === 0) {
      return res.redirect("profile-setup.html");
    }

    if (dbUser.role === "admin") {
      return res.redirect("leaderboard.html");
    }

    return res.redirect("players.html");
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).send(error.message || "Login failed");
  }
});

app.get("/api/me", async (req, res) => {
  try {
    if (!pool) {
      throw new Error("DATABASE_URL is not set");
    }

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
      user: result.rows[0]
    });
  } catch (error) {
    console.error("Error fetching current user:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

app.post("/profile-setup", async (req, res) => {
  try {
    if (!pool) {
      throw new Error("DATABASE_URL is not set");
    }

    if (!req.session.user) {
      return res.status(401).send("You must be logged in.");
    }

    const userId = req.session.user.id;
    const { player_name } = req.body;

    if (!player_name) {
      return res.status(400).send("Player name is required.");
    }

    const existingPlayer = await pool.query(
      `
      SELECT id
      FROM players
      WHERE user_id = $1
      `,
      [userId]
    );

    if (existingPlayer.rows.length > 0) {
      return res.redirect("players.html");
    }

    await pool.query(
      `
      INSERT INTO players (name, user_id)
      VALUES ($1, $2)
      `,
      [player_name, userId]
    );

    res.redirect("players.html");
  } catch (error) {
    console.error("Error creating player profile:", error);
    res.status(500).send(error.message || "Profile setup failed");
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/sign.html");
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

