# Pulse — Real-Time Stock Monitor

A web app that monitors stock prices in near real time and generates
**short-term BUY / HOLD / SELL signals** from classic technical indicators
(SMA crossovers, RSI, MACD, momentum).

![signal badges: STRONG BUY / BUY / HOLD / SELL / STRONG SELL]

## Features

- 🌍 **Country selector** — switch between the 🇺🇸 US market (USD) and the 🇮🇳 Indian market (NSE, INR). Each market keeps its own watchlist.
- 🔎 **Search** any ticker or company; results are prioritized for the selected market (NSE for India, NASDAQ/NYSE for the US).
- ⭐ **Watchlist** with live prices, % change, and a signal badge per stock (saved to your browser).
- 🔄 **Auto-refresh** every 10s / 30s / 1m (configurable).
- 🚦 **Top gainers & losers** of the day per market (with an editable scan universe — use the defaults, your watchlist, or a custom symbol list).
- 📊 **Interactive chart** with a **Line / Candlestick** toggle, overlays (SMA 10/20/50, EMA 9, Bollinger Bands) and a lower pane (RSI, MACD, or Volume). Choices are remembered.
- 🕒 Time-aware x-axis that adapts to the range.
- 🧠 **Signal engine** that explains *why* it recommends a move.
- 📈 Indicator dashboard: RSI(14), SMA 10/20/50, MACD, 5-day rate of change.
- 💼 **Paper-trading portfolio** — buy/sell with virtual money and track profit/loss.
- 🔐 **Accounts** — sign up with **email + password (verified by an emailed 6-digit OTP)**, or use optional **Google sign-in**. Each account gets its own namespaced watchlist & portfolio in the browser. You can also **continue as a guest**.

### Live data & Indian stocks

Prices come from the public **Yahoo Finance** API in real time (slightly delayed
during market hours). Indian stocks use Yahoo's NSE (`.NS`) / BSE (`.BO`)
suffixes — e.g. `RELIANCE.NS`, `TCS.NS`. When you're on the India market, plain
tickers you type are automatically resolved to `.NS`.

> **Note:** If a VPN, firewall, or proxy blocks `query*.finance.yahoo.com`, the
> live feed becomes unreachable and the app temporarily shows clearly-labeled
> **SIMULATED** demo data so it stays usable. Disconnect the VPN for live prices.

## How the signal works

Each quote is scored from **-100 (strong sell)** to **+100 (strong buy)** by
combining weighted signals:

| Indicator | Bullish when | Bearish when |
|-----------|--------------|--------------|
| SMA10 vs SMA20 | 10 > 20 (uptrend) | 10 < 20 (downtrend) |
| Price vs SMA20 | above | below |
| Price vs SMA50 | above | below |
| RSI(14) | < 30 oversold / > 50 | > 70 overbought / < 50 |
| MACD | above signal line | below signal line |
| 5-day momentum | positive | negative |
| Candlestick patterns | hammer, engulfing, morning star, three soldiers, etc. | shooting star, evening star, three crows, etc. |

Candlestick detection uses the last few daily OHLC bars (doji, hammer, engulfing, harami, stars, soldiers/crows, and more). Pattern score is capped and blended into the total.

The final score maps to: `STRONG BUY ≥ 45`, `BUY ≥ 15`, `HOLD`, `SELL ≤ -15`, `STRONG SELL ≤ -45`.

## Getting started

```bash
npm install
npm start
```

Then open http://localhost:3000

For live-reload during development:

```bash
npm run dev
```

## Deploy (free public URL)

This repo includes a [Render](https://render.com) Blueprint (`render.yaml`) that
deploys as **pulse-stock-pal** on the free plan.

1. Push this repo to GitHub (already done if you followed check-in).
2. Open: [Deploy Blueprint on Render](https://dashboard.render.com/blueprints/new?repo=https://github.com/shashanktarun-sys/stock-monitor)
3. Connect your GitHub account if prompted, then click **Apply**.
4. After deploy finishes, your public URL will be:
   **https://pulse-stock-pal.onrender.com**

Notes:
- Free Render web services **sleep after ~15 minutes** of no traffic; the first request after sleep can take ~30–60s.
- **Durable accounts:** set `DATABASE_URL` to a Postgres instance (Render Blueprint creates `pulse-db`, or use [Neon](https://neon.tech) / any Postgres). Without it, auth falls back to local `data/` files which **reset on free-host redeploys**.
- Trading stays **paper-only** (`EXECUTION_MODE=paper`). Signed-in buys/sells go through `POST /api/orders` → PaperBroker. Live broker adapters can plug in later — see [docs/BROKER_ADAPTER.md](docs/BROKER_ADAPTER.md).
- Optional: set `GOOGLE_CLIENT_ID` and SMTP env vars in the Render dashboard for Google login and real OTP emails (without SMTP, signup/reset still works and shows the OTP on screen).

## Persistence

| Mode | When | Stores |
|------|------|--------|
| Postgres | `DATABASE_URL` set | users, sessions, userdata JSONB, paper positions/trades, orders, broker_connections |
| File | no `DATABASE_URL` | `data/users.json`, `data/sessions.json`, `data/userdata/*.json` |

On first Postgres boot, existing `data/users.json` + userdata files are imported if the DB is empty.

## Use it on your iPhone (installable PWA)

Pulse is a **Progressive Web App**, so you can add it to your iPhone Home Screen
and run it full-screen like a native app — no App Store or Mac required.

1. Start the server on your PC: `npm start`.
2. Make sure your iPhone and PC are on the **same Wi-Fi**.
3. Find your PC's LAN IP (Windows: `ipconfig` → IPv4 Address). Example: `192.168.1.11`.
4. On your iPhone, open **Safari** and go to `http://<your-pc-ip>:3000` (e.g. `http://192.168.1.11:3000`).
5. Tap the **Share** button → **Add to Home Screen** → **Add**.
6. Launch **Pulse** from your Home Screen — it opens full-screen with its own icon.

Notes:
- The PC must be running the server and awake for the phone to load data.
- If the page doesn't load on the phone, allow **Node.js** through **Windows Defender Firewall** (Private networks) for inbound port 3000.
- Offline caching (service worker) only activates over `https`/`localhost`; over a
  plain-HTTP LAN address the app still installs and runs, it just won't cache offline.
- To use it anywhere (not just home Wi-Fi), host it on any Node host with HTTPS
  (Render, Railway, Fly.io, a VPS, etc.) and open that URL on your phone.

### What about a native App Store app?

A native iOS app must be **built on a Mac with Xcode** and signed with an Apple ID,
so it can't be compiled from Windows. The PWA above gives you an app-like
experience today. If you later have a Mac, the same web app can be wrapped with
[Capacitor](https://capacitorjs.com/) to produce a native build.

## Accounts & email OTP verification

Users can **create an account with an email + password**. On signup the server
generates a **6-digit one-time code**, emails it, and the account is only
activated after the code is verified. Passwords are hashed with `scrypt`.
Accounts / sessions / synced data live in **Postgres** when `DATABASE_URL` is set,
otherwise under `data/` (gitignored). Sessions use an HttpOnly `sid` cookie.

**Cloud sync:** when signed in, your **watchlists, paper portfolio, chart
settings, and market preference** are stored on the server and restored on the
next login — including from another browser or device. Guests still use browser
`localStorage` only. Signed-in **buy/sell** goes through `POST /api/orders`
(paper venue); guests keep local paper fills.

### Email delivery (SMTP)

To actually send the OTP email, configure SMTP (implicit TLS, e.g. Gmail on port
465 with an [App Password](https://support.google.com/accounts/answer/185833)):

```powershell
# PowerShell (Windows)
$env:SMTP_HOST="smtp.gmail.com"
$env:SMTP_PORT="465"
$env:SMTP_USER="you@gmail.com"
$env:SMTP_PASS="your_16_char_app_password"
$env:SMTP_FROM="Pulse <you@gmail.com>"
npm start
```

```bash
# macOS / Linux
SMTP_HOST=smtp.gmail.com SMTP_PORT=465 SMTP_USER=you@gmail.com \
SMTP_PASS=your_app_password SMTP_FROM="Pulse <you@gmail.com>" npm start
```

> **Dev mode:** if SMTP isn't configured, the server prints the OTP to the
> console **and** shows it in the verification screen so you can test the full
> signup flow without a real mailbox. Configure SMTP before deploying publicly.

## Optional: enable Google sign-in

Google login is **off by default** — the app works fully as a guest. To turn it on:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**.
2. Configure the **OAuth consent screen** (External, add your email as a test user).
3. **Create credentials → OAuth client ID → Web application**.
4. Under **Authorized JavaScript origins**, add the exact origin(s) you'll open the app from, e.g.:
   - `http://localhost:3000`
   - your public HTTPS URL (Google requires **HTTPS** for non-localhost origins — a
     plain `http://192.168.x.x` LAN address will **not** work for Google login).
5. Copy the generated **Client ID** and start the server with it:

```powershell
# PowerShell (Windows)
$env:GOOGLE_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com"; npm start
```

```bash
# macOS / Linux
GOOGLE_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com" npm start
```

The server exposes the Client ID via `/api/config`, the frontend loads Google
Identity Services and renders the **Sign in with Google** button. The ID token is
verified server-side, a session cookie (`sid`, HttpOnly) is issued, and per-user
data is namespaced in `localStorage`. If `GOOGLE_CLIENT_ID` is not set, the login
card shows a "not configured" note and only the guest option.

> Sessions are stored in memory, so signing in again is required after a server restart.

## Tech

- **Backend:** Node.js (built-in `http`, zero dependencies). Proxies the public
  Yahoo Finance chart API, computes indicators server-side, and handles Google
  token verification + sessions.
- **Frontend:** Vanilla JS + a lightweight custom canvas chart (no build step,
  no heavy dependencies).

## ⚠️ Disclaimer

This project is for **educational purposes only**. The signals are derived from
technical indicators on delayed/near-real-time public data and are **not
financial advice**. Trading involves substantial risk of loss. Always do your
own research and consult a licensed professional before investing.
