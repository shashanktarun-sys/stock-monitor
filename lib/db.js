/**
 * Postgres pool + schema migration.
 * When DATABASE_URL is unset, callers should use the file-backed store instead.
 */
import pg from "pg";

const { Pool } = pg;

let pool = null;

export function hasDatabaseUrl() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

export function getPool() {
  return pool;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  salt TEXT,
  hash TEXT,
  google_sub TEXT UNIQUE,
  provider TEXT NOT NULL DEFAULT 'email',
  picture TEXT NOT NULL DEFAULT '',
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  user_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS user_data (
  user_sub TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at BIGINT
);

CREATE TABLE IF NOT EXISTS paper_positions (
  user_sub TEXT NOT NULL,
  symbol TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  avg_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  currency TEXT,
  name TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_sub, symbol)
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  currency TEXT,
  realized DOUBLE PRECISION,
  ts BIGINT NOT NULL,
  note TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  venue TEXT NOT NULL DEFAULT 'paper'
);
CREATE INDEX IF NOT EXISTS paper_trades_user_ts_idx ON paper_trades (user_sub, ts DESC);

CREATE TABLE IF NOT EXISTS paper_realized (
  user_sub TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (user_sub, currency)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT 'paper',
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'market',
  limit_price DOUBLE PRECISION,
  status TEXT NOT NULL,
  fill_price DOUBLE PRECISION,
  broker_order_id TEXT,
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders (user_sub, created_at DESC);

CREATE TABLE IF NOT EXISTS broker_connections (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected',
  encrypted_tokens TEXT,
  expires_at BIGINT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (user_sub, provider)
);

CREATE TABLE IF NOT EXISTS otp_pending (
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (email, kind)
);
`;

export async function initDb() {
  if (!hasDatabaseUrl()) {
    console.log("[db] DATABASE_URL not set — using file-backed store");
    return { mode: "file" };
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.PGSSL === "0"
        ? false
        : process.env.NODE_ENV === "production" || process.env.RENDER
          ? { rejectUnauthorized: false }
          : undefined,
  });
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
  } finally {
    client.release();
  }
  console.log("[db] Postgres connected and schema ready");
  return { mode: "postgres" };
}

export async function query(text, params) {
  if (!pool) throw new Error("Database not initialized");
  return pool.query(text, params);
}
