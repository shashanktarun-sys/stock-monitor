import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

// Google OAuth: set this to your OAuth 2.0 Web Client ID to enable Google login.
// (Google Cloud Console → APIs & Services → Credentials → OAuth client ID → Web.)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

// Email (SMTP over implicit TLS, e.g. Gmail smtp.gmail.com:465 with an App Password)
// used to send signup verification OTPs. If not configured, the server runs in
// "dev" mode: the OTP is logged to the console and returned to the client so the
// signup flow is still testable without a real mailbox.
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const APP_NAME = process.env.APP_NAME || "Pulse";
const EMAIL_ENABLED = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

/* -------------------------------------------------------------------------- */
/*  Yahoo Finance data fetching (live source)                                 */
/* -------------------------------------------------------------------------- */

const YAHOO_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
};

// When the live feed fails (e.g. offline), skip it for a while so requests
// stay fast instead of repeatedly waiting on network timeouts.
let liveDisabledUntil = 0;
const LIVE_COOLDOWN_MS = 60_000;

function liveEnabled() {
  return Date.now() >= liveDisabledUntil;
}

function noteLiveFailure() {
  liveDisabledUntil = Date.now() + LIVE_COOLDOWN_MS;
}

// short timeout so we fail over to simulated data quickly when offline
function fetchWithTimeout(url, ms = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: FETCH_HEADERS, signal: ctrl.signal }).finally(
    () => clearTimeout(timer)
  );
}

async function yahooFetch(pathAndQuery) {
  let lastErr;
  let reachable = false; // at least one host answered (even with an error status)
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await fetchWithTimeout(host + pathAndQuery);
      reachable = true;
      if (!res.ok) {
        lastErr = new Error(`Yahoo responded ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err; // network-level failure (offline, DNS, timeout, VPN block)
    }
  }
  const error = lastErr || new Error("Failed to reach Yahoo Finance");
  // Only flag as a network problem when NO host could be reached at all.
  error.network = !reachable;
  throw error;
}

async function getChartLive(symbol, range = "6mo", interval = "1d") {
  const q = `/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=${interval}&includePrePost=false`;
  const data = await yahooFetch(q);
  const result = data?.chart?.result?.[0];
  if (!result) {
    const msg = data?.chart?.error?.description || "No data for symbol";
    throw new Error(msg);
  }
  const meta = result.meta || {};
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close?.[i];
    if (close == null) continue;
    candles.push({
      t: timestamps[i] * 1000,
      open: quote.open?.[i] ?? close,
      high: quote.high?.[i] ?? close,
      low: quote.low?.[i] ?? close,
      close,
      volume: quote.volume?.[i] ?? 0,
    });
  }
  return { meta, candles, source: "live" };
}

function countryRank(item, country) {
  const sym = (item.symbol || "").toUpperCase();
  const exch = (item.exchange || "").toUpperCase();
  if (country === "IN") {
    if (sym.endsWith(".NS") || sym.endsWith(".BO")) return 0;
    if (exch.includes("NSE") || exch.includes("BSE") || exch === "NSI") return 0;
    return 1;
  }
  if (country === "US") {
    // US listings on Yahoo have no ".EXCHANGE" suffix
    if (!sym.includes(".")) return 0;
    return 1;
  }
  return 0;
}

// Lightweight daily change for a symbol (small payload) for the movers board.
async function getDailyChangeLive(symbol) {
  const { meta, candles } = await getChartLive(symbol, "5d", "1d");
  const price = meta.regularMarketPrice ?? candles[candles.length - 1].close;
  const prevClose =
    meta.chartPreviousClose ??
    meta.previousClose ??
    candles[candles.length - 2]?.close ??
    price;
  return {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || currencyForSymbol(symbol),
    price,
    prevClose,
    changePercent: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
  };
}

function getDailyChangeSimulated(symbol) {
  const { meta, candles } = getChartSimulated(symbol);
  const price = meta.regularMarketPrice;
  const prevClose = candles[candles.length - 2].close;
  return {
    symbol,
    name: meta.longName,
    currency: meta.currency,
    price,
    prevClose,
    changePercent: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
  };
}

async function getDailyChange(symbol) {
  if (liveEnabled()) {
    try {
      return await getDailyChangeLive(symbol);
    } catch (err) {
      if (err.network) noteLiveFailure();
    }
  }
  return getDailyChangeSimulated(symbol);
}

async function searchLive(query, country) {
  const q = `/v1/finance/search?q=${encodeURIComponent(
    query
  )}&quotesCount=12&newsCount=0`;
  const data = await yahooFetch(q);
  const items = (data?.quotes || [])
    .filter((it) => it.symbol && (it.shortname || it.longname))
    .map((it) => ({
      symbol: it.symbol,
      name: it.shortname || it.longname,
      exchange: it.exchDisp || it.exchange || "",
      type: it.quoteType || "",
    }));
  if (country) {
    // stable sort: preferred country's exchanges first
    items.sort((a, b) => countryRank(a, country) - countryRank(b, country));
  }
  return items.slice(0, 8);
}

/* -------------------------------------------------------------------------- */
/*  Simulated data fallback (used when the live source is unreachable)        */
/* -------------------------------------------------------------------------- */

const KNOWN = {
  // United States (USD)
  AAPL: { name: "Apple Inc.", base: 225, vol: 0.018, ccy: "USD", country: "US" },
  MSFT: { name: "Microsoft Corporation", base: 430, vol: 0.015, ccy: "USD", country: "US" },
  NVDA: { name: "NVIDIA Corporation", base: 128, vol: 0.032, ccy: "USD", country: "US" },
  TSLA: { name: "Tesla, Inc.", base: 250, vol: 0.038, ccy: "USD", country: "US" },
  AMZN: { name: "Amazon.com, Inc.", base: 185, vol: 0.02, ccy: "USD", country: "US" },
  GOOGL: { name: "Alphabet Inc.", base: 175, vol: 0.019, ccy: "USD", country: "US" },
  META: { name: "Meta Platforms, Inc.", base: 500, vol: 0.024, ccy: "USD", country: "US" },
  NFLX: { name: "Netflix, Inc.", base: 640, vol: 0.026, ccy: "USD", country: "US" },
  AMD: { name: "Advanced Micro Devices", base: 160, vol: 0.034, ccy: "USD", country: "US" },
  INTC: { name: "Intel Corporation", base: 32, vol: 0.028, ccy: "USD", country: "US" },
  SPY: { name: "SPDR S&P 500 ETF", base: 545, vol: 0.009, ccy: "USD", country: "US" },
  QQQ: { name: "Invesco QQQ Trust", base: 480, vol: 0.012, ccy: "USD", country: "US" },

  // India — NSE (INR)
  "RELIANCE.NS": { name: "Reliance Industries Ltd.", base: 2950, vol: 0.017, ccy: "INR", country: "IN" },
  "TCS.NS": { name: "Tata Consultancy Services Ltd.", base: 3900, vol: 0.015, ccy: "INR", country: "IN" },
  "HDFCBANK.NS": { name: "HDFC Bank Ltd.", base: 1650, vol: 0.016, ccy: "INR", country: "IN" },
  "INFY.NS": { name: "Infosys Ltd.", base: 1600, vol: 0.018, ccy: "INR", country: "IN" },
  "ICICIBANK.NS": { name: "ICICI Bank Ltd.", base: 1200, vol: 0.017, ccy: "INR", country: "IN" },
  "SBIN.NS": { name: "State Bank of India", base: 830, vol: 0.021, ccy: "INR", country: "IN" },
  "TATAMOTORS.NS": { name: "Tata Motors Ltd.", base: 980, vol: 0.028, ccy: "INR", country: "IN" },
  "WIPRO.NS": { name: "Wipro Ltd.", base: 520, vol: 0.02, ccy: "INR", country: "IN" },
  "ITC.NS": { name: "ITC Ltd.", base: 440, vol: 0.014, ccy: "INR", country: "IN" },
  "BHARTIARTL.NS": { name: "Bharti Airtel Ltd.", base: 1450, vol: 0.019, ccy: "INR", country: "IN" },
  "LT.NS": { name: "Larsen & Toubro Ltd.", base: 3600, vol: 0.018, ccy: "INR", country: "IN" },
  "HINDUNILVR.NS": { name: "Hindustan Unilever Ltd.", base: 2500, vol: 0.013, ccy: "INR", country: "IN" },
  "AXISBANK.NS": { name: "Axis Bank Ltd.", base: 1150, vol: 0.02, ccy: "INR", country: "IN" },
  "MARUTI.NS": { name: "Maruti Suzuki India Ltd.", base: 12500, vol: 0.017, ccy: "INR", country: "IN" },
  "^NSEI": { name: "NIFTY 50", base: 24500, vol: 0.009, ccy: "INR", country: "IN" },
};

function currencyForSymbol(symbol) {
  if (KNOWN[symbol]) return KNOWN[symbol].ccy || "USD";
  const s = symbol.toUpperCase();
  if (s.endsWith(".NS") || s.endsWith(".BO") || s === "^NSEI" || s === "^BSESN")
    return "INR";
  return "USD";
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getChartSimulated(symbol) {
  const info = KNOWN[symbol] || {
    name: `${symbol} (Simulated)`,
    base: 40 + (hashSeed(symbol) % 400),
    vol: 0.02 + (hashSeed(symbol + "v") % 25) / 1000,
  };
  const seed = hashSeed(symbol);
  const rand = mulberry32(seed);
  const gauss = () => (rand() + rand() + rand() + rand() - 2) / 2; // ~N(0,1)

  const N = 130;
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const drift = (rand() - 0.45) * info.vol * 0.4; // slight per-symbol trend

  const candles = [];
  let price = info.base * (0.85 + rand() * 0.3);
  for (let i = N - 1; i >= 0; i--) {
    const t = now - i * dayMs;
    const shock = gauss() * info.vol;
    const open = price;
    price = Math.max(1, price * (1 + drift + shock));
    const close = price;
    const high = Math.max(open, close) * (1 + Math.abs(gauss()) * info.vol * 0.5);
    const low = Math.min(open, close) * (1 - Math.abs(gauss()) * info.vol * 0.5);
    candles.push({
      t,
      open,
      high,
      low,
      close,
      volume: Math.round(1e6 + rand() * 5e6),
    });
  }

  // make the latest price feel "live": perturb it on a short time cycle
  const last = candles[candles.length - 1];
  const phase = (now / 45000) + seed; // shifts every refresh
  const jitter = Math.sin(phase) * info.vol * 0.6 + (rand() - 0.5) * info.vol * 0.3;
  const livePrice = Math.max(1, last.close * (1 + jitter));
  last.close = livePrice;
  last.high = Math.max(last.high, livePrice);
  last.low = Math.min(last.low, livePrice);

  const meta = {
    longName: info.name,
    shortName: info.name,
    currency: currencyForSymbol(symbol),
    fullExchangeName: "Simulated Exchange",
    marketState: "SIMULATED",
    regularMarketPrice: livePrice,
    chartPreviousClose: candles[candles.length - 2].close,
    regularMarketDayHigh: last.high,
    regularMarketDayLow: last.low,
  };
  return { meta, candles, source: "simulated" };
}

const SIM_UNIVERSE = Object.entries(KNOWN).map(([symbol, v]) => ({
  symbol,
  name: v.name,
  exchange: v.country === "IN" ? "NSE (sim)" : "SIM",
  type: symbol.startsWith("^") ? "INDEX" : "EQUITY",
  country: v.country || "US",
}));

function searchSimulated(query, country) {
  const q = query.toLowerCase();
  let pool = SIM_UNIVERSE;
  if (country) pool = SIM_UNIVERSE.filter((it) => it.country === country);
  let matches = pool.filter(
    (it) =>
      it.symbol.toLowerCase().includes(q) || it.name.toLowerCase().includes(q)
  );
  // fall back to the full universe if a country filter hid everything
  if (!matches.length && country) {
    matches = SIM_UNIVERSE.filter(
      (it) =>
        it.symbol.toLowerCase().includes(q) || it.name.toLowerCase().includes(q)
    );
  }
  if (matches.length) return matches;
  // allow arbitrary symbols so the user can still add anything in demo mode
  return [
    {
      symbol: query.toUpperCase(),
      name: `${query.toUpperCase()} (Simulated)`,
      exchange: "SIM",
      type: "EQUITY",
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Unified data access with graceful fallback                                */
/* -------------------------------------------------------------------------- */

async function getChart(symbol, range, interval) {
  if (liveEnabled()) {
    try {
      return await getChartLive(symbol, range, interval);
    } catch (err) {
      // Only drop to demo mode on real connectivity loss, not for a single
      // unknown/invalid symbol that Yahoo simply has no data for.
      if (err.network) noteLiveFailure();
    }
  }
  return getChartSimulated(symbol);
}

async function search(query, country) {
  if (liveEnabled()) {
    try {
      const live = await searchLive(query, country);
      if (live.length) return live;
    } catch (err) {
      if (err.network) noteLiveFailure();
    }
  }
  return searchSimulated(query, country);
}

/* -------------------------------------------------------------------------- */
/*  Market movers (top gainers / losers of the day)                           */
/* -------------------------------------------------------------------------- */

const MOVER_UNIVERSE = {
  US: [
    "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "NFLX", "AMD",
    "INTC", "JPM", "BAC", "WMT", "DIS", "KO", "PEP", "XOM", "CVX", "PFE",
    "JNJ", "V", "MA", "BA", "NKE", "CSCO", "ORCL", "CRM", "ADBE", "QCOM", "PYPL",
  ],
  IN: [
    "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS",
    "SBIN.NS", "TATAMOTORS.NS", "WIPRO.NS", "ITC.NS", "BHARTIARTL.NS",
    "LT.NS", "HINDUNILVR.NS", "AXISBANK.NS", "MARUTI.NS", "KOTAKBANK.NS",
    "BAJFINANCE.NS", "HCLTECH.NS", "ASIANPAINT.NS", "SUNPHARMA.NS", "TITAN.NS",
    "ULTRACEMCO.NS", "NESTLEIND.NS", "POWERGRID.NS", "NTPC.NS", "ONGC.NS",
    "TATASTEEL.NS", "ADANIENT.NS", "JSWSTEEL.NS", "TECHM.NS", "COALINDIA.NS",
  ],
};

const moversCache = {}; // country -> { ts, data }
const MOVERS_TTL_MS = 60_000;

async function getMovers(country, customSymbols) {
  const key = country === "IN" ? "IN" : "US";
  const universe =
    customSymbols && customSymbols.length ? customSymbols : MOVER_UNIVERSE[key];
  const cacheKey = key + "|" + universe.join(",");
  const cached = moversCache[cacheKey];
  if (cached && Date.now() - cached.ts < MOVERS_TTL_MS) return cached.data;

  const results = await Promise.allSettled(
    universe.map((s) => getDailyChange(s))
  );
  const quotes = results
    .filter((r) => r.status === "fulfilled" && Number.isFinite(r.value.changePercent))
    .map((r) => r.value);

  const anySim = results.some(
    (r) => r.status === "fulfilled" && r.value.source === "simulated"
  );
  const sorted = [...quotes].sort((a, b) => b.changePercent - a.changePercent);
  const gainers = sorted.filter((q) => q.changePercent > 0).slice(0, 6);
  const losers = sorted
    .filter((q) => q.changePercent < 0)
    .slice(-6)
    .reverse();

  const data = {
    country: key,
    source: liveEnabled() ? "live" : "simulated",
    updatedAt: Date.now(),
    custom: !!(customSymbols && customSymbols.length),
    count: universe.length,
    gainers,
    losers,
  };
  moversCache[cacheKey] = { ts: Date.now(), data };
  return data;
}

/* -------------------------------------------------------------------------- */
/*  Technical indicators                                                      */
/* -------------------------------------------------------------------------- */

function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function ema(values, period) {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

// Wilder's RSI
function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (values.length < slow + signalPeriod) return null;
  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  const macdLine = [];
  for (let i = 0; i < values.length; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) {
      macdLine[i] = emaFast[i] - emaSlow[i];
    }
  }
  const compact = macdLine.filter((v) => v != null);
  const signalSeries = emaSeries(compact, signalPeriod);
  const macdVal = compact[compact.length - 1];
  const signalVal = signalSeries[signalSeries.length - 1];
  const prevMacd = compact[compact.length - 2];
  const prevSignal = signalSeries[signalSeries.length - 2];
  return {
    macd: macdVal,
    signal: signalVal,
    hist: macdVal - signalVal,
    prevHist:
      prevMacd != null && prevSignal != null ? prevMacd - prevSignal : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Short-term signal engine                                                  */
/* -------------------------------------------------------------------------- */

function analyze(candles) {
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] ?? last;

  const sma10 = sma(closes, 10);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const ema9 = ema(closes, 9);
  const rsi14 = rsi(closes, 14);
  const macdData = macd(closes);

  const roc5 =
    closes.length > 5
      ? ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
      : null;

  const reasons = [];
  let score = 0; // -100 .. +100

  if (sma10 != null && sma20 != null) {
    if (sma10 > sma20) {
      score += 22;
      reasons.push({
        signal: "bullish",
        text: `SMA10 (${sma10.toFixed(2)}) is above SMA20 (${sma20.toFixed(
          2
        )}) — short-term uptrend.`,
      });
    } else {
      score -= 22;
      reasons.push({
        signal: "bearish",
        text: `SMA10 (${sma10.toFixed(2)}) is below SMA20 (${sma20.toFixed(
          2
        )}) — short-term downtrend.`,
      });
    }
  }

  if (sma20 != null) {
    if (last > sma20) {
      score += 12;
      reasons.push({
        signal: "bullish",
        text: `Price is above SMA20 — buyers in control.`,
      });
    } else {
      score -= 12;
      reasons.push({
        signal: "bearish",
        text: `Price is below SMA20 — sellers in control.`,
      });
    }
  }

  if (sma50 != null) {
    if (last > sma50) {
      score += 8;
      reasons.push({
        signal: "bullish",
        text: `Price above SMA50 — broader trend is up.`,
      });
    } else {
      score -= 8;
      reasons.push({
        signal: "bearish",
        text: `Price below SMA50 — broader trend is down.`,
      });
    }
  }

  if (rsi14 != null) {
    if (rsi14 < 30) {
      score += 20;
      reasons.push({
        signal: "bullish",
        text: `RSI ${rsi14.toFixed(1)} is oversold (<30) — potential bounce.`,
      });
    } else if (rsi14 > 70) {
      score -= 20;
      reasons.push({
        signal: "bearish",
        text: `RSI ${rsi14.toFixed(1)} is overbought (>70) — pullback risk.`,
      });
    } else if (rsi14 >= 50) {
      score += 8;
      reasons.push({
        signal: "bullish",
        text: `RSI ${rsi14.toFixed(1)} above 50 — positive momentum.`,
      });
    } else {
      score -= 8;
      reasons.push({
        signal: "bearish",
        text: `RSI ${rsi14.toFixed(1)} below 50 — weak momentum.`,
      });
    }
  }

  if (macdData?.macd != null && macdData?.signal != null) {
    if (macdData.hist > 0) {
      score += 18;
      const crossedUp =
        macdData.prevHist != null && macdData.prevHist <= 0 && macdData.hist > 0;
      reasons.push({
        signal: "bullish",
        text: crossedUp
          ? `MACD just crossed above its signal line — fresh bullish signal.`
          : `MACD is above its signal line — bullish momentum.`,
      });
    } else {
      score -= 18;
      const crossedDown =
        macdData.prevHist != null && macdData.prevHist >= 0 && macdData.hist < 0;
      reasons.push({
        signal: "bearish",
        text: crossedDown
          ? `MACD just crossed below its signal line — fresh bearish signal.`
          : `MACD is below its signal line — bearish momentum.`,
      });
    }
  }

  if (roc5 != null) {
    if (roc5 > 0) {
      score += 8;
      reasons.push({
        signal: "bullish",
        text: `Up ${roc5.toFixed(2)}% over the last 5 sessions.`,
      });
    } else {
      score -= 8;
      reasons.push({
        signal: "bearish",
        text: `Down ${Math.abs(roc5).toFixed(2)}% over the last 5 sessions.`,
      });
    }
  }

  score = Math.max(-100, Math.min(100, score));

  let recommendation;
  if (score >= 45) recommendation = "STRONG BUY";
  else if (score >= 15) recommendation = "BUY";
  else if (score > -15) recommendation = "HOLD";
  else if (score > -45) recommendation = "SELL";
  else recommendation = "STRONG SELL";

  const confidence = Math.min(100, Math.round(Math.abs(score) * 1.3));

  return {
    recommendation,
    score: Math.round(score),
    confidence,
    change: last - prev,
    changePercent: prev ? ((last - prev) / prev) * 100 : 0,
    indicators: {
      price: last,
      sma10,
      sma20,
      sma50,
      ema9,
      rsi14,
      macd: macdData?.macd ?? null,
      macdSignal: macdData?.signal ?? null,
      macdHist: macdData?.hist ?? null,
      roc5,
    },
    reasons: reasons.sort((a, b) => (a.signal < b.signal ? -1 : 1)),
  };
}

/* -------------------------------------------------------------------------- */
/*  Google authentication                                                     */
/* -------------------------------------------------------------------------- */

// In-memory session store (sessionId -> { user, ts }). Cleared on restart.
const sessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function getSession(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  return { sid, entry: s };
}

function getSessionUser(req) {
  const sess = getSession(req);
  return sess ? sess.entry.user : null;
}

// Verify a Google ID token (JWT) via Google's tokeninfo endpoint.
async function verifyGoogleCredential(credential) {
  const res = await fetchWithTimeout(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential),
    6000
  );
  const p = await res.json();
  if (!res.ok) throw new Error(p.error_description || "Invalid Google token");
  if (GOOGLE_CLIENT_ID && p.aud !== GOOGLE_CLIENT_ID)
    throw new Error("Token audience mismatch");
  if (p.email_verified === "false") throw new Error("Email not verified");
  return {
    sub: p.sub,
    name: p.name || p.given_name || p.email,
    email: p.email,
    picture: p.picture || "",
    provider: "google",
    createdAt: null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Email + password accounts (with email OTP verification)                   */
/* -------------------------------------------------------------------------- */

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

// Persistent user store: email(lowercase) -> { id, email, name, salt, hash, verified, createdAt }
let users = {};
try {
  users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) || {};
} catch {
  users = {};
}
function saveUsers() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error("Failed to save users:", e.message);
  }
}

/* -------------------------------------------------------------------------- */
/*  Per-user synced app data (portfolio, watchlists, prefs)                   */
/* -------------------------------------------------------------------------- */

const USERDATA_DIR = path.join(DATA_DIR, "userdata");

function userDataPath(sub) {
  // Safe filename from session sub (email:uuid or google numeric id).
  const safe = String(sub || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(USERDATA_DIR, safe + ".json");
}

function defaultUserData() {
  return {
    country: "US",
    watchlists: { US: null, IN: null }, // null => client uses defaults
    portfolio: { positions: {}, trades: [], realized: {} },
    chartConfig: null,
    moversUniverse: { US: null, IN: null },
    updatedAt: null,
  };
}

function loadUserData(sub) {
  try {
    const raw = JSON.parse(fs.readFileSync(userDataPath(sub), "utf8"));
    if (!raw || typeof raw !== "object") return defaultUserData();
    const base = defaultUserData();
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
      chartConfig: raw.chartConfig || null,
      moversUniverse: {
        US: Array.isArray(raw.moversUniverse?.US) ? raw.moversUniverse.US : null,
        IN: Array.isArray(raw.moversUniverse?.IN) ? raw.moversUniverse.IN : null,
      },
      updatedAt: raw.updatedAt || null,
    };
  } catch {
    return defaultUserData();
  }
}

function saveUserData(sub, data) {
  fs.mkdirSync(USERDATA_DIR, { recursive: true });
  const cleaned = {
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
  fs.writeFileSync(userDataPath(sub), JSON.stringify(cleaned, null, 2));
  return cleaned;
}

// Pending signups awaiting OTP: email -> { name, email, salt, hash, code, expires, sentAt, attempts }
const pendingSignups = new Map();
// Pending password resets: email -> { code, expires, sentAt, attempts }
const pendingResets = new Map();
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_COOLDOWN_MS = 30 * 1000;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
  } catch {
    return false;
  }
}
function genOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}
function sessionUserFromRecord(u) {
  return {
    sub: "email:" + u.id,
    name: u.name,
    email: u.email,
    picture: "",
    provider: "email",
    createdAt: u.createdAt || null,
  };
}

// Minimal SMTP client over implicit TLS (port 465). Enough to send a plain-text
// OTP email through providers like Gmail (use an App Password) or others.
function smtpSendMail({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const envelopeFrom = (SMTP_FROM.match(/<([^>]+)>/) || [null, SMTP_FROM])[1];
    const message = [
      `From: ${SMTP_FROM}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
    ].join("\r\n");

    const steps = [
      { expect: 220, cmd: null },
      { expect: 250, cmd: `EHLO ${SMTP_HOST}` },
      { expect: 334, cmd: "AUTH LOGIN" },
      { expect: 334, cmd: Buffer.from(SMTP_USER).toString("base64") },
      { expect: 235, cmd: Buffer.from(SMTP_PASS).toString("base64") },
      { expect: 250, cmd: `MAIL FROM:<${envelopeFrom}>` },
      { expect: 250, cmd: `RCPT TO:<${to}>` },
      { expect: 354, cmd: "DATA" },
      { expect: 250, cmd: message.replace(/\r\n\./g, "\r\n..") + "\r\n." },
      { expect: 221, cmd: "QUIT" },
    ];

    const socket = tls.connect(
      { host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST },
      () => {}
    );
    socket.setEncoding("utf8");
    let buffer = "";
    let i = 0;
    let done = false;

    const fail = (e) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const finish = () => {
      if (done) return;
      done = true;
      try { socket.end(); } catch {}
      resolve();
    };

    socket.on("error", fail);
    socket.setTimeout(15000, () => fail(new Error("SMTP timeout")));

    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      let resp = null;
      for (let k = lines.length - 1; k >= 0; k--) {
        const m = /^(\d{3}) /.exec(lines[k]);
        if (m) { resp = { code: Number(m[1]), line: lines[k] }; break; }
      }
      if (!resp) return; // wait for the final line of a multiline reply
      const step = steps[i];
      if (resp.code !== step.expect)
        return fail(new Error(`SMTP ${resp.code}: ${resp.line}`));
      buffer = "";
      i++;
      if (i >= steps.length) return finish();
      socket.write(steps[i].cmd + "\r\n");
    });
  });
}

async function sendOtpEmail(to, code, purpose = "verify") {
  const kind = purpose === "reset" ? "password reset" : "verification";
  const subject = `${APP_NAME} ${kind} code: ${code}`;
  const text =
    `Your ${APP_NAME} ${kind} code is: ${code}\n\n` +
    `It expires in 10 minutes. If you didn't request this, you can ignore this email.`;
  if (EMAIL_ENABLED) {
    await smtpSendMail({ to, subject, text });
  } else {
    console.log(`\n[DEV OTP] ${kind} code for ${to}: ${code}\n`);
  }
}

/* -------------------------------------------------------------------------- */
/*  HTTP helpers                                                              */
/* -------------------------------------------------------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

/* -------------------------------------------------------------------------- */
/*  Server                                                                    */
/* -------------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === "/api/config") {
      return sendJson(res, 200, {
        googleClientId: GOOGLE_CLIENT_ID || null,
        emailAuth: true,
        emailDelivery: EMAIL_ENABLED, // false => dev mode (OTP shown in response)
      });
    }

    if (pathname === "/api/me") {
      return sendJson(res, 200, { user: getSessionUser(req) });
    }

    if (pathname === "/api/auth/google" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.credential)
        return sendJson(res, 400, { error: "Missing credential" });
      try {
        const user = await verifyGoogleCredential(body.credential);
        const sid = crypto.randomUUID();
        sessions.set(sid, { user, ts: Date.now() });
        res.setHeader(
          "Set-Cookie",
          `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
            SESSION_TTL_MS / 1000
          )}`
        );
        return sendJson(res, 200, { user });
      } catch (err) {
        return sendJson(res, 401, { error: err.message });
      }
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const sid = parseCookies(req).sid;
      if (sid) sessions.delete(sid);
      res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/auth/signup" && req.method === "POST") {
      const body = await readJsonBody(req);
      const name = String(body.name || "").trim().slice(0, 80);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      if (!name) return sendJson(res, 400, { error: "Name is required" });
      if (!validEmail(email))
        return sendJson(res, 400, { error: "Enter a valid email address" });
      if (password.length < 6)
        return sendJson(res, 400, { error: "Password must be at least 6 characters" });
      if (users[email] && users[email].verified)
        return sendJson(res, 409, { error: "An account with this email already exists. Please sign in." });

      const { salt, hash } = hashPassword(password);
      const code = genOtp();
      pendingSignups.set(email, {
        name,
        email,
        salt,
        hash,
        code,
        expires: Date.now() + OTP_TTL_MS,
        sentAt: Date.now(),
        attempts: 0,
      });
      try {
        await sendOtpEmail(email, code);
      } catch (err) {
        pendingSignups.delete(email);
        return sendJson(res, 502, { error: "Could not send verification email: " + err.message });
      }
      return sendJson(res, 200, {
        pending: true,
        email,
        emailDelivery: EMAIL_ENABLED,
        devOtp: EMAIL_ENABLED ? undefined : code,
      });
    }

    if (pathname === "/api/auth/resend-otp" && req.method === "POST") {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const pending = pendingSignups.get(email);
      if (!pending)
        return sendJson(res, 404, { error: "No pending signup for this email. Please sign up again." });
      if (Date.now() - pending.sentAt < RESEND_COOLDOWN_MS)
        return sendJson(res, 429, { error: "Please wait a few seconds before requesting another code." });
      pending.code = genOtp();
      pending.expires = Date.now() + OTP_TTL_MS;
      pending.sentAt = Date.now();
      pending.attempts = 0;
      try {
        await sendOtpEmail(email, pending.code);
      } catch (err) {
        return sendJson(res, 502, { error: "Could not send verification email: " + err.message });
      }
      return sendJson(res, 200, {
        pending: true,
        email,
        emailDelivery: EMAIL_ENABLED,
        devOtp: EMAIL_ENABLED ? undefined : pending.code,
      });
    }

    if (pathname === "/api/auth/verify-otp" && req.method === "POST") {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const code = String(body.code || "").trim();
      const pending = pendingSignups.get(email);
      if (!pending)
        return sendJson(res, 404, { error: "No pending signup. Please sign up again." });
      if (Date.now() > pending.expires) {
        pendingSignups.delete(email);
        return sendJson(res, 410, { error: "Code expired. Please request a new one." });
      }
      if (pending.attempts >= 6) {
        pendingSignups.delete(email);
        return sendJson(res, 429, { error: "Too many attempts. Please sign up again." });
      }
      pending.attempts++;
      if (code !== pending.code)
        return sendJson(res, 401, { error: "Incorrect code. Please try again." });

      const user = {
        id: crypto.randomUUID(),
        email,
        name: pending.name,
        salt: pending.salt,
        hash: pending.hash,
        verified: true,
        createdAt: Date.now(),
      };
      users[email] = user;
      saveUsers();
      pendingSignups.delete(email);

      const sid = crypto.randomUUID();
      const sessionUser = sessionUserFromRecord(user);
      sessions.set(sid, { user: sessionUser, ts: Date.now() });
      res.setHeader(
        "Set-Cookie",
        `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
      );
      return sendJson(res, 200, { user: sessionUser });
    }

    if (pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      const user = users[email];
      if (!user || !user.verified || !verifyPassword(password, user.salt, user.hash))
        return sendJson(res, 401, { error: "Invalid email or password" });

      const sid = crypto.randomUUID();
      const sessionUser = sessionUserFromRecord(user);
      sessions.set(sid, { user: sessionUser, ts: Date.now() });
      res.setHeader(
        "Set-Cookie",
        `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
      );
      return sendJson(res, 200, { user: sessionUser });
    }

    if (pathname === "/api/profile" && req.method === "POST") {
      const sess = getSession(req);
      if (!sess) return sendJson(res, 401, { error: "Not signed in" });
      const body = await readJsonBody(req);
      const name = String(body.name || "").trim().slice(0, 80);
      if (!name) return sendJson(res, 400, { error: "Name cannot be empty" });
      const u = sess.entry.user;
      u.name = name; // update the live session copy
      if (u.provider === "email" && users[u.email]) {
        users[u.email].name = name;
        saveUsers();
      }
      return sendJson(res, 200, { user: u });
    }

    if (pathname === "/api/auth/change-password" && req.method === "POST") {
      const sess = getSession(req);
      if (!sess) return sendJson(res, 401, { error: "Not signed in" });
      const u = sess.entry.user;
      if (u.provider !== "email")
        return sendJson(res, 400, { error: "Password change is only for email accounts" });
      const body = await readJsonBody(req);
      const current = String(body.currentPassword || "");
      const next = String(body.newPassword || "");
      const rec = users[u.email];
      if (!rec || !verifyPassword(current, rec.salt, rec.hash))
        return sendJson(res, 401, { error: "Current password is incorrect" });
      if (next.length < 6)
        return sendJson(res, 400, { error: "New password must be at least 6 characters" });
      const { salt, hash } = hashPassword(next);
      rec.salt = salt;
      rec.hash = hash;
      saveUsers();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/userdata" && req.method === "GET") {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: "Not signed in" });
      return sendJson(res, 200, { data: loadUserData(user.sub) });
    }

    if (pathname === "/api/userdata" && (req.method === "PUT" || req.method === "POST")) {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: "Not signed in" });
      const body = await readJsonBody(req);
      const saved = saveUserData(user.sub, body.data || body);
      return sendJson(res, 200, { data: saved });
    }

    if (pathname === "/api/auth/forgot-password" && req.method === "POST") {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const rec = users[email];
      if (!rec || !rec.verified)
        return sendJson(res, 404, { error: "No account found with that email." });
      const code = genOtp();
      pendingResets.set(email, {
        code,
        expires: Date.now() + OTP_TTL_MS,
        sentAt: Date.now(),
        attempts: 0,
      });
      try {
        await sendOtpEmail(email, code, "reset");
      } catch (err) {
        pendingResets.delete(email);
        return sendJson(res, 502, { error: "Could not send reset email: " + err.message });
      }
      return sendJson(res, 200, {
        ok: true,
        email,
        emailDelivery: EMAIL_ENABLED,
        devOtp: EMAIL_ENABLED ? undefined : code,
      });
    }

    if (pathname === "/api/auth/reset-password" && req.method === "POST") {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const code = String(body.code || "").trim();
      const newPassword = String(body.newPassword || "");
      const pending = pendingResets.get(email);
      const rec = users[email];
      if (!pending || !rec)
        return sendJson(res, 404, { error: "No reset request found. Please start again." });
      if (Date.now() > pending.expires) {
        pendingResets.delete(email);
        return sendJson(res, 410, { error: "Code expired. Please request a new one." });
      }
      if (pending.attempts >= 6) {
        pendingResets.delete(email);
        return sendJson(res, 429, { error: "Too many attempts. Please start again." });
      }
      pending.attempts++;
      if (code !== pending.code)
        return sendJson(res, 401, { error: "Incorrect code. Please try again." });
      if (newPassword.length < 6)
        return sendJson(res, 400, { error: "New password must be at least 6 characters" });

      const { salt, hash } = hashPassword(newPassword);
      rec.salt = salt;
      rec.hash = hash;
      saveUsers();
      pendingResets.delete(email);

      // Log the user straight in after a successful reset.
      const sid = crypto.randomUUID();
      const sessionUser = sessionUserFromRecord(rec);
      sessions.set(sid, { user: sessionUser, ts: Date.now() });
      res.setHeader(
        "Set-Cookie",
        `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
      );
      return sendJson(res, 200, { user: sessionUser });
    }

    if (pathname === "/api/search") {
      const query = (url.searchParams.get("q") || "").trim();
      const country = url.searchParams.get("country") || "";
      if (!query) return sendJson(res, 200, []);
      return sendJson(res, 200, await search(query, country));
    }

    if (pathname === "/api/movers") {
      const country = url.searchParams.get("country") || "US";
      const symbolsParam = (url.searchParams.get("symbols") || "").trim();
      const custom = symbolsParam
        ? symbolsParam
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
            .slice(0, 40)
        : null;
      return sendJson(res, 200, await getMovers(country, custom));
    }

    if (pathname.startsWith("/api/quote/")) {
      const symbol = decodeURIComponent(pathname.slice("/api/quote/".length)).toUpperCase();
      if (!symbol) return sendJson(res, 400, { error: "Missing symbol" });
      const range = url.searchParams.get("range") || "6mo";
      const interval = url.searchParams.get("interval") || "1d";
      const { meta, candles, source } = await getChart(symbol, range, interval);
      if (candles.length < 2)
        return sendJson(res, 500, { error: "Not enough data to analyze" });

      const analysis = analyze(candles);
      return sendJson(res, 200, {
        symbol,
        name: meta.longName || meta.shortName || symbol,
        currency: meta.currency || "USD",
        exchange: meta.fullExchangeName || meta.exchangeName || "",
        marketState: meta.marketState || "",
        source,
        price: meta.regularMarketPrice ?? analysis.indicators.price,
        previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
        dayHigh: meta.regularMarketDayHigh ?? null,
        dayLow: meta.regularMarketDayLow ?? null,
        updatedAt: Date.now(),
        analysis,
        candles: candles.slice(-120),
      });
    }

    return serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Stock monitor running at http://localhost:${PORT}`);
});
