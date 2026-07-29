/**
 * Unified persistence for users, sessions, userdata, paper portfolio, OTPs.
 * Backends: Postgres (DATABASE_URL) or JSON files under PULSE_DATA_DIR/data.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { hasDatabaseUrl, query, initDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DATA_DIR = path.resolve(
  process.env.PULSE_DATA_DIR || path.join(ROOT, "data")
);
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const USERDATA_DIR = path.join(DATA_DIR, "userdata");
const OTP_FILE = path.join(DATA_DIR, "otp.json");

let mode = "file"; // "file" | "postgres"

export function storageMode() {
  return mode;
}

export function usingPostgres() {
  return mode === "postgres";
}

export function defaultUserData() {
  return {
    country: "US",
    watchlists: { US: null, IN: null },
    portfolio: { positions: {}, trades: [], realized: {} },
    agents: [],
    chartConfig: null,
    moversUniverse: { US: null, IN: null },
    updatedAt: null,
  };
}

function cleanUserData(data) {
  return {
    country: data.country === "IN" || data.country === "US" ? data.country : "US",
    watchlists: {
      US: Array.isArray(data.watchlists?.US) ? data.watchlists.US.slice(0, 100) : null,
      IN: Array.isArray(data.watchlists?.IN) ? data.watchlists.IN.slice(0, 100) : null,
    },
    portfolio: {
      positions: data.portfolio?.positions || {},
      trades: Array.isArray(data.portfolio?.trades)
        ? data.portfolio.trades.slice(0, 500)
        : [],
      realized: data.portfolio?.realized || {},
    },
    agents: Array.isArray(data.agents) ? data.agents.slice(0, 40) : [],
    chartConfig: data.chartConfig || null,
    moversUniverse: {
      US: Array.isArray(data.moversUniverse?.US)
        ? data.moversUniverse.US.slice(0, 40)
        : null,
      IN: Array.isArray(data.moversUniverse?.IN)
        ? data.moversUniverse.IN.slice(0, 40)
        : null,
    },
    updatedAt: Date.now(),
  };
}

function userDataPath(sub) {
  const safe = String(sub || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(USERDATA_DIR, safe + ".json");
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) || fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* -------------------------------------------------------------------------- */
/*  Init + one-shot file → Postgres import                                     */
/* -------------------------------------------------------------------------- */

export async function initStore() {
  const result = await initDb();
  mode = result.mode;
  if (mode === "postgres") {
    await importFileDataIfEmpty();
  }
  return { mode };
}

async function importFileDataIfEmpty() {
  const { rows } = await query("SELECT COUNT(*)::int AS n FROM users");
  if (rows[0].n > 0) return;

  const users = readJsonFile(USERS_FILE, {});
  const emails = Object.keys(users);
  if (!emails.length) return;

  console.log(`[db] Importing ${emails.length} users from ${USERS_FILE}`);
  for (const email of emails) {
    const u = users[email];
    await query(
      `INSERT INTO users (id, email, name, salt, hash, provider, picture, verified, created_at)
       VALUES ($1,$2,$3,$4,$5,'email','',$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [
        u.id,
        u.email || email,
        u.name || "",
        u.salt || null,
        u.hash || null,
        Boolean(u.verified),
        u.createdAt || Date.now(),
      ]
    );
    const sub = "email:" + u.id;
    const udPath = userDataPath(sub);
    try {
      const raw = JSON.parse(fs.readFileSync(udPath, "utf8"));
      await saveUserData(sub, raw);
    } catch {
      /* no userdata file */
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Users                                                                      */
/* -------------------------------------------------------------------------- */

export async function getUserByEmail(email) {
  email = String(email || "").toLowerCase();
  if (mode === "postgres") {
    const { rows } = await query(
      `SELECT id, email, name, salt, hash, google_sub AS "googleSub", provider, picture,
              verified, created_at AS "createdAt"
       FROM users WHERE email = $1`,
      [email]
    );
    return rows[0] || null;
  }
  const users = readJsonFile(USERS_FILE, {});
  return users[email] || null;
}

export async function upsertEmailUser(user) {
  if (mode === "postgres") {
    await query(
      `INSERT INTO users (id, email, name, salt, hash, provider, picture, verified, created_at)
       VALUES ($1,$2,$3,$4,$5,'email','',$6,$7)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         salt = EXCLUDED.salt,
         hash = EXCLUDED.hash,
         verified = EXCLUDED.verified`,
      [
        user.id,
        user.email,
        user.name,
        user.salt,
        user.hash,
        Boolean(user.verified),
        user.createdAt || Date.now(),
      ]
    );
    return user;
  }
  const users = readJsonFile(USERS_FILE, {});
  users[user.email] = user;
  writeJsonFile(USERS_FILE, users);
  return user;
}

export async function updateUserName(email, name) {
  if (mode === "postgres") {
    await query(`UPDATE users SET name = $1 WHERE email = $2`, [name, email]);
    return;
  }
  const users = readJsonFile(USERS_FILE, {});
  if (users[email]) {
    users[email].name = name;
    writeJsonFile(USERS_FILE, users);
  }
}

export async function updateUserPassword(email, salt, hash) {
  if (mode === "postgres") {
    await query(`UPDATE users SET salt = $1, hash = $2 WHERE email = $3`, [
      salt,
      hash,
      email,
    ]);
    return;
  }
  const users = readJsonFile(USERS_FILE, {});
  if (users[email]) {
    users[email].salt = salt;
    users[email].hash = hash;
    writeJsonFile(USERS_FILE, users);
  }
}

export async function upsertGoogleUser(g) {
  // Session sub stays Google's sub for backwards-compatible userdata keys.
  if (mode === "postgres") {
    const byGoogle = await query(
      `SELECT id FROM users WHERE google_sub = $1`,
      [g.sub]
    );
    if (byGoogle.rows[0]) {
      await query(
        `UPDATE users SET name = $1, email = COALESCE($2, email), picture = $3, verified = TRUE
         WHERE google_sub = $4`,
        [g.name || "", g.email || null, g.picture || "", g.sub]
      );
    } else if (g.email) {
      const byEmail = await query(`SELECT id FROM users WHERE email = $1`, [
        g.email,
      ]);
      if (byEmail.rows[0]) {
        await query(
          `UPDATE users SET google_sub = $1, name = $2, picture = $3, provider = 'google', verified = TRUE
           WHERE email = $4`,
          [g.sub, g.name || "", g.picture || "", g.email]
        );
      } else {
        await query(
          `INSERT INTO users (id, email, name, google_sub, provider, picture, verified, created_at)
           VALUES ($1,$2,$3,$4,'google',$5,TRUE,$6)`,
          [
            crypto.randomUUID(),
            g.email,
            g.name || "",
            g.sub,
            g.picture || "",
            Date.now(),
          ]
        );
      }
    } else {
      await query(
        `INSERT INTO users (id, email, name, google_sub, provider, picture, verified, created_at)
         VALUES ($1,NULL,$2,$3,'google',$4,TRUE,$5)`,
        [
          crypto.randomUUID(),
          g.name || "",
          g.sub,
          g.picture || "",
          Date.now(),
        ]
      );
    }
  }
  return {
    sub: g.sub,
    name: g.name,
    email: g.email,
    picture: g.picture || "",
    provider: "google",
    createdAt: null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Sessions                                                                   */
/* -------------------------------------------------------------------------- */

export async function createSession(sid, user, ttlMs) {
  const now = Date.now();
  const expires = now + ttlMs;
  if (mode === "postgres") {
    await query(
      `INSERT INTO sessions (id, user_sub, user_json, created_at, expires_at)
       VALUES ($1,$2,$3::jsonb,$4,$5)`,
      [sid, user.sub, JSON.stringify(user), now, expires]
    );
    return;
  }
  const sessions = readJsonFile(SESSIONS_FILE, {});
  sessions[sid] = { user, ts: now, expires };
  writeJsonFile(SESSIONS_FILE, sessions);
}

export async function getSessionById(sid) {
  if (!sid) return null;
  if (mode === "postgres") {
    const { rows } = await query(
      `SELECT id, user_json AS user, created_at AS ts, expires_at AS expires
       FROM sessions WHERE id = $1`,
      [sid]
    );
    const row = rows[0];
    if (!row) return null;
    if (Date.now() > Number(row.expires)) {
      await query(`DELETE FROM sessions WHERE id = $1`, [sid]);
      return null;
    }
    return { sid: row.id, entry: { user: row.user, ts: Number(row.ts) } };
  }
  const sessions = readJsonFile(SESSIONS_FILE, {});
  const s = sessions[sid];
  if (!s) return null;
  if (Date.now() > (s.expires || s.ts + 7 * 864e5)) {
    delete sessions[sid];
    writeJsonFile(SESSIONS_FILE, sessions);
    return null;
  }
  return { sid, entry: { user: s.user, ts: s.ts } };
}

export async function deleteSession(sid) {
  if (!sid) return;
  if (mode === "postgres") {
    await query(`DELETE FROM sessions WHERE id = $1`, [sid]);
    return;
  }
  const sessions = readJsonFile(SESSIONS_FILE, {});
  delete sessions[sid];
  writeJsonFile(SESSIONS_FILE, sessions);
}

export async function touchSessionUser(sid, user) {
  if (mode === "postgres") {
    await query(`UPDATE sessions SET user_json = $1::jsonb WHERE id = $2`, [
      JSON.stringify(user),
      sid,
    ]);
    return;
  }
  const sessions = readJsonFile(SESSIONS_FILE, {});
  if (sessions[sid]) {
    sessions[sid].user = user;
    writeJsonFile(SESSIONS_FILE, sessions);
  }
}

/* -------------------------------------------------------------------------- */
/*  OTP pending                                                                */
/* -------------------------------------------------------------------------- */

export async function setOtp(email, kind, payload, expiresAt) {
  if (mode === "postgres") {
    await query(
      `INSERT INTO otp_pending (email, kind, payload, expires_at)
       VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (email, kind) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
      [email, kind, JSON.stringify(payload), expiresAt]
    );
    return;
  }
  const all = readJsonFile(OTP_FILE, {});
  all[`${kind}:${email}`] = { ...payload, expires: expiresAt };
  writeJsonFile(OTP_FILE, all);
}

export async function getOtp(email, kind) {
  if (mode === "postgres") {
    const { rows } = await query(
      `SELECT payload, expires_at AS expires FROM otp_pending WHERE email = $1 AND kind = $2`,
      [email, kind]
    );
    const row = rows[0];
    if (!row) return null;
    if (Date.now() > Number(row.expires)) {
      await clearOtp(email, kind);
      return null;
    }
    return { ...row.payload, expires: Number(row.expires) };
  }
  const all = readJsonFile(OTP_FILE, {});
  const p = all[`${kind}:${email}`];
  if (!p) return null;
  if (Date.now() > p.expires) {
    delete all[`${kind}:${email}`];
    writeJsonFile(OTP_FILE, all);
    return null;
  }
  return p;
}

export async function clearOtp(email, kind) {
  if (mode === "postgres") {
    await query(`DELETE FROM otp_pending WHERE email = $1 AND kind = $2`, [
      email,
      kind,
    ]);
    return;
  }
  const all = readJsonFile(OTP_FILE, {});
  delete all[`${kind}:${email}`];
  writeJsonFile(OTP_FILE, all);
}

/* -------------------------------------------------------------------------- */
/*  Userdata + normalized paper portfolio                                      */
/* -------------------------------------------------------------------------- */

async function syncNormalizedPortfolio(userSub, portfolio) {
  if (mode !== "postgres") return;
  const positions = portfolio?.positions || {};
  const trades = Array.isArray(portfolio?.trades) ? portfolio.trades : [];
  const realized = portfolio?.realized || {};

  await query(`DELETE FROM paper_positions WHERE user_sub = $1`, [userSub]);
  for (const [symbol, pos] of Object.entries(positions)) {
    const meta = {
      buySignal: pos.buySignal || null,
      buyScore: pos.buyScore ?? null,
      industry: pos.industry || null,
      sector: pos.sector || null,
      capLabel: pos.capLabel || null,
      fromBasket: Boolean(pos.fromBasket),
      basketId: pos.basketId || null,
    };
    await query(
      `INSERT INTO paper_positions (user_sub, symbol, qty, avg_cost, currency, name, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        userSub,
        symbol,
        pos.qty,
        pos.avgCost,
        pos.currency || null,
        pos.name || null,
        JSON.stringify(meta),
      ]
    );
  }

  await query(`DELETE FROM paper_trades WHERE user_sub = $1`, [userSub]);
  for (const t of trades.slice(0, 500)) {
    const id = t.id || crypto.randomUUID();
    await query(
      `INSERT INTO paper_trades
         (id, user_sub, symbol, side, qty, price, currency, realized, ts, note, meta, venue)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [
        id,
        userSub,
        t.symbol,
        t.side,
        t.qty,
        t.price,
        t.currency || null,
        t.realized ?? null,
        t.ts || Date.now(),
        t.source || t.note || null,
        JSON.stringify({
          signal: t.signal || null,
          score: t.score ?? null,
          industry: t.industry || null,
          sector: t.sector || null,
          capLabel: t.capLabel || null,
          source: t.source || null,
          basketId: t.basketId || null,
        }),
        t.venue || "paper",
      ]
    );
  }

  await query(`DELETE FROM paper_realized WHERE user_sub = $1`, [userSub]);
  for (const [currency, amount] of Object.entries(realized)) {
    await query(
      `INSERT INTO paper_realized (user_sub, currency, amount) VALUES ($1,$2,$3)`,
      [userSub, currency, amount]
    );
  }
}

async function portfolioFromNormalized(userSub) {
  if (mode !== "postgres") return null;
  const [posRes, tradeRes, realRes] = await Promise.all([
    query(`SELECT * FROM paper_positions WHERE user_sub = $1`, [userSub]),
    query(
      `SELECT * FROM paper_trades WHERE user_sub = $1 ORDER BY ts DESC LIMIT 500`,
      [userSub]
    ),
    query(`SELECT currency, amount FROM paper_realized WHERE user_sub = $1`, [
      userSub,
    ]),
  ]);
  if (!posRes.rows.length && !tradeRes.rows.length) return null;

  const positions = {};
  for (const r of posRes.rows) {
    const meta = r.meta || {};
    positions[r.symbol] = {
      qty: Number(r.qty),
      avgCost: Number(r.avg_cost),
      currency: r.currency,
      name: r.name,
      ...meta,
    };
  }
  const trades = tradeRes.rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    qty: Number(r.qty),
    price: Number(r.price),
    currency: r.currency,
    realized: r.realized != null ? Number(r.realized) : undefined,
    ts: Number(r.ts),
    venue: r.venue,
    note: r.note,
    ...(r.meta || {}),
  }));
  const realized = {};
  for (const r of realRes.rows) realized[r.currency] = Number(r.amount);
  return { positions, trades, realized };
}

export async function loadUserData(sub) {
  const base = defaultUserData();
  if (mode === "postgres") {
    const { rows } = await query(
      `SELECT payload, updated_at AS "updatedAt" FROM user_data WHERE user_sub = $1`,
      [sub]
    );
    const raw = rows[0]?.payload || {};
    const normalized = await portfolioFromNormalized(sub);
    const portfolio = normalized || {
      positions: raw.portfolio?.positions || {},
      trades: Array.isArray(raw.portfolio?.trades) ? raw.portfolio.trades : [],
      realized: raw.portfolio?.realized || {},
    };
    return {
      country: raw.country === "IN" || raw.country === "US" ? raw.country : base.country,
      watchlists: {
        US: Array.isArray(raw.watchlists?.US) ? raw.watchlists.US : null,
        IN: Array.isArray(raw.watchlists?.IN) ? raw.watchlists.IN : null,
      },
      portfolio,
      agents: Array.isArray(raw.agents) ? raw.agents : [],
      chartConfig: raw.chartConfig || null,
      moversUniverse: {
        US: Array.isArray(raw.moversUniverse?.US) ? raw.moversUniverse.US : null,
        IN: Array.isArray(raw.moversUniverse?.IN) ? raw.moversUniverse.IN : null,
      },
      updatedAt: rows[0]?.updatedAt || raw.updatedAt || null,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(userDataPath(sub), "utf8"));
    if (!raw || typeof raw !== "object") return base;
    return {
      country: raw.country === "IN" || raw.country === "US" ? raw.country : base.country,
      watchlists: {
        US: Array.isArray(raw.watchlists?.US) ? raw.watchlists.US : null,
        IN: Array.isArray(raw.watchlists?.IN) ? raw.watchlists.IN : null,
      },
      portfolio: {
        positions: raw.portfolio?.positions || {},
        trades: Array.isArray(raw.portfolio?.trades) ? raw.portfolio.trades : [],
        realized: raw.portfolio?.realized || {},
      },
      agents: Array.isArray(raw.agents) ? raw.agents : [],
      chartConfig: raw.chartConfig || null,
      moversUniverse: {
        US: Array.isArray(raw.moversUniverse?.US) ? raw.moversUniverse.US : null,
        IN: Array.isArray(raw.moversUniverse?.IN) ? raw.moversUniverse.IN : null,
      },
      updatedAt: raw.updatedAt || null,
    };
  } catch {
    return base;
  }
}

export async function saveUserData(sub, data) {
  const cleaned = cleanUserData(data);
  if (mode === "postgres") {
    await query(
      `INSERT INTO user_data (user_sub, payload, updated_at)
       VALUES ($1,$2::jsonb,$3)
       ON CONFLICT (user_sub) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [sub, JSON.stringify(cleaned), cleaned.updatedAt]
    );
    await syncNormalizedPortfolio(sub, cleaned.portfolio);
    return cleaned;
  }
  fs.mkdirSync(USERDATA_DIR, { recursive: true });
  fs.writeFileSync(userDataPath(sub), JSON.stringify(cleaned, null, 2));
  return cleaned;
}

/** Apply a filled paper trade and persist portfolio + order row. */
export async function applyPaperFill(userSub, fill) {
  const data = await loadUserData(userSub);
  const p = data.portfolio;
  const {
    symbol,
    side,
    qty,
    price,
    currency,
    name,
    signal,
    industryInfo,
    opts,
    orderId,
  } = fill;
  const sideUp = String(side).toUpperCase();
  let realizedAmt = null;

  if (sideUp === "BUY") {
    const pos = p.positions[symbol] || { qty: 0, avgCost: 0, currency, name };
    const newQty = pos.qty + qty;
    pos.avgCost = (pos.qty * pos.avgCost + qty * price) / newQty;
    pos.qty = newQty;
    pos.currency = currency;
    pos.name = name || pos.name || symbol;
    if (signal?.recommendation) {
      pos.buySignal = signal.recommendation;
      pos.buyScore = signal.score;
    }
    if (industryInfo) {
      if (industryInfo.industry) pos.industry = industryInfo.industry;
      if (industryInfo.sector) pos.sector = industryInfo.sector;
      if (industryInfo.capLabel) pos.capLabel = industryInfo.capLabel;
    }
    if (opts?.source === "basket") {
      pos.fromBasket = true;
      pos.basketId = opts.basketId || pos.basketId || null;
    }
    p.positions[symbol] = pos;
    p.trades.unshift({
      id: crypto.randomUUID(),
      symbol,
      side: "BUY",
      qty,
      price,
      currency,
      ts: Date.now(),
      signal: signal ? signal.recommendation : null,
      score: signal ? signal.score : null,
      industry: industryInfo?.industry || pos.industry || null,
      sector: industryInfo?.sector || pos.sector || null,
      capLabel: industryInfo?.capLabel || pos.capLabel || null,
      source: opts?.source || null,
      basketId: opts?.basketId || null,
      venue: "paper",
      orderId: orderId || null,
    });
  } else if (sideUp === "SELL") {
    const pos = p.positions[symbol];
    if (!pos) throw Object.assign(new Error("No position to sell"), { status: 400 });
    const sellQty = Math.min(Math.floor(qty), pos.qty);
    if (!(sellQty > 0))
      throw Object.assign(new Error("Invalid sell quantity"), { status: 400 });
    realizedAmt = (price - pos.avgCost) * sellQty;
    p.realized[currency] = (p.realized[currency] || 0) + realizedAmt;
    pos.qty -= sellQty;
    p.trades.unshift({
      id: crypto.randomUUID(),
      symbol,
      side: "SELL",
      qty: sellQty,
      price,
      currency,
      realized: realizedAmt,
      ts: Date.now(),
      signal: signal ? signal.recommendation : null,
      score: signal ? signal.score : null,
      venue: "paper",
      orderId: orderId || null,
    });
    if (pos.qty <= 0) delete p.positions[symbol];
    fill.qty = sellQty;
  } else {
    throw Object.assign(new Error("Invalid side"), { status: 400 });
  }

  data.portfolio = p;
  await saveUserData(userSub, data);

  if (mode === "postgres" && orderId) {
    await query(
      `UPDATE orders SET status = 'filled', fill_price = $1, qty = $2, updated_at = $3,
         meta = COALESCE(meta, '{}'::jsonb) || $4::jsonb
       WHERE id = $5`,
      [
        price,
        fill.qty,
        Date.now(),
        JSON.stringify({ realized: realizedAmt }),
        orderId,
      ]
    );
  }

  return {
    portfolio: p,
    fill: {
      symbol,
      side: sideUp,
      qty: fill.qty,
      price,
      currency,
      realized: realizedAmt,
      orderId,
    },
  };
}

export async function insertOrder(order) {
  if (mode === "postgres") {
    await query(
      `INSERT INTO orders
         (id, user_sub, venue, symbol, side, qty, order_type, limit_price, status,
          fill_price, broker_order_id, error, created_at, updated_at, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
      [
        order.id,
        order.userSub,
        order.venue || "paper",
        order.symbol,
        order.side,
        order.qty,
        order.orderType || "market",
        order.limitPrice ?? null,
        order.status,
        order.fillPrice ?? null,
        order.brokerOrderId ?? null,
        order.error ?? null,
        order.createdAt,
        order.updatedAt,
        JSON.stringify(order.meta || {}),
      ]
    );
    return order;
  }
  // File mode: orders live inside userdata trades; keep a lightweight log
  const file = path.join(DATA_DIR, "orders.json");
  const all = readJsonFile(file, []);
  all.unshift(order);
  writeJsonFile(file, all.slice(0, 2000));
  return order;
}

export async function listOrders(userSub, limit = 50) {
  if (mode === "postgres") {
    const { rows } = await query(
      `SELECT * FROM orders WHERE user_sub = $1 ORDER BY created_at DESC LIMIT $2`,
      [userSub, limit]
    );
    return rows;
  }
  const file = path.join(DATA_DIR, "orders.json");
  return readJsonFile(file, [])
    .filter((o) => o.userSub === userSub)
    .slice(0, limit);
}

const BROKER_CONN_FILE = path.join(DATA_DIR, "broker_connections.json");

function brokerTokenKey() {
  const secret =
    process.env.BROKER_TOKEN_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.PULSE_SECRET ||
    "pulse-dev-broker-token-key-change-me";
  return crypto.createHash("sha256").update(String(secret)).digest();
}

export function encryptBrokerTokens(tokens) {
  if (!tokens) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", brokerTokenKey(), iv);
  const plain = Buffer.from(JSON.stringify(tokens), "utf8");
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptBrokerTokens(blob) {
  if (!blob) return null;
  try {
    const buf = Buffer.from(String(blob), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", brokerTokenKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return null;
  }
}

function publicBrokerConn(row, includeTokens = false) {
  const meta = typeof row.meta === "string" ? JSON.parse(row.meta || "{}") : row.meta || {};
  const out = {
    id: row.id,
    userSub: row.userSub || row.user_sub,
    provider: row.provider,
    status: row.status,
    expiresAt: row.expiresAt ?? row.expires_at ?? null,
    meta,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
    linked: row.status === "connected",
  };
  if (includeTokens) {
    out.tokens = row.tokens || decryptBrokerTokens(row.encrypted_tokens || row.encryptedTokens);
  }
  return out;
}

export async function listBrokerConnections(userSub) {
  if (mode === "postgres") {
    const { rows } = await query(
      `SELECT id, user_sub AS "userSub", provider, status, expires_at AS "expiresAt",
              meta, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM broker_connections WHERE user_sub = $1`,
      [userSub]
    );
    return rows.map((r) => publicBrokerConn(r, false));
  }
  const all = readJsonFile(BROKER_CONN_FILE, {});
  return Object.values(all)
    .filter((r) => r.userSub === userSub)
    .map((r) => publicBrokerConn(r, false));
}

export async function getBrokerConnection(userSub, provider) {
  if (mode === "postgres") {
    const { rows } = await query(
      `SELECT id, user_sub AS "userSub", provider, status, encrypted_tokens,
              expires_at AS "expiresAt", meta, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM broker_connections WHERE user_sub = $1 AND provider = $2`,
      [userSub, provider]
    );
    if (!rows[0]) return null;
    return publicBrokerConn(rows[0], true);
  }
  const all = readJsonFile(BROKER_CONN_FILE, {});
  const key = `${userSub}::${provider}`;
  const row = all[key];
  if (!row) return null;
  return publicBrokerConn(
    { ...row, encrypted_tokens: row.encryptedTokens },
    true
  );
}

export async function upsertBrokerConnection({
  userSub,
  provider,
  status,
  tokens = undefined,
  expiresAt = null,
  meta = {},
}) {
  const now = Date.now();
  const id = crypto.randomUUID();
  const encrypted =
    tokens === undefined
      ? undefined
      : tokens
        ? encryptBrokerTokens(tokens)
        : null;

  if (mode === "postgres") {
    if (tokens === undefined) {
      await query(
        `INSERT INTO broker_connections
           (id, user_sub, provider, status, encrypted_tokens, expires_at, meta, created_at, updated_at)
         VALUES ($1,$2,$3,$4,NULL,$5,$6::jsonb,$7,$7)
         ON CONFLICT (user_sub, provider) DO UPDATE SET
           status = EXCLUDED.status,
           expires_at = EXCLUDED.expires_at,
           meta = EXCLUDED.meta,
           updated_at = EXCLUDED.updated_at`,
        [id, userSub, provider, status, expiresAt, JSON.stringify(meta || {}), now]
      );
    } else {
      await query(
        `INSERT INTO broker_connections
           (id, user_sub, provider, status, encrypted_tokens, expires_at, meta, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)
         ON CONFLICT (user_sub, provider) DO UPDATE SET
           status = EXCLUDED.status,
           encrypted_tokens = EXCLUDED.encrypted_tokens,
           expires_at = EXCLUDED.expires_at,
           meta = EXCLUDED.meta,
           updated_at = EXCLUDED.updated_at`,
        [
          id,
          userSub,
          provider,
          status,
          encrypted,
          expiresAt,
          JSON.stringify(meta || {}),
          now,
        ]
      );
    }
    return getBrokerConnection(userSub, provider);
  }

  // File mode
  const all = readJsonFile(BROKER_CONN_FILE, {});
  const key = `${userSub}::${provider}`;
  const prev = all[key] || {};
  all[key] = {
    id: prev.id || id,
    userSub,
    provider,
    status,
    encryptedTokens:
      tokens === undefined ? prev.encryptedTokens ?? null : encrypted,
    expiresAt,
    meta: { ...(prev.meta || {}), ...(meta || {}) },
    createdAt: prev.createdAt || now,
    updatedAt: now,
  };
  writeJsonFile(BROKER_CONN_FILE, all);
  return getBrokerConnection(userSub, provider);
}

export async function ensureBrokerConnectionStub(userSub, provider = "paper") {
  const existing = await getBrokerConnection(userSub, provider);
  if (existing) return listBrokerConnections(userSub);
  await upsertBrokerConnection({
    userSub,
    provider,
    status: provider === "paper" ? "paper_only" : "disconnected",
    tokens: null,
    meta: {},
  });
  return listBrokerConnections(userSub);
}
