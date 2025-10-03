import express from "express";
import cors from "cors";
import pkg from "pg";
import dotenv from "dotenv";
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";

dotenv.config();

const { Pool } = pkg;

// ----------------------------
// Database (Postgres)
// ----------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    require: true,
    rejectUnauthorized: false,
  },
});
pool.connect()
  .then(() => console.log("✅ Connected to Postgres"))
  .catch(err => console.error("❌ Connection error", err));

// ----------------------------
// Express Setup
// ----------------------------
const app = express();
app.use(express.json());
app.use(cors({ origin: "http://localhost:3000", credentials: true }));

// ----------------------------
// Sessions (needed for passport)
// ----------------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ----------------------------
// Google OAuth setup
// ----------------------------
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    (accessToken, refreshToken, profile, done) => {
      const user = {
        googleId: profile.id,
        displayName: profile.displayName,
        email: profile.emails?.[0]?.value,
      };
      return done(null, user);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ----------------------------
// Auth Routes
// ----------------------------
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "http://localhost:3000/login",
    successRedirect: "http://localhost:3000/dashboard",
  })
);

app.get("/logout", (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    res.json({ message: "✅ Logged out" });
  });
});

// ----------------------------
// API Routes
// ----------------------------

// Health check
app.get("/health", (_, res) => res.json({ ok: true }));

// Menu items
app.get("/api/menu-items", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM products ORDER BY name"
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch menu items" });
  }
});


// Orders
app.post("/api/orders", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const today = new Date().toISOString().slice(0, 10);
    const upsert = `
      INSERT INTO bill_counters (date_key, counter) VALUES ($1, 1)
      ON CONFLICT (date_key) DO UPDATE SET counter = bill_counters.counter + 1
      RETURNING counter;
    `;
    const { rows: crows } = await client.query(upsert, [today]);
    const sequence = crows[0].counter;
    const billNo = `${today.replace(/-/g, "")}-${sequence
      .toString()
      .padStart(4, "0")}`;

    const { customer_name, phone, session, total, items } = req.body;
    const { rows: orows } = await client.query(
      `INSERT INTO orders (bill_no, customer_name, phone, session, total)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [billNo, customer_name || null, phone || null, session || null, total]
    );
    const orderId = orows[0].id;

    for (const it of items) {
      await client.query(
        `INSERT INTO order_items (order_id, item_id, name_snapshot, qty, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderId, it.id || null, it.name, it.qty, it.price, it.total]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, bill_no: billNo, order_id: orderId });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Failed to create order" });
  } finally {
    client.release();
  }
});

// ----------------------------
// Start Server
// ----------------------------
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`🚀 API listening on ${port}`));
