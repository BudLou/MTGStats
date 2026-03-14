require("dotenv").config();

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");

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
      "SELECT id, name, created_at FROM players ORDER BY name ASC"
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

app.get("/api/matches", async (req, res) => {
  try {
    if (!pool) {
      throw new Error("DATABASE_URL is not set");
    }

    const result = await pool.query(`
      SELECT
        m.id AS match_id,
        m.match_date,
        m.location,
        m.notes,
        p.id AS player_id,
        p.name AS player_name,
        d.id AS deck_id,
        d.deck_name,
        mp.result
      FROM matches m
      JOIN match_players mp ON m.id = mp.match_id
      JOIN players p ON mp.player_id = p.id
      LEFT JOIN decks d ON mp.deck_id = d.id
      ORDER BY m.match_date DESC, m.id DESC, p.name ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching matches:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

app.post("/api/matches", async (req, res) => {
  if (!pool) {
    return res.status(500).json({
      success: false,
      error: "DATABASE_URL is not set"
    });
  }

  const { location, notes, players } = req.body;

  if (!players || !Array.isArray(players) || players.length === 0) {
    return res.status(400).json({
      success: false,
      error: "players array is required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const matchResult = await client.query(
      `
      INSERT INTO matches (location, notes)
      VALUES ($1, $2)
      RETURNING id, match_date, location, notes
      `,
      [location || null, notes || null]
    );

    const match = matchResult.rows[0];

    for (const player of players) {
      await client.query(
        `
        INSERT INTO match_players (match_id, player_id, deck_id, result)
        VALUES ($1, $2, $3, $4)
        `,
        [
          match.id,
          player.player_id,
          player.deck_id || null,
          player.result
        ]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      match
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating match:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  } finally {
    client.release();
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

    res.redirect("/sign.html");
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

    if (dbUser.role === "admin") {
      return res.redirect("/leaderboard.html");
    }

    return res.redirect("/players.html");
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).send(error.message || "Login failed");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});