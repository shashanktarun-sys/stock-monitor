/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

const DEFAULT_WATCHLISTS = {
  US: ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"],
  IN: ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS"],
};

// Signed-in Google user (null = guest). Storage is namespaced per user so
// different accounts keep separate watchlists / portfolios in the same browser.
let currentUser = null;

function storageKey(name) {
  return (currentUser ? "u_" + currentUser.sub : "guest") + "::" + name;
}

const state = {
  user: null,
  country: loadCountry(),
  watchlist: [],
  universe: [],
  quotes: {}, // symbol -> quote payload
  selected: null,
  page: "market",
  marketView: "watchlist",
  refreshMs: 30000,
  timer: null,
  recoFilter: "ALL",
  capFilter: "ALL",
  sortBy: "symbol",
  chart: loadChartConfig(),
  portfolio: loadPortfolio(),
  pnlPeriod: loadPnlPeriod(),
  signalAlerts: loadSignalAlerts(),
};
state.watchlist = loadWatchlist(state.country);

function loadPortfolio() {
  const empty = { positions: {}, trades: [], realized: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey("portfolio")));
    if (saved && saved.positions)
      return {
        positions: saved.positions || {},
        trades: saved.trades || [],
        realized: saved.realized || {},
      };
  } catch {}
  return empty;
}

function savePortfolio() {
  localStorage.setItem(storageKey("portfolio"), JSON.stringify(state.portfolio));
  scheduleServerSync();
}

function loadSignalAlerts() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey("signalAlerts")));
    if (saved && typeof saved === "object") return saved;
  } catch {}
  return {};
}

function saveSignalAlerts() {
  localStorage.setItem(storageKey("signalAlerts"), JSON.stringify(state.signalAlerts));
}

function buyStock(symbol, qty, price, currency, name, signal, industryInfo) {
  qty = Math.floor(qty);
  if (!(qty > 0) || !(price > 0)) return;
  const p = state.portfolio;
  const pos = p.positions[symbol] || { qty: 0, avgCost: 0, currency, name };
  const newQty = pos.qty + qty;
  pos.avgCost = (pos.qty * pos.avgCost + qty * price) / newQty;
  pos.qty = newQty;
  pos.currency = currency;
  pos.name = name || pos.name || symbol;
  // Remember the Pulse signal at the time of the (latest) buy.
  if (signal && signal.recommendation) {
    pos.buySignal = signal.recommendation;
    pos.buyScore = signal.score;
  }
  if (industryInfo) {
    if (industryInfo.industry) pos.industry = industryInfo.industry;
    if (industryInfo.sector) pos.sector = industryInfo.sector;
    if (industryInfo.capLabel) pos.capLabel = industryInfo.capLabel;
  }
  p.positions[symbol] = pos;
  p.trades.unshift({
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
  });
  delete state.signalAlerts[symbol];
  savePortfolio();
  saveSignalAlerts();
}

function sellStock(symbol, qty, price, currency, signal) {
  const p = state.portfolio;
  const pos = p.positions[symbol];
  if (!pos) return null;
  qty = Math.min(Math.floor(qty), pos.qty);
  if (!(qty > 0)) return null;
  const realized = (price - pos.avgCost) * qty;
  p.realized[currency] = (p.realized[currency] || 0) + realized;
  pos.qty -= qty;
  p.trades.unshift({
    symbol,
    side: "SELL",
    qty,
    price,
    currency,
    realized,
    ts: Date.now(),
    signal: signal ? signal.recommendation : null,
    score: signal ? signal.score : null,
  });
  if (pos.qty <= 0) delete p.positions[symbol];
  if (!p.positions[symbol]) delete state.signalAlerts[symbol];
  savePortfolio();
  saveSignalAlerts();
  return { realized, currency, qty, price };
}

/* -------------------------------------------------------------------------- */
/*  Portfolio P&L period                                                      */
/* -------------------------------------------------------------------------- */

function loadPnlPeriod() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey("pnlPeriod")));
    if (saved && saved.key) {
      return {
        key: saved.key,
        from: saved.from || "",
        to: saved.to || "",
      };
    }
  } catch {}
  return { key: "all", from: "", to: "" };
}

function savePnlPeriod() {
  localStorage.setItem(storageKey("pnlPeriod"), JSON.stringify(state.pnlPeriod));
}

/** Start-of-local-day ms for a Date. */
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** End-of-local-day ms for a Date. */
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.getTime();
}

/**
 * Resolve selected P&L period to [start, end] ms.
 * null start/end means unbounded (All).
 */
function getPnlRange() {
  const { key, from, to } = state.pnlPeriod;
  const now = new Date();
  if (key === "all") return { start: null, end: null, label: "All time" };
  if (key === "1d") {
    return { start: startOfDay(now), end: endOfDay(now), label: "Today" };
  }
  if (key === "7d" || key === "30d" || key === "90d") {
    const days = key === "7d" ? 7 : key === "30d" ? 30 : 90;
    const start = startOfDay(new Date(now.getTime() - (days - 1) * 86400000));
    return { start, end: endOfDay(now), label: `Last ${days} days` };
  }
  if (key === "ytd") {
    return {
      start: startOfDay(new Date(now.getFullYear(), 0, 1)),
      end: endOfDay(now),
      label: `YTD ${now.getFullYear()}`,
    };
  }
  if (key === "custom") {
    if (!from && !to) return { start: null, end: null, label: "Custom (pick dates)" };
    const start = from ? startOfDay(new Date(from + "T00:00:00")) : null;
    const end = to ? endOfDay(new Date(to + "T00:00:00")) : endOfDay(now);
    const label =
      (from || "…") + " → " + (to || "today");
    return { start, end, label };
  }
  return { start: null, end: null, label: "All time" };
}

function tradeInRange(t, start, end) {
  if (start != null && t.ts < start) return false;
  if (end != null && t.ts > end) return false;
  return true;
}

/** Realized P&L + trade stats for sells in the period, per currency. */
function periodStats(trades, start, end) {
  const byCcy = {};
  let sells = 0;
  let buys = 0;
  let wins = 0;
  let losses = 0;
  for (const t of trades) {
    if (!tradeInRange(t, start, end)) continue;
    if (t.side === "BUY") buys += 1;
    if (t.side !== "SELL") continue;
    sells += 1;
    const c = t.currency || "USD";
    if (!byCcy[c]) byCcy[c] = { realized: 0, sells: 0, wins: 0, losses: 0 };
    const r = Number(t.realized) || 0;
    byCcy[c].realized += r;
    byCcy[c].sells += 1;
    if (r > 0) {
      byCcy[c].wins += 1;
      wins += 1;
    } else if (r < 0) {
      byCcy[c].losses += 1;
      losses += 1;
    }
  }
  return { byCcy, sells, buys, wins, losses };
}

function syncPnlPeriodUI() {
  const bar = document.getElementById("pnlPeriodBar");
  if (!bar) return;
  bar.querySelectorAll(".pnl-period-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.period === state.pnlPeriod.key);
  });
  const custom = document.getElementById("pnlCustomRange");
  if (custom) {
    custom.classList.toggle("hidden", state.pnlPeriod.key !== "custom");
  }
  const fromEl = document.getElementById("pnlFrom");
  const toEl = document.getElementById("pnlTo");
  if (fromEl && state.pnlPeriod.from) fromEl.value = state.pnlPeriod.from;
  if (toEl && state.pnlPeriod.to) toEl.value = state.pnlPeriod.to;
}

function loadChartConfig() {
  const defaults = {
    type: "line", // line | candle
    overlays: { sma10: false, sma20: true, sma50: false, ema9: false, boll: false },
    pane: "none", // none | rsi | macd | volume
  };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey("chartConfig")));
    if (saved && saved.overlays)
      return {
        type: saved.type === "candle" ? "candle" : "line",
        overlays: { ...defaults.overlays, ...saved.overlays },
        pane: saved.pane || "none",
      };
  } catch {}
  return defaults;
}

function saveChartConfig() {
  localStorage.setItem(storageKey("chartConfig"), JSON.stringify(state.chart));
  scheduleServerSync();
}

function loadCountry() {
  const c = localStorage.getItem(storageKey("country"));
  return c === "IN" || c === "US" ? c : "US";
}

function saveCountry() {
  localStorage.setItem(storageKey("country"), state.country);
  scheduleServerSync();
}

function loadWatchlist(country) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(`watchlist:${country}`)));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return [...DEFAULT_WATCHLISTS[country]];
}

function saveWatchlist() {
  localStorage.setItem(
    storageKey(`watchlist:${state.country}`),
    JSON.stringify(state.watchlist)
  );
  scheduleServerSync();
}

function loadMoversUniverse(country) {
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey(`moversUniverse:${country}`))
    );
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return null; // null => use the server's default universe
}

function saveMoversUniverse(country, arr) {
  if (arr && arr.length)
    localStorage.setItem(storageKey(`moversUniverse:${country}`), JSON.stringify(arr));
  else localStorage.removeItem(storageKey(`moversUniverse:${country}`));
  scheduleServerSync();
}

/* --------------------------- Server sync (signed-in) --------------------- */

let syncTimer = null;
let syncInFlight = false;

function buildSyncPayload() {
  // Snapshot current country watchlist into the full watchlists map.
  const wlUS =
    state.country === "US"
      ? state.watchlist
      : JSON.parse(localStorage.getItem(storageKey("watchlist:US")) || "null");
  const wlIN =
    state.country === "IN"
      ? state.watchlist
      : JSON.parse(localStorage.getItem(storageKey("watchlist:IN")) || "null");
  return {
    country: state.country,
    watchlists: {
      US: Array.isArray(wlUS) ? wlUS : state.country === "US" ? state.watchlist : null,
      IN: Array.isArray(wlIN) ? wlIN : state.country === "IN" ? state.watchlist : null,
    },
    portfolio: state.portfolio,
    chartConfig: state.chart,
    moversUniverse: {
      US: loadMoversUniverse("US"),
      IN: loadMoversUniverse("IN"),
    },
  };
}

function applyServerData(data) {
  if (!data) return;
  if (data.country === "IN" || data.country === "US") {
    state.country = data.country;
    localStorage.setItem(storageKey("country"), state.country);
  }
  if (data.watchlists) {
    ["US", "IN"].forEach((c) => {
      if (Array.isArray(data.watchlists[c]) && data.watchlists[c].length) {
        localStorage.setItem(
          storageKey(`watchlist:${c}`),
          JSON.stringify(data.watchlists[c])
        );
      }
    });
  }
  state.watchlist = loadWatchlist(state.country);

  if (data.portfolio && data.portfolio.positions) {
    state.portfolio = {
      positions: data.portfolio.positions || {},
      trades: data.portfolio.trades || [],
      realized: data.portfolio.realized || {},
    };
    localStorage.setItem(storageKey("portfolio"), JSON.stringify(state.portfolio));
  }

  if (data.chartConfig && data.chartConfig.overlays) {
    const defaults = {
      type: "line",
      overlays: { sma10: false, sma20: true, sma50: false, ema9: false, boll: false },
      pane: "none",
    };
    state.chart = {
      type: data.chartConfig.type === "candle" ? "candle" : "line",
      overlays: { ...defaults.overlays, ...data.chartConfig.overlays },
      pane: data.chartConfig.pane || "none",
    };
    localStorage.setItem(storageKey("chartConfig"), JSON.stringify(state.chart));
  }

  if (data.moversUniverse) {
    ["US", "IN"].forEach((c) => {
      const arr = data.moversUniverse[c];
      if (Array.isArray(arr) && arr.length) {
        localStorage.setItem(storageKey(`moversUniverse:${c}`), JSON.stringify(arr));
      } else {
        localStorage.removeItem(storageKey(`moversUniverse:${c}`));
      }
    });
  }
}

function hasServerSideData(data) {
  if (!data) return false;
  const hasWl =
    (Array.isArray(data.watchlists?.US) && data.watchlists.US.length) ||
    (Array.isArray(data.watchlists?.IN) && data.watchlists.IN.length);
  const hasPf =
    data.portfolio &&
    (Object.keys(data.portfolio.positions || {}).length > 0 ||
      (data.portfolio.trades || []).length > 0);
  return Boolean(hasWl || hasPf || data.updatedAt);
}

async function pullServerData() {
  if (!currentUser) return null;
  try {
    const r = await fetch("/api/userdata");
    if (!r.ok) return null;
    const json = await r.json();
    return json.data || null;
  } catch {
    return null;
  }
}

async function pushServerData() {
  if (!currentUser || syncInFlight) return;
  syncInFlight = true;
  try {
    await fetch("/api/userdata", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: buildSyncPayload() }),
    });
  } catch {
    // Offline / network — localStorage still has the latest copy.
  } finally {
    syncInFlight = false;
  }
}

function scheduleServerSync() {
  if (!currentUser) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    pushServerData();
  }, 600);
}

// Flush pending sync when the tab goes to background.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && currentUser) {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    pushServerData();
  }
});

async function syncOnLogin() {
  if (!currentUser) return;
  const remote = await pullServerData();
  if (hasServerSideData(remote)) {
    applyServerData(remote);
  } else {
    // First sync for this account: prefer this account's local cache, then upload.
    state.country = loadCountry();
    state.watchlist = loadWatchlist(state.country);
    state.chart = loadChartConfig();
    state.portfolio = loadPortfolio();
    state.pnlPeriod = loadPnlPeriod();
    await pushServerData();
  }
}

/* -------------------------------------------------------------------------- */
/*  Elements                                                                  */
/* -------------------------------------------------------------------------- */

const el = {
  search: document.getElementById("search"),
  suggestions: document.getElementById("suggestions"),
  marketPage: document.getElementById("marketPage"),
  portfolioPage: document.getElementById("portfolioPage"),
  newsPage: document.getElementById("newsPage"),
  country: document.getElementById("country"),
  marketHours: document.getElementById("marketHours"),
  interval: document.getElementById("interval"),
  status: document.getElementById("status"),
  watchlist: document.getElementById("watchlist"),
  recoFilter: document.getElementById("recoFilter"),
  capFilter: document.getElementById("capFilter"),
  sortFilter: document.getElementById("sortFilter"),
  filterCount: document.getElementById("filterCount"),
  refreshAll: document.getElementById("refreshAll"),
  tabWatchlist: document.getElementById("tabWatchlist"),
  tabAllStocks: document.getElementById("tabAllStocks"),
  emptyState: document.getElementById("emptyState"),
  detailContent: document.getElementById("detailContent"),
  gainersList: document.getElementById("gainersList"),
  losersList: document.getElementById("losersList"),
  moversConfig: document.getElementById("moversConfig"),
  moversEditor: document.getElementById("moversEditor"),
  moversInput: document.getElementById("moversInput"),
  moversSave: document.getElementById("moversSave"),
  moversUseWatchlist: document.getElementById("moversUseWatchlist"),
  moversReset: document.getElementById("moversReset"),
  moversCancel: document.getElementById("moversCancel"),
  moversMeta: document.getElementById("moversMeta"),
  portfolioSummary: document.getElementById("portfolioSummary"),
  portfolioHoldings: document.getElementById("portfolioHoldings"),
  tradeHistory: document.getElementById("tradeHistory"),
  tradeHistoryMeta: document.getElementById("tradeHistoryMeta"),
  portfolioReset: document.getElementById("portfolioReset"),
  portfolioPanel: document.getElementById("portfolioPanel"),
  portfolioTraderType: document.getElementById("portfolioTraderType"),
  pnlPeriodBar: document.getElementById("pnlPeriodBar"),
  pnlCustomRange: document.getElementById("pnlCustomRange"),
  pnlFrom: document.getElementById("pnlFrom"),
  pnlTo: document.getElementById("pnlTo"),
  pnlCustomApply: document.getElementById("pnlCustomApply"),
  navMarket: document.getElementById("navMarket"),
  navPortfolio: document.getElementById("navPortfolio"),
  navNews: document.getElementById("navNews"),
  navPnl: document.getElementById("navPnl"),
  newsPanel: document.getElementById("newsPanel"),
  newsRefresh: document.getElementById("newsRefresh"),
  newsMeta: document.getElementById("newsMeta"),
  newsCountryBoard: document.getElementById("newsCountryBoard"),
  newsIndustryBoard: document.getElementById("newsIndustryBoard"),
  newsStockBoard: document.getElementById("newsStockBoard"),
  newsFeed: document.getElementById("newsFeed"),
  enableAlertsBtn: document.getElementById("enableAlertsBtn"),
  signInNav: document.getElementById("signInNav"),
  userChip: document.getElementById("userChip"),
  userAvatar: document.getElementById("userAvatar"),
  userName: document.getElementById("userName"),
  signOutBtn: document.getElementById("signOutBtn"),
  loginOverlay: document.getElementById("loginOverlay"),
  googleBtn: document.getElementById("googleBtn"),
  googleUnavailable: document.getElementById("googleUnavailable"),
  guestBtn: document.getElementById("guestBtn"),
  // Auth views
  viewSignin: document.getElementById("viewSignin"),
  viewSignup: document.getElementById("viewSignup"),
  viewVerify: document.getElementById("viewVerify"),
  loginForm: document.getElementById("loginForm"),
  loginEmail: document.getElementById("loginEmail"),
  loginPassword: document.getElementById("loginPassword"),
  loginError: document.getElementById("loginError"),
  loginSubmit: document.getElementById("loginSubmit"),
  toSignup: document.getElementById("toSignup"),
  signupForm: document.getElementById("signupForm"),
  signupName: document.getElementById("signupName"),
  signupEmail: document.getElementById("signupEmail"),
  signupPassword: document.getElementById("signupPassword"),
  signupError: document.getElementById("signupError"),
  signupSubmit: document.getElementById("signupSubmit"),
  toSignin: document.getElementById("toSignin"),
  verifyForm: document.getElementById("verifyForm"),
  verifyEmail: document.getElementById("verifyEmail"),
  verifyCode: document.getElementById("verifyCode"),
  verifyError: document.getElementById("verifyError"),
  verifySubmit: document.getElementById("verifySubmit"),
  devOtpNote: document.getElementById("devOtpNote"),
  resendOtp: document.getElementById("resendOtp"),
  backToSignup: document.getElementById("backToSignup"),
  // Reset password
  toReset: document.getElementById("toReset"),
  viewReset: document.getElementById("viewReset"),
  resetForm: document.getElementById("resetForm"),
  resetEmail: document.getElementById("resetEmail"),
  resetSendBtn: document.getElementById("resetSendBtn"),
  resetStep2: document.getElementById("resetStep2"),
  resetCode: document.getElementById("resetCode"),
  resetNewPw: document.getElementById("resetNewPw"),
  resetSubmit: document.getElementById("resetSubmit"),
  resetDevOtp: document.getElementById("resetDevOtp"),
  resetError: document.getElementById("resetError"),
  backToSignin: document.getElementById("backToSignin"),
  // Profile
  profileBtn: document.getElementById("profileBtn"),
  profileOverlay: document.getElementById("profileOverlay"),
  profileClose: document.getElementById("profileClose"),
  profileAvatar: document.getElementById("profileAvatar"),
  profileName: document.getElementById("profileName"),
  profileEmail: document.getElementById("profileEmail"),
  profileProvider: document.getElementById("profileProvider"),
  profileSince: document.getElementById("profileSince"),
  pdName: document.getElementById("pdName"),
  pdEmail: document.getElementById("pdEmail"),
  pdProvider: document.getElementById("pdProvider"),
  pdSince: document.getElementById("pdSince"),
  pdId: document.getElementById("pdId"),
  pdWatch: document.getElementById("pdWatch"),
  pdHoldings: document.getElementById("pdHoldings"),
  pdTrades: document.getElementById("pdTrades"),
  pdTraderType: document.getElementById("pdTraderType"),
  traderClassBadge: document.getElementById("traderClassBadge"),
  traderClassSummary: document.getElementById("traderClassSummary"),
  traderClassTraits: document.getElementById("traderClassTraits"),
  traderClassCard: document.getElementById("traderClassCard"),
  statWatch: document.getElementById("statWatch"),
  statHoldings: document.getElementById("statHoldings"),
  statTrades: document.getElementById("statTrades"),
  statRealized: document.getElementById("statRealized"),
  profileEditWrap: document.getElementById("profileEditWrap"),
  profileNameForm: document.getElementById("profileNameForm"),
  profileNameInput: document.getElementById("profileNameInput"),
  profileNameMsg: document.getElementById("profileNameMsg"),
  profileNameSave: document.getElementById("profileNameSave"),
  profilePwWrap: document.getElementById("profilePwWrap"),
  profilePwForm: document.getElementById("profilePwForm"),
  pwCurrent: document.getElementById("pwCurrent"),
  pwNew: document.getElementById("pwNew"),
  profilePwMsg: document.getElementById("profilePwMsg"),
  profilePwSave: document.getElementById("profilePwSave"),
  profileResetPw: document.getElementById("profileResetPw"),
  profileResetBox: document.getElementById("profileResetBox"),
  profileResetEmail: document.getElementById("profileResetEmail"),
  profileResetSend: document.getElementById("profileResetSend"),
  profileResetStep2: document.getElementById("profileResetStep2"),
  profileResetCode: document.getElementById("profileResetCode"),
  profileResetNewPw: document.getElementById("profileResetNewPw"),
  profileResetConfirm: document.getElementById("profileResetConfirm"),
  profileResetDev: document.getElementById("profileResetDev"),
  profileResetMsg: document.getElementById("profileResetMsg"),
  profileSignOut: document.getElementById("profileSignOut"),
};

function getInitialPage() {
  const h = window.location.hash;
  if (h === "#portfolio") return "portfolio";
  if (h === "#news") return "news";
  return "market";
}

function setPage(page, pushHash = true) {
  if (page === "portfolio") state.page = "portfolio";
  else if (page === "news") state.page = "news";
  else state.page = "market";
  el.marketPage?.classList.toggle("hidden", state.page !== "market");
  el.portfolioPage?.classList.toggle("hidden", state.page !== "portfolio");
  el.newsPage?.classList.toggle("hidden", state.page !== "news");
  el.navMarket?.classList.toggle("active", state.page === "market");
  el.navPortfolio?.classList.toggle("active", state.page === "portfolio");
  el.navNews?.classList.toggle("active", state.page === "news");
  if (pushHash) {
    const hash =
      state.page === "portfolio" ? "#portfolio" : state.page === "news" ? "#news" : "#market";
    if (window.location.hash !== hash) {
      window.history.replaceState(null, "", hash);
    }
  }
  if (state.page === "news") refreshNews();
}

function updateAlertsUI() {
  if (!el.enableAlertsBtn) return;
  const supported = "Notification" in window;
  const permission = supported ? Notification.permission : "denied";
  el.enableAlertsBtn.classList.toggle("hidden", !supported || permission === "granted");
  if (permission === "denied") {
    el.enableAlertsBtn.textContent = "🔕 Alerts blocked";
    el.enableAlertsBtn.disabled = true;
    el.enableAlertsBtn.title = "Browser notifications are blocked for this site.";
  } else {
    el.enableAlertsBtn.textContent = "🔔 Enable alerts";
    el.enableAlertsBtn.disabled = false;
    el.enableAlertsBtn.title = "Enable browser alerts for opposite signal changes on held stocks.";
  }
}

function isBullishSignal(sig) {
  return sig === "BUY" || sig === "STRONG BUY";
}

function isBearishSignal(sig) {
  return sig === "SELL" || sig === "STRONG SELL";
}

function signalIsOpposite(buySignal, currentSignal) {
  return (
    (isBullishSignal(buySignal) && isBearishSignal(currentSignal)) ||
    (isBearishSignal(buySignal) && isBullishSignal(currentSignal))
  );
}

async function sendBrowserNotification(title, body, tag) {
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.showNotification(title, {
          body,
          tag,
          badge: "/icons/icon-1024.png",
          icon: "/icons/icon-1024.png",
        });
        return true;
      }
    }
    new Notification(title, {
      body,
      tag,
      icon: "/icons/icon-1024.png",
    });
    return true;
  } catch {
    return false;
  }
}

async function maybeNotifySignalReversal() {
  const positions = state.portfolio.positions || {};
  let dirty = false;
  for (const [symbol, pos] of Object.entries(positions)) {
    const currentSignal = state.quotes[symbol]?.analysis?.recommendation || null;
    const buySignal = pos.buySignal || null;
    if (!buySignal || !currentSignal) continue;

    const key = `${buySignal}=>${currentSignal}`;
    if (signalIsOpposite(buySignal, currentSignal)) {
      if (state.signalAlerts[symbol] !== key) {
        const body =
          `${symbol.replace(".NS", "")} flipped from your buy-time ${buySignal} signal to ${currentSignal}. ` +
          `Current price: ${money(state.quotes[symbol]?.price, pos.currency)}.`;
        const sent = await sendBrowserNotification("Pulse signal reversal", body, `signal-${symbol}`);
        if (!sent) {
          showTradeToast(
            `Alert: ${symbol.replace(".NS", "")} moved from <b>${buySignal}</b> to <b>${currentSignal}</b>.`
          );
        }
        state.signalAlerts[symbol] = key;
        dirty = true;
      }
    } else if (state.signalAlerts[symbol]) {
      delete state.signalAlerts[symbol];
      dirty = true;
    }
  }
  if (dirty) saveSignalAlerts();
}

el.navMarket?.addEventListener("click", () => setPage("market"));
el.navPortfolio.addEventListener("click", () => {
  setPage("portfolio");
  el.portfolioPanel.classList.add("flash");
  setTimeout(() => el.portfolioPanel.classList.remove("flash"), 1200);
});
el.navNews?.addEventListener("click", () => setPage("news"));
el.enableAlertsBtn?.addEventListener("click", async () => {
  if (!("Notification" in window)) return;
  try {
    await Notification.requestPermission();
  } catch {}
  updateAlertsUI();
  if (Notification.permission === "granted") {
    maybeNotifySignalReversal();
  }
});
window.addEventListener("hashchange", () => setPage(getInitialPage(), false));

/* -------------------------------------------------------------------------- */
/*  Formatting helpers                                                        */
/* -------------------------------------------------------------------------- */

const fmt = (n, d = 2) =>
  n == null || Number.isNaN(n)
    ? "—"
    : Number(n).toLocaleString(undefined, {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });

const CCY_SYMBOL = { USD: "$", INR: "₹", EUR: "€", GBP: "£", JPY: "¥" };

const money = (n, ccy, d = 2) =>
  n == null || Number.isNaN(n) ? "—" : (CCY_SYMBOL[ccy] || "") + fmt(n, d);

const signedMoney = (n, ccy, d = 2) =>
  (n >= 0 ? "+" : "−") + (CCY_SYMBOL[ccy] || "") + fmt(Math.abs(n), d);

const signedPct = (n, d = 2) => (n >= 0 ? "+" : "−") + fmt(Math.abs(n), d) + "%";

const badgeClass = (reco) => reco.toLowerCase().replace(/\s+/g, "-");

const signColor = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");

const arrow = (n) => (n > 0 ? "▲" : n < 0 ? "▼" : "•");

/* -------------------------------------------------------------------------- */
/*  Market open / closed                                                      */
/* -------------------------------------------------------------------------- */

function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // some engines emit 24:00
  return {
    weekday: get("weekday"),
    minutes: hour * 60 + Number(get("minute")),
  };
}

function formatLocalClock(date, timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getMarketSession(country, now = new Date()) {
  const isIndia = country === "IN";
  const timeZone = isIndia ? "Asia/Kolkata" : "America/New_York";
  const { weekday, minutes } = getZonedParts(now, timeZone);
  const weekend = weekday === "Sat" || weekday === "Sun";
  const open = isIndia ? 9 * 60 + 15 : 9 * 60 + 30;
  const close = isIndia ? 15 * 60 + 30 : 16 * 60;
  const preOpen = isIndia ? 9 * 60 : 4 * 60;
  const postClose = isIndia ? 15 * 60 + 30 : 20 * 60;
  const label = isIndia ? "NSE" : "NYSE/Nasdaq";
  const local = formatLocalClock(now, timeZone);

  if (weekend) {
    return {
      code: "closed",
      label: `${label} Closed`,
      detail: `Weekend · local ${local}`,
      open: false,
    };
  }
  if (minutes >= open && minutes < close) {
    return {
      code: "open",
      label: `${label} Open`,
      detail: `Regular session · local ${local}`,
      open: true,
    };
  }
  if (!isIndia && minutes >= preOpen && minutes < open) {
    return {
      code: "pre",
      label: `${label} Pre-market`,
      detail: `Before open · local ${local}`,
      open: false,
    };
  }
  if (!isIndia && minutes >= close && minutes < postClose) {
    return {
      code: "post",
      label: `${label} After-hours`,
      detail: `After close · local ${local}`,
      open: false,
    };
  }
  return {
    code: "closed",
    label: `${label} Closed`,
    detail: minutes < open ? `Opens soon · local ${local}` : `Closed · local ${local}`,
    open: false,
  };
}

function yahooStateLabel(state) {
  const s = String(state || "").toUpperCase();
  if (!s) return null;
  if (s === "REGULAR") return "Live: Open";
  if (s === "PRE" || s === "PREPRE") return "Live: Pre-market";
  if (s === "POST" || s === "POSTPOST") return "Live: After-hours";
  if (s === "CLOSED") return "Live: Closed";
  if (s === "SIMULATED") return "Simulated";
  return `Live: ${state}`;
}

function updateMarketHoursUI() {
  if (!el.marketHours) return;
  const session = getMarketSession(state.country);
  el.marketHours.textContent = session.label;
  el.marketHours.className = `market-hours ${session.code}`;
  el.marketHours.title = session.detail;
}

function marketStateBadge(q) {
  const session = getMarketSession(
    q.symbol?.endsWith(".NS") || q.currency === "INR" ? "IN" : "US"
  );
  const live = yahooStateLabel(q.marketState);
  const text = live || session.label;
  const code =
    q.marketState === "REGULAR"
      ? "open"
      : q.marketState === "PRE" || q.marketState === "PREPRE"
        ? "pre"
        : q.marketState === "POST" || q.marketState === "POSTPOST"
          ? "post"
          : session.code;
  return `<span class="market-hours inline ${code}" title="${escapeAttr(
    session.detail
  )}">${text}</span>`;
}

function formatMarketCap(n, ccy = "USD") {
  if (!(n > 0)) return "—";
  const abs = Math.abs(n);
  const unit =
    abs >= 1e12
      ? { value: n / 1e12, suffix: "T" }
      : abs >= 1e9
        ? { value: n / 1e9, suffix: "B" }
        : abs >= 1e6
          ? { value: n / 1e6, suffix: "M" }
          : { value: n, suffix: "" };
  return `${CCY_SYMBOL[ccy] || ""}${fmt(unit.value, unit.value >= 100 ? 0 : unit.value >= 10 ? 1 : 2)}${unit.suffix}`;
}

function escapeAttr(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const INDICATOR_INFO = {
  "Cap class": "Company size bucket based on market capitalization: Large Cap, Mid Cap, or Small Cap.",
  "Market cap": "Market capitalization = current share price multiplied by total shares outstanding. It estimates the company's total market value.",
  "RSI (14)": "Relative Strength Index over 14 periods. Below 30 often signals oversold conditions, above 70 often signals overbought conditions.",
  "SMA 10": "10-period Simple Moving Average. The average closing price over the last 10 candles.",
  "SMA 20": "20-period Simple Moving Average. Often used to judge the short-term trend and dynamic support/resistance.",
  "SMA 50": "50-period Simple Moving Average. A broader trend reference than SMA 10 or SMA 20.",
  MACD: "Moving Average Convergence Divergence. Measures momentum using the gap between the 12-period and 26-period EMAs.",
  "MACD Signal": "9-period EMA of the MACD line. MACD crossing above it is commonly read as bullish, below it as bearish.",
  "MACD Hist": "MACD histogram. Shows the distance between MACD and its signal line; growing bars can suggest strengthening momentum.",
  "5-day ROC": "Rate of Change over 5 periods. Shows how much price has moved in percentage terms versus 5 candles ago.",
  "Candle score": "Candlestick-pattern contribution to the final Pulse signal. Bullish patterns add points, bearish patterns subtract points.",
  "EMA 9": "9-period Exponential Moving Average. Gives more weight to recent prices than an SMA.",
  Bollinger:
    "Bollinger Bands use a moving average with upper and lower bands based on volatility. Price near the upper band can mean strength; near the lower band can mean weakness or possible mean reversion.",
};

const sourceTag = (source) =>
  source === "simulated"
    ? `<span class="source-tag sim" title="Live feed unreachable — showing simulated demo data">SIMULATED</span>`
    : `<span class="source-tag live" title="Live data via Yahoo Finance">● LIVE</span>`;

/* -------------------------------------------------------------------------- */
/*  Data fetching                                                             */
/* -------------------------------------------------------------------------- */

async function fetchQuote(symbol) {
  const res = await fetch(`/api/quote/${encodeURIComponent(symbol)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function fetchUniverse(country) {
  const res = await fetch(`/api/universe?country=${encodeURIComponent(country)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data.items || [];
}

async function refreshUniverse() {
  try {
    state.universe = await fetchUniverse(state.country);
  } catch {
    state.universe = [];
  }
}

function updateMarketTabs() {
  el.tabWatchlist?.classList.toggle("on", state.marketView === "watchlist");
  el.tabAllStocks?.classList.toggle("on", state.marketView === "all");
}

async function refreshAll() {
  updateMarketHoursUI();
  el.status.textContent = "Updating…";
  const symbols = Array.from(
    new Set([
      ...state.watchlist,
      ...Object.keys(state.portfolio.positions),
      ...(state.marketView === "all" ? state.universe.map((it) => it.symbol) : []),
    ])
  );
  const results = await Promise.allSettled(symbols.map((s) => fetchQuote(s)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") state.quotes[symbols[i]] = r.value;
  });
  renderWatchlist();
  renderPortfolio();
  if (state.selected && state.quotes[state.selected]) {
    renderDetail(state.quotes[state.selected]);
  }
  await maybeNotifySignalReversal();
  updateMarketHoursUI();
  const now = new Date();
  el.status.textContent = `Updated ${now.toLocaleTimeString()}`;
}

/* -------------------------------------------------------------------------- */
/*  Market movers (top gainers / losers)                                      */
/* -------------------------------------------------------------------------- */

async function refreshMovers() {
  try {
    const custom = loadMoversUniverse(state.country);
    let url = `/api/movers?country=${state.country}`;
    if (custom && custom.length) url += `&symbols=${encodeURIComponent(custom.join(","))}`;
    const res = await fetch(url);
    const data = await res.json();
    renderMovers(el.gainersList, data.gainers, "gain");
    renderMovers(el.losersList, data.losers, "lose");
    if (el.moversMeta) {
      el.moversMeta.textContent = `· scanning ${data.count} ${
        data.custom ? "custom" : "top"
      } stocks`;
    }
  } catch {
    el.gainersList.innerHTML = `<span class="movers-loading">Unavailable</span>`;
    el.losersList.innerHTML = `<span class="movers-loading">Unavailable</span>`;
  }
}

/* -------------------------------------------------------------------------- */
/*  News analyzer                                                             */
/* -------------------------------------------------------------------------- */

let newsLoading = false;

function newsBiasClass(bias) {
  return bias === "bullish" ? "up" : bias === "bearish" ? "down" : "neutral";
}

function renderNewsBoards(data) {
  const countryHtml =
    (data.countryImpacts || [])
      .map(
        (c) =>
          `<button type="button" class="news-chip ${newsBiasClass(c.bias)}" title="${escapeAttr(
            c.impact
          )}">
            <b>${c.label}</b>
            <span>${c.impact}</span>
            <small>${c.count} stories</small>
          </button>`
      )
      .join("") || `<div class="pf-empty">No clear country themes yet.</div>`;

  const industryHtml =
    (data.industryImpacts || [])
      .map(
        (i) =>
          `<button type="button" class="news-chip ${newsBiasClass(i.bias)}" title="${escapeAttr(
            i.why || i.impact
          )}">
            <b>${i.industry}</b>
            <span>${i.sector}</span>
            <small>${i.impact} · ${i.count}</small>
          </button>`
      )
      .join("") || `<div class="pf-empty">No clear industry themes yet.</div>`;

  const stockHtml =
    (data.stockImpacts || [])
      .map(
        (s) =>
          `<button type="button" class="news-chip ${newsBiasClass(s.bias)}" data-symbol="${
            s.symbol
          }" title="${escapeAttr(s.why || s.impact)}">
            <b>${s.symbol.replace(".NS", "")}</b>
            <span>${s.impact}</span>
            <small>${s.count} hits</small>
          </button>`
      )
      .join("") || `<div class="pf-empty">No stock links detected yet.</div>`;

  if (el.newsCountryBoard) el.newsCountryBoard.innerHTML = countryHtml;
  if (el.newsIndustryBoard) el.newsIndustryBoard.innerHTML = industryHtml;
  if (el.newsStockBoard) el.newsStockBoard.innerHTML = stockHtml;

  el.newsStockBoard?.querySelectorAll("[data-symbol]").forEach((btn) => {
    btn.addEventListener("click", () => {
      addSymbol(btn.dataset.symbol);
    });
  });
}

function renderNewsFeed(articles) {
  if (!el.newsFeed) return;
  if (!articles?.length) {
    el.newsFeed.innerHTML = `<div class="pf-empty">No headlines available right now.</div>`;
    return;
  }
  el.newsFeed.innerHTML = articles
    .map((a) => {
      const when = a.publishedAt
        ? new Date(a.publishedAt).toLocaleString()
        : "";
      const countries = (a.countries || [])
        .map((c) => `<span class="news-tag ${newsBiasClass(c.bias)}">${c.label}: ${c.impact}</span>`)
        .join("");
      const industries = (a.industries || [])
        .map(
          (i) =>
            `<span class="news-tag ${newsBiasClass(i.bias)}">${i.industry}: ${i.impact}</span>`
        )
        .join("");
      const stocks = (a.stocks || [])
        .map(
          (s) =>
            `<button type="button" class="news-tag stock ${newsBiasClass(
              s.bias
            )}" data-symbol="${s.symbol}">${s.symbol.replace(".NS", "")}: ${s.impact}</button>`
        )
        .join("");
      const link = a.link
        ? `<a class="news-link" href="${escapeAttr(a.link)}" target="_blank" rel="noopener noreferrer">Open article</a>`
        : "";
      return `<article class="news-card">
        <div class="news-card-top">
          <span class="news-sentiment ${newsBiasClass(a.sentiment)}">${a.sentiment}</span>
          <span class="news-pub">${escapeAttr(a.publisher || "")} · ${when}</span>
        </div>
        <h3>${escapeAttr(a.title)}</h3>
        ${a.summary ? `<p>${escapeAttr(a.summary)}</p>` : ""}
        <div class="news-cascade">
          <div><span class="news-cascade-label">Country</span>${countries || "<span class='muted-dash'>—</span>"}</div>
          <div><span class="news-cascade-label">Industry</span>${industries || "<span class='muted-dash'>—</span>"}</div>
          <div><span class="news-cascade-label">Stocks</span>${stocks || "<span class='muted-dash'>—</span>"}</div>
        </div>
        ${link}
      </article>`;
    })
    .join("");

  el.newsFeed.querySelectorAll("[data-symbol]").forEach((btn) => {
    btn.addEventListener("click", () => addSymbol(btn.dataset.symbol));
  });
}

async function refreshNews(force = false) {
  if (!el.newsFeed || newsLoading) return;
  newsLoading = true;
  if (el.newsMeta) el.newsMeta.textContent = "Fetching latest headlines…";
  try {
    const res = await fetch(`/api/news${force ? "?refresh=1" : ""}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "News failed");
    const when = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : "";
    if (el.newsMeta) {
      el.newsMeta.textContent = `${data.count || 0} stories · ${
        data.source === "simulated" ? "simulated demo feed" : "live Yahoo headlines"
      } · updated ${when}`;
    }
    renderNewsBoards(data);
    renderNewsFeed(data.articles || []);
  } catch (err) {
    if (el.newsMeta) el.newsMeta.textContent = `Could not load news: ${err.message}`;
    if (el.newsFeed)
      el.newsFeed.innerHTML = `<div class="pf-empty">News analyzer unavailable right now.</div>`;
  } finally {
    newsLoading = false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Movers universe editor                                                    */
/* -------------------------------------------------------------------------- */

function parseSymbolList(text) {
  const seen = new Set();
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeSymbol(s))
    .filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
}

function openMoversEditor() {
  const custom = loadMoversUniverse(state.country);
  el.moversInput.value = custom ? custom.join(", ") : "";
  el.moversEditor.classList.remove("hidden");
  el.moversInput.focus();
}

function closeMoversEditor() {
  el.moversEditor.classList.add("hidden");
}

function applyMoversUniverse(symbols) {
  saveMoversUniverse(state.country, symbols);
  closeMoversEditor();
  el.gainersList.innerHTML = `<span class="movers-loading">Loading…</span>`;
  el.losersList.innerHTML = `<span class="movers-loading">Loading…</span>`;
  refreshMovers();
}

function renderMovers(container, list, kind) {
  if (!list || !list.length) {
    container.innerHTML = `<span class="movers-loading">No data</span>`;
    return;
  }
  container.innerHTML = list
    .map((m) => {
      const pct = (m.changePercent > 0 ? "+" : "") + m.changePercent.toFixed(2) + "%";
      return `<button class="mover ${kind}" data-symbol="${m.symbol}" title="${m.name}">
        <span class="mover-sym">${m.symbol.replace(".NS", "")}</span>
        <span class="mover-price">${money(m.price, m.currency)}</span>
        <span class="mover-pct">${pct}</span>
      </button>`;
    })
    .join("");
  container.querySelectorAll(".mover").forEach((node) => {
    node.addEventListener("click", () => addSymbol(node.dataset.symbol));
  });
}

/* -------------------------------------------------------------------------- */
/*  Trader classification (from paper-trading history)                        */
/* -------------------------------------------------------------------------- */

function classifyTrader(portfolio) {
  const trades = portfolio?.trades || [];
  const positions = portfolio?.positions || {};
  const buys = trades.filter((t) => t.side === "BUY");
  const sells = trades.filter((t) => t.side === "SELL");
  const closed = sells.filter((t) => t.realized != null);
  const openN = Object.keys(positions).length;
  const symbols = new Set(trades.map((t) => t.symbol));

  if (trades.length === 0) {
    return {
      key: "observer",
      label: "Observer",
      tone: "muted",
      summary:
        "No paper trades yet. Buy and sell a few stocks to unlock your trader type.",
      traits: [
        { label: "Trades", value: "0" },
        { label: "Open", value: String(openN) },
      ],
    };
  }

  if (trades.length < 3) {
    return {
      key: "new",
      label: "New Trader",
      tone: "info",
      summary:
        "You're just getting started. Keep trading to reveal a clearer style profile.",
      traits: [
        { label: "Trades", value: String(trades.length) },
        { label: "Symbols", value: String(symbols.size) },
        { label: "Open", value: String(openN) },
      ],
    };
  }

  // Win rate on closed sells
  const wins = closed.filter((t) => t.realized > 0).length;
  const losses = closed.filter((t) => t.realized < 0).length;
  const winRate = closed.length ? wins / closed.length : null;

  // Average hold time (FIFO match buys → sells per symbol)
  const holdDays = estimateAvgHoldDays(trades);
  const times = trades.map((t) => t.ts).filter(Boolean);
  const spanDays =
    times.length >= 2
      ? Math.max(1, (Math.max(...times) - Math.min(...times)) / 86400000)
      : 1;
  const tradesPerWeek = (trades.length / spanDays) * 7;

  // Pulse signal alignment on buys
  const bullish = new Set(["BUY", "STRONG BUY"]);
  const bearish = new Set(["SELL", "STRONG SELL"]);
  const buysWithSig = buys.filter((t) => t.signal);
  const followN = buysWithSig.filter((t) => bullish.has(t.signal)).length;
  const contraN = buysWithSig.filter((t) => bearish.has(t.signal)).length;
  const followRate = buysWithSig.length ? followN / buysWithSig.length : null;
  const contraRate = buysWithSig.length ? contraN / buysWithSig.length : null;

  // Concentration
  const concentrated = symbols.size <= 2 && trades.length >= 4;
  const diversified = symbols.size >= 5;

  // Pick primary archetype (priority order)
  let key = "balanced";
  let label = "Balanced Trader";
  let tone = "info";
  let summary =
    "A mix of styles so far — neither purely short-term nor long-term.";

  if (tradesPerWeek >= 8 || (holdDays != null && holdDays < 1.5 && sells.length >= 2)) {
    key = "scalper";
    label = "Active Scalper";
    tone = "hot";
    summary =
      "You trade often and tend to exit quickly. Short holding periods dominate your history.";
  } else if (holdDays != null && holdDays <= 10 && sells.length >= 2) {
    key = "swing";
    label = "Swing Trader";
    tone = "accent";
    summary =
      "You typically hold for several days. Your pattern fits short-to-medium swing trades.";
  } else if (
    (holdDays != null && holdDays > 10) ||
    (buys.length >= 3 && sells.length / Math.max(buys.length, 1) < 0.35)
  ) {
    key = "holder";
    label = "Buy & Hold";
    tone = "calm";
    summary =
      "You buy more than you sell and/or hold positions longer — closer to an investor than a day trader.";
  }

  if (followRate != null && followRate >= 0.6 && buysWithSig.length >= 2) {
    key = "follower";
    label = "Signal Follower";
    tone = "up";
    summary =
      "Most of your buys line up with Pulse BUY / STRONG BUY signals. You tend to trade with the model's bias.";
  } else if (contraRate != null && contraRate >= 0.5 && buysWithSig.length >= 2) {
    key = "contrarian";
    label = "Contrarian";
    tone = "down";
    summary =
      "You often buy when Pulse is bearish (SELL / STRONG SELL). That is a high-conviction, higher-risk style.";
  }

  if (concentrated && key !== "contrarian") {
    // Soft override flavor if still generic
    if (key === "balanced" || key === "swing") {
      key = "focused";
      label = "Concentrated Speculator";
      tone = "hot";
      summary =
        "Your trades cluster in just one or two symbols. High focus can amplify both gains and losses.";
    }
  } else if (diversified && (key === "balanced" || key === "holder")) {
    key = "diversified";
    label = "Diversified Investor";
    tone = "calm";
    summary =
      "You spread activity across many symbols — more portfolio-like than single-stock speculation.";
  }

  // Performance flavor (suffix if enough closed trades)
  if (winRate != null && closed.length >= 3) {
    if (winRate >= 0.6) {
      summary += " Recent closed trades show a solid win rate.";
      if (tone === "info" || tone === "muted") tone = "up";
    } else if (winRate <= 0.35) {
      summary += " Recent closed trades have been tough — consider sizing down or waiting for stronger signals.";
      if (key === "balanced") {
        label = "Learning Trader";
        tone = "warn";
      }
    }
  }

  const traits = [
    { label: "Trades", value: String(trades.length) },
    { label: "Symbols", value: String(symbols.size) },
    { label: "Open", value: String(openN) },
  ];
  if (winRate != null && closed.length) {
    traits.push({
      label: "Win rate",
      value: `${Math.round(winRate * 100)}% (${wins}W/${losses}L)`,
    });
  }
  if (holdDays != null) {
    traits.push({
      label: "Avg hold",
      value: holdDays < 1 ? `${Math.round(holdDays * 24)}h` : `${holdDays.toFixed(1)}d`,
    });
  }
  traits.push({
    label: "Activity",
    value: `${tradesPerWeek.toFixed(1)}/wk`,
  });
  if (followRate != null) {
    traits.push({
      label: "Follows Pulse",
      value: `${Math.round(followRate * 100)}%`,
    });
  }
  if (contraRate != null && contraRate > 0) {
    traits.push({
      label: "Buys vs signal",
      value: `${Math.round(contraRate * 100)}% contrarian`,
    });
  }

  return { key, label, tone, summary, traits };
}

/** FIFO-ish average holding period in days from buy/sell history. */
function estimateAvgHoldDays(trades) {
  const chron = [...trades].filter((t) => t.ts).sort((a, b) => a.ts - b.ts);
  const lots = {}; // symbol -> [{ts, qty}]
  const holds = [];
  for (const t of chron) {
    if (t.side === "BUY") {
      if (!lots[t.symbol]) lots[t.symbol] = [];
      lots[t.symbol].push({ ts: t.ts, qty: t.qty });
    } else if (t.side === "SELL") {
      let left = t.qty;
      const q = lots[t.symbol] || [];
      while (left > 0 && q.length) {
        const lot = q[0];
        const used = Math.min(left, lot.qty);
        holds.push((t.ts - lot.ts) / 86400000);
        lot.qty -= used;
        left -= used;
        if (lot.qty <= 0) q.shift();
      }
    }
  }
  if (!holds.length) return null;
  return holds.reduce((a, b) => a + b, 0) / holds.length;
}

function renderTraderClassification() {
  const cls = classifyTrader(state.portfolio);
  if (el.traderClassBadge) {
    el.traderClassBadge.textContent = cls.label;
    el.traderClassBadge.className = `trader-class-badge tone-${cls.tone}`;
  }
  if (el.traderClassSummary) el.traderClassSummary.textContent = cls.summary;
  if (el.traderClassTraits) {
    el.traderClassTraits.innerHTML = cls.traits
      .map(
        (t) =>
          `<div class="trader-trait"><span>${t.label}</span><b>${t.value}</b></div>`
      )
      .join("");
  }
  if (el.pdTraderType) el.pdTraderType.textContent = cls.label;
  if (el.portfolioTraderType) {
    if (cls.key === "observer") {
      el.portfolioTraderType.classList.add("hidden");
    } else {
      el.portfolioTraderType.textContent = cls.label;
      el.portfolioTraderType.className = `trader-class-badge compact tone-${cls.tone}`;
      el.portfolioTraderType.classList.remove("hidden");
    }
  }
  return cls;
}

/* -------------------------------------------------------------------------- */
/*  Paper portfolio                                                           */
/* -------------------------------------------------------------------------- */

function renderPortfolio() {
  renderTraderClassification();
  syncPnlPeriodUI();
  const p = state.portfolio;
  const symbols = Object.keys(p.positions);
  const range = getPnlRange();
  const stats = periodStats(p.trades || [], range.start, range.end);
  const isAll = range.start == null && range.end == null && state.pnlPeriod.key === "all";

  const currencies = new Set([
    ...symbols.map((s) => p.positions[s].currency),
    ...Object.keys(p.realized).filter((c) => p.realized[c]),
    ...Object.keys(stats.byCcy),
  ]);

  // Per-currency aggregation (open positions — mark-to-market now)
  const agg = {};
  currencies.forEach((c) => (agg[c] = { invested: 0, value: 0, upl: 0 }));
  symbols.forEach((sym) => {
    const pos = p.positions[sym];
    const price = state.quotes[sym]?.price ?? pos.avgCost;
    const invested = pos.qty * pos.avgCost;
    const value = pos.qty * price;
    const a = agg[pos.currency] || (agg[pos.currency] = { invested: 0, value: 0, upl: 0 });
    a.invested += invested;
    a.value += value;
    a.upl += value - invested;
  });

  const hasActivity =
    symbols.length > 0 ||
    (p.trades && p.trades.length > 0) ||
    Object.values(p.realized || {}).some((v) => v);

  if (!hasActivity) {
    el.portfolioSummary.innerHTML = "";
    el.portfolioHoldings.innerHTML = `<div class="pf-empty">You haven't bought any stocks yet. Open a stock and click <b>Buy</b> to start your paper portfolio.</div>`;
    el.tradeHistory.innerHTML = "";
    if (el.tradeHistoryMeta) el.tradeHistoryMeta.textContent = "";
    updateNavPnl([]);
    return;
  }

  // Nav badge: all-time total P&L + % per currency
  const navTotals = [...currencies].map((c) => {
    const invested = agg[c]?.invested || 0;
    const total = (agg[c]?.upl || 0) + (p.realized[c] || 0);
    let basis = invested;
    if (!(basis > 0)) {
      basis = (p.trades || [])
        .filter((t) => t.currency === c && t.side === "BUY")
        .reduce((s, t) => s + t.qty * t.price, 0);
    }
    return {
      ccy: c,
      total,
      pct: basis > 0 ? (total / basis) * 100 : null,
    };
  });
  updateNavPnl(navTotals);

  const periodBanner = `<div class="pnl-period-banner">
    Showing <b>${range.label}</b>
    · ${stats.buys} buy${stats.buys === 1 ? "" : "s"}, ${stats.sells} sell${stats.sells === 1 ? "" : "s"}
    ${
      stats.sells
        ? ` · ${stats.wins} win${stats.wins === 1 ? "" : "s"} / ${stats.losses} loss${stats.losses === 1 ? "" : "es"}`
        : ""
    }
  </div>`;

  el.portfolioSummary.innerHTML =
    periodBanner +
    [...currencies]
      .map((c) => {
        const a = agg[c] || { invested: 0, value: 0, upl: 0 };
        const lifetimeRealized = p.realized[c] || 0;
        const periodRealized = stats.byCcy[c]?.realized || 0;
        const realized = isAll ? lifetimeRealized : periodRealized;
        const total = isAll ? a.upl + lifetimeRealized : periodRealized;
        const uplPct = a.invested ? (a.upl / a.invested) * 100 : 0;
        const realizedLabel = isAll ? "Realized" : "Period realized";
        const totalLabel = isAll ? "Total P&L" : "Period P&L";
        return `
      <div class="pf-card">
        <div class="pf-ccy">${CCY_SYMBOL[c] || ""} ${c}</div>
        <div class="pf-metrics">
          ${pfMetric("Invested", money(a.invested, c))}
          ${pfMetric("Market value", money(a.value, c))}
          ${pfMetric(
            "Unrealized",
            `${signedMoney(a.upl, c)} (${signedPct(uplPct)})`,
            a.upl >= 0 ? "up" : "down"
          )}
          ${pfMetric(
            realizedLabel,
            signedMoney(realized, c),
            realized >= 0 ? "up" : "down"
          )}
          ${pfMetric(
            totalLabel,
            signedMoney(total, c),
            total >= 0 ? "up" : "down"
          )}
          ${
            !isAll
              ? pfMetric(
                  "All-time realized",
                  signedMoney(lifetimeRealized, c),
                  lifetimeRealized >= 0 ? "up" : "down"
                )
              : ""
          }
        </div>
      </div>`;
      })
      .join("");

  // Holdings
  if (!symbols.length) {
    el.portfolioHoldings.innerHTML = `<div class="pf-empty">No open positions. Realized results for this period are shown above.</div>`;
  } else {
    // Backfill industry/sector from live quotes onto positions when missing.
    let dirty = false;
    symbols.forEach((sym) => {
      const pos = p.positions[sym];
      const q = state.quotes[sym];
      if (!q) return;
      if (!pos.industry && q.industry) {
        pos.industry = q.industry;
        dirty = true;
      }
      if (!pos.sector && q.sector) {
        pos.sector = q.sector;
        dirty = true;
      }
      if (!pos.capLabel && q.capLabel) {
        pos.capLabel = q.capLabel;
        dirty = true;
      }
    });
    if (dirty) savePortfolio();

    // Sector allocation strip
    const bySector = {};
    let totalValue = 0;
    symbols.forEach((sym) => {
      const pos = p.positions[sym];
      const price = state.quotes[sym]?.price ?? pos.avgCost;
      const value = pos.qty * price;
      totalValue += value;
      const sector = pos.sector || state.quotes[sym]?.sector || "Unknown";
      bySector[sector] = (bySector[sector] || 0) + value;
    });
    const sectorHtml =
      totalValue > 0
        ? `<div class="pf-sectors">${Object.entries(bySector)
            .sort((a, b) => b[1] - a[1])
            .map(([sector, value]) => {
              const pct = (value / totalValue) * 100;
              return `<span class="pf-sector-chip" title="${sector}: ${pct.toFixed(1)}% of portfolio"><b>${sector}</b> ${pct.toFixed(0)}%</span>`;
            })
            .join("")}</div>`
        : "";

    const rows = symbols
      .map((sym) => {
        const pos = p.positions[sym];
        const q = state.quotes[sym];
        const price = q?.price ?? pos.avgCost;
        const invested = pos.qty * pos.avgCost;
        const value = pos.qty * price;
        const upl = value - invested;
        const uplPct = invested ? (upl / invested) * 100 : 0;
        const cls = upl >= 0 ? "up" : "down";
        const industry = pos.industry || q?.industry || null;
        const sector = pos.sector || q?.sector || null;
        const capLabel = pos.capLabel || q?.capLabel || null;
        const industryLabel = [industry || sector || null, capLabel].filter(Boolean).join(" · ") || "—";
        const buySig = pos.buySignal
          ? `<span class="badge ${badgeClass(pos.buySignal)}" title="Pulse signal when you bought">${pos.buySignal}${
              pos.buyScore != null ? ` ${pos.buyScore > 0 ? "+" : ""}${pos.buyScore}` : ""
            }</span>`
          : `<span class="muted-dash">—</span>`;
        const curReco = q?.analysis?.recommendation || null;
        const curScore = q?.analysis?.score;
        const curSig = curReco
          ? `<span class="badge ${badgeClass(curReco)}" title="Current Pulse signal">${curReco}${
              curScore != null ? ` ${curScore > 0 ? "+" : ""}${curScore}` : ""
            }</span>`
          : `<span class="muted-dash">…</span>`;
        const action = portfolioAction(pos.buySignal, curReco, uplPct);
        return `
        <div class="pf-holding" data-symbol="${sym}">
          <div class="pfh-main">
            <div class="pfh-sym">${sym.replace(".NS", "")}</div>
            <div class="pfh-name">${pos.name || ""}</div>
            <div class="pfh-industry" title="${sector ? `Sector: ${sector}` : ""}">${industryLabel}</div>
          </div>
          <div class="pfh-cell"><span>Qty</span>${pos.qty}</div>
          <div class="pfh-cell"><span>Avg</span>${money(pos.avgCost, pos.currency)}</div>
          <div class="pfh-cell"><span>Last</span>${money(price, pos.currency)}</div>
          <div class="pfh-cell"><span>At buy</span>${buySig}</div>
          <div class="pfh-cell"><span>Now</span>${curSig}</div>
          <div class="pfh-cell"><span>Action</span><b class="pfh-action ${action.cls}">${action.label}</b></div>
          <div class="pfh-cell pnl ${cls}"><span>P&L</span>${signedMoney(
          upl,
          pos.currency
        )}<br><small>${signedPct(uplPct)}</small></div>
          <button class="mini-btn pfh-open" data-symbol="${sym}">Trade</button>
        </div>`;
      })
      .join("");
    el.portfolioHoldings.innerHTML = sectorHtml + rows;
    el.portfolioHoldings.querySelectorAll(".pfh-open").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectSymbol(btn.dataset.symbol);
        el.detailContent.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  // Trade history filtered by period
  const filtered = (p.trades || []).filter((t) =>
    tradeInRange(t, range.start, range.end)
  );
  if (el.tradeHistoryMeta) {
    el.tradeHistoryMeta.textContent =
      filtered.length === (p.trades || []).length
        ? `(${filtered.length})`
        : `(${filtered.length} of ${p.trades.length})`;
  }
  el.tradeHistory.innerHTML =
    filtered
      .slice(0, 50)
      .map((t) => {
        const d = new Date(t.ts);
        const when = d.toLocaleDateString() + " " + d.toLocaleTimeString();
        const extra =
          t.side === "SELL" && t.realized != null
            ? ` · P&L <b class="${t.realized >= 0 ? "up" : "down"}">${signedMoney(
                t.realized,
                t.currency
              )}</b>`
            : "";
        const sigBadge = t.signal
          ? `<span class="trade-signal badge ${badgeClass(t.signal)}" title="Pulse signal when this trade was placed">${t.signal}${
              t.score != null ? ` ${t.score > 0 ? "+" : ""}${t.score}` : ""
            }</span>`
          : "";
        return `<div class="trade-row">
          <span class="trade-side ${t.side.toLowerCase()}">${t.side}</span>
          <span class="trade-sym">${t.symbol.replace(".NS", "")}</span>
          <span>${t.qty} @ ${money(t.price, t.currency)}${extra}</span>
          ${sigBadge}
          <span class="trade-when">${when}</span>
        </div>`;
      })
      .join("") ||
    `<div class="pf-empty">No trades in this period.</div>`;
}

function pfMetric(label, val, cls = "") {
  return `<div class="pf-metric"><span>${label}</span><b class="${cls}">${val}</b></div>`;
}

/** Suggest an action from buy-time signal vs current Pulse signal + P&L. */
function portfolioAction(buySignal, currentSignal, uplPct) {
  const bearish = new Set(["SELL", "STRONG SELL"]);
  const bullish = new Set(["BUY", "STRONG BUY"]);
  if (!currentSignal) return { label: "Waiting…", cls: "muted" };
  if (bearish.has(currentSignal)) {
    if (uplPct >= 0) return { label: "Take profit", cls: "down" };
    return { label: "Cut loss", cls: "down" };
  }
  if (bullish.has(currentSignal)) {
    if (bearish.has(buySignal)) return { label: "Hold / add", cls: "up" };
    return { label: "Hold", cls: "up" };
  }
  // HOLD
  if (uplPct <= -5) return { label: "Review", cls: "muted" };
  return { label: "Hold", cls: "muted" };
}

function updateNavPnl(totals) {
  if (!el.navPnl) return;
  if (!totals.length) {
    el.navPnl.innerHTML = "";
    el.navPnl.className = "nav-pnl";
    return;
  }
  el.navPnl.innerHTML = totals
    .map((t) => {
      const moneyPart = signedMoney(t.total, t.ccy);
      const pctPart =
        t.pct != null
          ? `<span class="nav-pct">${signedPct(t.pct)}</span>`
          : "";
      return `<span class="nav-pnl-item">${moneyPart}${pctPart}</span>`;
    })
    .join("");
  const net = totals.reduce((s, t) => s + Math.sign(t.total), 0);
  el.navPnl.className = "nav-pnl " + (net >= 0 ? "up" : "down");
}

/* -------------------------------------------------------------------------- */
/*  Watchlist rendering                                                       */
/* -------------------------------------------------------------------------- */

function renderWatchlist() {
  updateMarketTabs();
  if (el.sortFilter) el.sortFilter.value = state.sortBy;
  el.watchlist.innerHTML = "";
  const signalFilter = state.recoFilter;
  const capFilter = state.capFilter;
  let shown = 0;
  let hidden = 0;
  let items =
    state.marketView === "all"
      ? state.universe
      : state.watchlist.map((symbol) => ({ symbol, name: null }));

  const sortVal = state.sortBy;
  items = [...items].sort((a, b) => {
    const qa = state.quotes[a.symbol];
    const qb = state.quotes[b.symbol];
    if (sortVal === "symbol") return a.symbol.localeCompare(b.symbol);
    const av = sortVal.startsWith("price")
      ? qa?.price ?? Number.NEGATIVE_INFINITY
      : qa?.analysis?.changePercent ?? Number.NEGATIVE_INFINITY;
    const bv = sortVal.startsWith("price")
      ? qb?.price ?? Number.NEGATIVE_INFINITY
      : qb?.analysis?.changePercent ?? Number.NEGATIVE_INFINITY;
    if (av === bv) return a.symbol.localeCompare(b.symbol);
    return sortVal.endsWith("_asc") ? av - bv : bv - av;
  });

  items.forEach((item) => {
    const symbol = item.symbol;
    const q = state.quotes[symbol];
    if (signalFilter !== "ALL" && q && q.analysis.recommendation !== signalFilter) {
      hidden++;
      return;
    }
    if (capFilter !== "ALL" && q && q.capBucket !== capFilter) {
      hidden++;
      return;
    }
    shown++;
    const li = document.createElement("li");
    li.className = "wl-item" + (state.selected === symbol ? " active" : "");
    li.dataset.symbol = symbol;

    if (!q) {
      li.innerHTML = `
        <div><div class="wl-sym">${symbol}</div>
        <div class="wl-name">${item.name || "Loading…"}</div></div>
        <div class="wl-price">—</div>
        ${
          state.marketView === "watchlist"
            ? `<button class="wl-remove" title="Remove">✕</button>`
            : `<button class="wl-add" title="Add to watchlist">${
                state.watchlist.includes(symbol) ? "✓" : "+"
              }</button>`
        }`;
    } else {
      const a = q.analysis;
      const chgClass = signColor(a.changePercent);
      li.innerHTML = `
        <div>
          <div class="wl-sym">${q.symbol}</div>
          <div class="wl-name">${q.name}${q.capLabel ? ` · ${q.capLabel}` : ""}</div>
        </div>
        <div class="wl-price">${money(q.price, q.currency)}</div>
        <div class="wl-chg ${chgClass}">${arrow(a.changePercent)} ${fmt(
        Math.abs(a.changePercent)
      )}%</div>
        <span class="wl-badge badge ${badgeClass(a.recommendation)}">${
        a.recommendation
      }</span>
        ${
          state.marketView === "watchlist"
            ? `<button class="wl-remove" title="Remove">✕</button>`
            : `<button class="wl-add" title="Add to watchlist">${
                state.watchlist.includes(symbol) ? "✓" : "+"
              }</button>`
        }`;
    }

    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("wl-remove")) {
        removeSymbol(symbol);
        return;
      }
      if (e.target.classList.contains("wl-add")) {
        e.stopPropagation();
        if (!state.watchlist.includes(symbol)) {
          state.watchlist.push(symbol);
          saveWatchlist();
        }
        renderWatchlist();
        return;
      }
      selectSymbol(symbol);
    });
    el.watchlist.appendChild(li);
  });

  if (el.filterCount) {
    const label = state.marketView === "all" ? "market stocks" : "stocks";
    el.filterCount.textContent =
      signalFilter === "ALL" && capFilter === "ALL"
        ? `${shown} ${label}`
        : `${shown} match · ${hidden} hidden`;
  }
  if (shown === 0) {
    const li = document.createElement("li");
    li.className = "wl-empty";
    li.textContent = state.marketView === "all"
      ? "No stocks match the current signal / market-cap filters."
      : signalFilter === "ALL" && capFilter === "ALL"
        ? "No stocks yet — search above to add."
        : "No watchlist stocks match the current filters.";
    el.watchlist.appendChild(li);
  }
}

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function selectSymbol(symbol) {
  setPage("market");
  state.selected = symbol;
  renderWatchlist();
  const q = state.quotes[symbol];
  if (q) {
    renderDetail(q);
  } else {
    el.emptyState.classList.add("hidden");
    el.detailContent.classList.remove("hidden");
    el.detailContent.innerHTML = `<div class="loading">Loading ${symbol}…</div>`;
    fetchQuote(symbol)
      .then((data) => {
        state.quotes[symbol] = data;
        if (state.selected === symbol) renderDetail(data);
        renderWatchlist();
      })
      .catch((err) => {
        if (state.selected === symbol)
          el.detailContent.innerHTML = `<div class="error-box">Could not load ${symbol}: ${err.message}</div>`;
      });
  }
}

function normalizeSymbol(symbol) {
  symbol = symbol.toUpperCase().trim();
  // In India, plain tickers default to the NSE (.NS) suffix used by Yahoo.
  if (
    state.country === "IN" &&
    !symbol.includes(".") &&
    !symbol.startsWith("^")
  ) {
    return symbol + ".NS";
  }
  return symbol;
}

function addSymbol(symbol) {
  symbol = normalizeSymbol(symbol);
  if (!state.watchlist.includes(symbol)) {
    state.watchlist.push(symbol);
    saveWatchlist();
  }
  renderWatchlist();
  selectSymbol(symbol);
}

function removeSymbol(symbol) {
  state.watchlist = state.watchlist.filter((s) => s !== symbol);
  delete state.quotes[symbol];
  saveWatchlist();
  if (state.selected === symbol) {
    state.selected = null;
    el.detailContent.classList.add("hidden");
    el.emptyState.classList.remove("hidden");
  }
  renderWatchlist();
}

/* -------------------------------------------------------------------------- */
/*  Detail rendering                                                          */
/* -------------------------------------------------------------------------- */

function renderDetail(q) {
  el.emptyState.classList.add("hidden");
  el.detailContent.classList.remove("hidden");

  const a = q.analysis;
  const i = a.indicators;
  const chgClass = signColor(a.change);
  const markerPos = (a.score + 100) / 2; // 0..100
  const companyMeta = [q.exchange, q.currency, q.capLabel || ""]
    .filter(Boolean)
    .join(" · ");

  el.detailContent.innerHTML = `
    <div class="detail-header">
      <div class="dh-left">
        <h2>${q.symbol} ${sourceTag(q.source)}</h2>
        <p class="company">${q.name}</p>
        <span class="exch">${companyMeta} · ${marketStateBadge(q)}</span>
      </div>
      <div class="dh-right">
        <div class="big-price">${money(q.price, q.currency)}</div>
        <div class="big-change ${chgClass}">${arrow(a.change)} ${money(
    a.change,
    q.currency
  )} (${fmt(a.changePercent)}%)</div>
      </div>
    </div>

    <div class="reco-card">
      <div class="reco-badge badge ${badgeClass(a.recommendation)}">${
    a.recommendation
  }</div>
      <div class="reco-meta">
        <div class="label">Short-term signal strength</div>
        <div class="gauge"><div class="marker" style="left:${markerPos}%"></div></div>
        <div class="reco-score">Score ${a.score} / 100 · Confidence ${
    a.confidence
  }%</div>
      </div>
    </div>

    ${tradeCardHtml(q)}

    <div class="chart-wrap">
      <div class="chart-toolbar">
        <div class="chart-left">
          <div class="seg chart-type">
            <button class="seg-btn ${state.chart.type === "line" ? "on" : ""}" data-type="line">Line</button>
            <button class="seg-btn ${state.chart.type === "candle" ? "on" : ""}" data-type="candle">Candles</button>
          </div>
          <div class="chart-overlays">
            <span class="tb-label">Overlays:</span>
            ${overlayToggle("sma10", "SMA 10")}
            ${overlayToggle("sma20", "SMA 20")}
            ${overlayToggle("sma50", "SMA 50")}
            ${overlayToggle("ema9", "EMA 9")}
            ${overlayToggle("boll", "Bollinger")}
          </div>
        </div>
        <label class="chart-pane">
          Indicator
          <select id="chartPane">
            <option value="none">None</option>
            <option value="rsi">RSI (14)</option>
            <option value="macd">MACD</option>
            <option value="volume">Volume</option>
          </select>
        </label>
      </div>
      <canvas id="chart"></canvas>
    </div>

    <div class="ind-grid">
      ${indCell("Cap class", q.capLabel || "—", q.capBucket === "large" ? "up" : "")}
      ${indCell("Market cap", formatMarketCap(q.marketCap, q.currency))}
      ${indCell("RSI (14)", fmt(i.rsi14, 1), rsiClass(i.rsi14))}
      ${indCell("SMA 10", money(i.sma10, q.currency))}
      ${indCell("SMA 20", money(i.sma20, q.currency))}
      ${indCell("SMA 50", money(i.sma50, q.currency))}
      ${indCell("MACD", fmt(i.macd, 3))}
      ${indCell("MACD Signal", fmt(i.macdSignal, 3))}
      ${indCell(
        "MACD Hist",
        fmt(i.macdHist, 3),
        i.macdHist > 0 ? "up" : "down"
      )}
      ${indCell(
        "5-day ROC",
        (i.roc5 > 0 ? "+" : "") + fmt(i.roc5) + "%",
        signColor(i.roc5)
      )}
      ${indCell(
        "Candle score",
        (i.candleScore > 0 ? "+" : "") + fmt(i.candleScore ?? 0, 0),
        signColor(i.candleScore)
      )}
    </div>

    <div class="patterns-card">
      <h3>Candlestick patterns</h3>
      ${
        a.patterns && a.patterns.length
          ? `<div class="pattern-chips">${a.patterns
              .map(
                (p) =>
                  `<span class="pattern-chip ${p.bias}" title="${p.text}">${p.name}<small>${p.bias}</small></span>`
              )
              .join("")}</div>
            <ul class="pattern-list">${a.patterns
              .map((p) => `<li class="${p.bias}">${p.text}</li>`)
              .join("")}</ul>`
          : `<p class="pattern-empty">No strong classic candle pattern on the latest bars.</p>`
      }
    </div>

    <div class="reasons">
      <h3>Why this signal</h3>
      ${a.reasons
        .map(
          (r) =>
            `<div class="reason ${r.signal}"><span class="dot"></span><span>${r.text}</span></div>`
        )
        .join("")}
    </div>
  `;

  wireChartControls(q);
  wireTradeControls(q);
  drawChart(q.candles, q.analysis?.patterns || []);
}

function tradeCardHtml(q) {
  const pos = state.portfolio.positions[q.symbol];
  const realizedOnSymbol = (state.portfolio.trades || [])
    .filter((t) => t.symbol === q.symbol && t.side === "SELL" && t.realized != null)
    .reduce((s, t) => s + t.realized, 0);
  const hasRealized = (state.portfolio.trades || []).some(
    (t) => t.symbol === q.symbol && t.side === "SELL"
  );
  let posInfo = `<span class="pos-empty">No position yet</span>`;
  if (pos) {
    const value = pos.qty * q.price;
    const invested = pos.qty * pos.avgCost;
    const upl = value - invested;
    const uplPct = invested ? (upl / invested) * 100 : 0;
    const cls = upl >= 0 ? "up" : "down";
    posInfo = `
      <div class="pos-row"><span>Holding</span><b>${pos.qty} sh @ ${money(
      pos.avgCost,
      q.currency
    )}</b></div>
      <div class="pos-row"><span>Industry</span><b>${
        [pos.industry || q.industry || pos.sector || q.sector || null, pos.capLabel || q.capLabel || null]
          .filter(Boolean)
          .join(" · ") || "—"
      }</b></div>
      <div class="pos-row"><span>Market value</span><b>${money(
        value,
        q.currency
      )}</b></div>
      <div class="pos-row"><span>Unrealized P&amp;L</span><b class="${cls}">${signedMoney(
      upl,
      q.currency
    )} (${signedPct(uplPct)})</b></div>
      ${
        hasRealized
          ? `<div class="pos-row"><span>Realized P&amp;L</span><b class="${
              realizedOnSymbol >= 0 ? "up" : "down"
            }">${signedMoney(realizedOnSymbol, q.currency)}</b></div>`
          : ""
      }
      ${
        pos.buySignal
          ? `<div class="pos-row"><span>Signal at buy</span><b><span class="badge ${badgeClass(
              pos.buySignal
            )}">${pos.buySignal}${
              pos.buyScore != null ? ` ${pos.buyScore > 0 ? "+" : ""}${pos.buyScore}` : ""
            }</span></b></div>`
          : ""
      }`;
  } else if (hasRealized) {
    posInfo = `
      <span class="pos-empty">No open position</span>
      <div class="pos-row"><span>Realized P&amp;L</span><b class="${
        realizedOnSymbol >= 0 ? "up" : "down"
      }">${signedMoney(realizedOnSymbol, q.currency)}</b></div>`;
  }
  return `
    <div class="trade-card">
      <div class="trade-position">${posInfo}</div>
      <div class="trade-form">
        <div class="qty-wrap">
          <label>Qty</label>
          <input type="number" id="tradeQty" min="1" step="1" value="1" />
        </div>
        <span class="trade-cost" id="tradeCost"></span>
        <button class="mini-btn primary" id="buyBtn">Buy</button>
        <button class="mini-btn" id="sellBtn" ${pos ? "" : "disabled"}>Sell</button>
      </div>
    </div>`;
}

function wireTradeControls(q) {
  const qtyEl = el.detailContent.querySelector("#tradeQty");
  const costEl = el.detailContent.querySelector("#tradeCost");
  const buyBtn = el.detailContent.querySelector("#buyBtn");
  const sellBtn = el.detailContent.querySelector("#sellBtn");
  if (!qtyEl) return;

  const updateCost = () => {
    const qty = Math.max(0, Math.floor(Number(qtyEl.value) || 0));
    costEl.textContent = `≈ ${money(qty * q.price, q.currency)}`;
  };
  updateCost();
  qtyEl.addEventListener("input", updateCost);

  const sig = q.analysis
    ? { recommendation: q.analysis.recommendation, score: q.analysis.score }
    : null;

  buyBtn.addEventListener("click", () => {
    const qty = Math.floor(Number(qtyEl.value) || 0);
    if (qty <= 0) return;
    buyStock(q.symbol, qty, q.price, q.currency, q.name, sig, {
      industry: q.industry || null,
      sector: q.sector || null,
      capLabel: q.capLabel || null,
    });
    afterTrade(q, "buy", sig, { qty, price: q.price, currency: q.currency });
  });
  sellBtn.addEventListener("click", () => {
    const qty = Math.floor(Number(qtyEl.value) || 0);
    if (qty <= 0) return;
    const result = sellStock(q.symbol, qty, q.price, q.currency, sig);
    afterTrade(q, "sell", sig, result);
  });
}

function afterTrade(q, side, sig, result) {
  renderPortfolio();
  renderDetail(state.quotes[q.symbol] || q);
  const short = q.symbol.replace(".NS", "");
  if (side === "sell" && result && result.realized != null) {
    setPage("portfolio");
    const cls = result.realized >= 0 ? "up" : "down";
    showTradeToast(
      `Sold ${result.qty} ${short} · P&amp;L ` +
        `<b class="${cls}">${signedMoney(result.realized, result.currency)}</b>`
    );
    return;
  }
  if (side === "buy") {
    const qty = result?.qty || 0;
    showTradeToast(
      `Bought ${qty} ${short}` +
        (sig && sig.recommendation
          ? ` · Pulse was <span class="badge ${badgeClass(sig.recommendation)}">${sig.recommendation}${
              sig.score != null ? ` ${sig.score > 0 ? "+" : ""}${sig.score}` : ""
            }</span>`
          : "")
    );
  }
}

function showTradeToast(html) {
  let toast = document.getElementById("tradeToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "tradeToast";
    toast.className = "trade-toast";
    document.body.appendChild(toast);
  }
  toast.innerHTML = html;
  toast.classList.add("show");
  clearTimeout(showTradeToast._t);
  showTradeToast._t = setTimeout(() => toast.classList.remove("show"), 3500);
}

const OVERLAY_COLORS = {
  sma10: "#ffb020",
  sma20: "#4f7cff",
  sma50: "#a06bff",
  ema9: "#ff8fb0",
  boll: "#8b96b3",
};

function overlayToggle(key, label) {
  const on = state.chart.overlays[key];
  const tip = escapeAttr(INDICATOR_INFO[label] || label);
  return `<button class="tb-toggle ${on ? "on" : ""}" data-overlay="${key}" style="--c:${OVERLAY_COLORS[key]}" title="${tip}" aria-label="${tip}">
    <span class="tb-swatch"></span>${label}
  </button>`;
}

function wireChartControls(q) {
  el.detailContent.querySelectorAll(".chart-type .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.chart.type = btn.dataset.type;
      el.detailContent
        .querySelectorAll(".chart-type .seg-btn")
        .forEach((b) => b.classList.toggle("on", b.dataset.type === state.chart.type));
      saveChartConfig();
      drawChart(q.candles, q.analysis?.patterns || []);
    });
  });
  el.detailContent.querySelectorAll(".tb-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.overlay;
      state.chart.overlays[key] = !state.chart.overlays[key];
      btn.classList.toggle("on", state.chart.overlays[key]);
      saveChartConfig();
      drawChart(q.candles, q.analysis?.patterns || []);
    });
  });
  const paneSel = el.detailContent.querySelector("#chartPane");
  if (paneSel) {
    paneSel.value = state.chart.pane;
    paneSel.addEventListener("change", () => {
      state.chart.pane = paneSel.value;
      saveChartConfig();
      drawChart(q.candles, q.analysis?.patterns || []);
    });
  }
}

function indCell(k, v, cls = "") {
  const tip = escapeAttr(INDICATOR_INFO[k] || k);
  return `<div class="ind-cell" title="${tip}" aria-label="${tip}">
    <div class="k" title="${tip}">${k}</div>
    <div class="v ${cls}" title="${tip}">${v}</div>
  </div>`;
}

function rsiClass(r) {
  if (r == null) return "";
  if (r < 30) return "up";
  if (r > 70) return "down";
  return "";
}

/* -------------------------------------------------------------------------- */
/*  Custom canvas chart (price + SMA20)                                        */
/* -------------------------------------------------------------------------- */

function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

function emaArr(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function bollingerBands(values, period = 20, mult = 2) {
  const mid = smaSeries(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sum / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

function rsiSeries(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macdSeriesCalc(values, fast = 12, slow = 26, sig = 9) {
  const ef = emaArr(values, fast);
  const es = emaArr(values, slow);
  const macd = values.map((_, i) =>
    ef[i] != null && es[i] != null ? ef[i] - es[i] : null
  );
  const idxs = macd.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0);
  const sigCompact = emaArr(idxs.map((i) => macd[i]), sig);
  const signal = new Array(values.length).fill(null);
  idxs.forEach((orig, k) => (signal[orig] = sigCompact[k]));
  const hist = values.map((_, i) =>
    macd[i] != null && signal[i] != null ? macd[i] - signal[i] : null
  );
  return { macd, signal, hist };
}

function formatVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

function getChartPatternMarkers(candles, patterns) {
  if (!candles?.length || !patterns?.length) return [];
  const n = candles.length;
  const groups = new Map();
  for (const p of patterns) {
    const bars = Math.max(1, Math.min(Number(p.bars) || 1, n));
    const start = n - bars;
    const end = n - 1;
    const bias = p.bias || "neutral";
    const key = `${start}:${end}:${bias}`;
    if (!groups.has(key)) groups.set(key, { start, end, bias, names: [] });
    groups.get(key).names.push(p.name);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    label: g.names.join(" / "),
  }));
}

function drawChart(candles, patterns = []) {
  const canvas = document.getElementById("chart");
  if (!canvas || !candles.length) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height || 320;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  ctx.font = "11px Inter, sans-serif";

  const pad = { l: 8, r: 60, t: 24, b: 36 };
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const opens = candles.map((c) => c.open);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume || 0);
  const times = candles.map((c) => c.t);
  const patternMarkers = getChartPatternMarkers(candles, patterns);

  const plotLeft = pad.l;
  const plotRight = w - pad.r;
  const plotTop = pad.t;
  const plotBottom = h - pad.b;
  const cfg = state.chart;

  // Optional lower indicator pane
  const hasPane = cfg.pane && cfg.pane !== "none";
  let priceBottom = plotBottom;
  let paneTop = 0;
  let paneBottom = 0;
  if (hasPane) {
    const paneGap = 26;
    const paneH = Math.max(52, (plotBottom - plotTop) * 0.28);
    priceBottom = plotBottom - paneH - paneGap;
    paneTop = priceBottom + paneGap;
    paneBottom = plotBottom;
  }

  const x = (i) =>
    plotLeft + (n === 1 ? 0 : (i / (n - 1)) * (plotRight - plotLeft));

  // Overlay series
  const overlays = [];
  const O = cfg.overlays;
  if (O.sma10)
    overlays.push({ label: "SMA10", color: OVERLAY_COLORS.sma10, data: smaSeries(closes, 10) });
  if (O.sma20)
    overlays.push({ label: "SMA20", color: OVERLAY_COLORS.sma20, data: smaSeries(closes, 20) });
  if (O.sma50)
    overlays.push({ label: "SMA50", color: OVERLAY_COLORS.sma50, data: smaSeries(closes, 50) });
  if (O.ema9)
    overlays.push({ label: "EMA9", color: OVERLAY_COLORS.ema9, data: emaArr(closes, 9) });
  const boll = O.boll ? bollingerBands(closes, 20, 2) : null;

  // Price domain (include visible overlays / bands)
  let pmin = Math.min(...closes);
  let pmax = Math.max(...closes);
  const consider = (arr) =>
    arr.forEach((v) => {
      if (v == null) return;
      if (v < pmin) pmin = v;
      if (v > pmax) pmax = v;
    });
  overlays.forEach((o) => consider(o.data));
  if (boll) {
    consider(boll.upper);
    consider(boll.lower);
  }
  if (cfg.type === "candle") {
    consider(highs);
    consider(lows);
  }
  const prange = pmax - pmin || 1;
  const priceInnerTop = plotTop + 4;
  const priceInnerBot = priceBottom - 4;
  const priceY = (v) =>
    priceInnerTop + (1 - (v - pmin) / prange) * (priceInnerBot - priceInnerTop);

  // Horizontal grid + price labels
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.textAlign = "left";
  for (let s = 0; s <= 4; s++) {
    const val = pmin + (prange * s) / 4;
    const yy = priceY(val);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.moveTo(plotLeft, yy);
    ctx.lineTo(plotRight, yy);
    ctx.stroke();
    ctx.fillStyle = "#8b96b3";
    ctx.fillText(val.toFixed(2), plotRight + 6, yy + 3);
  }

  // X-axis time labels + vertical gridlines
  const spanDays = n > 1 ? (times[n - 1] - times[0]) / 86400000 : 0;
  const fmtTick = (ms) => {
    const d = new Date(ms);
    if (spanDays <= 3)
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (spanDays <= 370)
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  };
  const xTicks = 5;
  for (let s = 0; s <= xTicks; s++) {
    const idx = Math.round((s / xTicks) * (n - 1));
    const px = x(idx);
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.beginPath();
    ctx.moveTo(px, plotTop);
    ctx.lineTo(px, plotBottom);
    ctx.stroke();
    ctx.fillStyle = "#8b96b3";
    ctx.textAlign = s === 0 ? "left" : s === xTicks ? "right" : "center";
    ctx.fillText(fmtTick(times[idx]), px, h - 12);
  }
  ctx.textAlign = "left";

  const drawSeries = (arr, color, width, dash) => {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) continue;
      const px = x(i);
      const py = priceY(arr[i]);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  const drawPatternHighlights = () => {
    if (!patternMarkers.length) return;
    const minBandWidth = Math.max(18, (plotRight - plotLeft) / Math.max(n, 16));
    patternMarkers.forEach((marker, idx) => {
      const leftEdge =
        marker.start <= 0 ? plotLeft : (x(marker.start - 1) + x(marker.start)) / 2;
      const rightEdge =
        marker.end >= n - 1 ? plotRight : (x(marker.end) + x(marker.end + 1)) / 2;
      const center = (leftEdge + rightEdge) / 2;
      const width = Math.max(minBandWidth, rightEdge - leftEdge);
      const left = Math.max(plotLeft, center - width / 2);
      const right = Math.min(plotRight, center + width / 2);
      const color =
        marker.bias === "bullish"
          ? "35,201,139"
          : marker.bias === "bearish"
            ? "255,92,114"
            : "139,150,179";

      ctx.fillStyle = `rgba(${color}, 0.10)`;
      ctx.fillRect(left, plotTop, right - left, priceBottom - plotTop);

      ctx.strokeStyle = `rgba(${color}, 0.55)`;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(left + 0.5, plotTop + 0.5, Math.max(1, right - left - 1), priceBottom - plotTop - 1);
      ctx.setLineDash([]);

      const label = marker.label.length > 26 ? marker.label.slice(0, 25) + "..." : marker.label;
      const tagY = plotTop + 8 + idx * 18;
      const padX = 6;
      ctx.font = "11px Inter, sans-serif";
      const tagW = ctx.measureText(label).width + padX * 2;
      const tagX = Math.min(Math.max(left, plotLeft), Math.max(plotLeft, plotRight - tagW));
      ctx.fillStyle = `rgba(${color}, 0.18)`;
      ctx.fillRect(tagX, tagY - 11, tagW, 16);
      ctx.strokeStyle = `rgba(${color}, 0.65)`;
      ctx.strokeRect(tagX + 0.5, tagY - 10.5, tagW - 1, 15);
      ctx.fillStyle = "#e8edf7";
      ctx.fillText(label, tagX + padX, tagY);
    });
  };

  // Bollinger band fill + lines (behind price)
  if (boll) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (boll.upper[i] == null) continue;
      const px = x(i);
      const py = priceY(boll.upper[i]);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    for (let i = n - 1; i >= 0; i--) {
      if (boll.lower[i] == null) continue;
      ctx.lineTo(x(i), priceY(boll.lower[i]));
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(139,150,179,0.08)";
    ctx.fill();
    drawSeries(boll.upper, OVERLAY_COLORS.boll, 1, [4, 3]);
    drawSeries(boll.lower, OVERLAY_COLORS.boll, 1, [4, 3]);
    drawSeries(boll.mid, OVERLAY_COLORS.boll, 1, [1, 3]);
  }

  drawPatternHighlights();

  const up = closes[n - 1] >= closes[0];
  const lineColor = up ? "#23c98b" : "#ff5c72";
  const GREEN = "#23c98b";
  const RED = "#ff5c72";

  if (cfg.type === "candle") {
    // Candlesticks: wick (high-low) + body (open-close)
    const cw = Math.max(1.5, ((plotRight - plotLeft) / n) * 0.62);
    for (let i = 0; i < n; i++) {
      const px = x(i);
      const bull = closes[i] >= opens[i];
      const col = bull ? GREEN : RED;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, priceY(highs[i]));
      ctx.lineTo(px, priceY(lows[i]));
      ctx.stroke();
      const yO = priceY(opens[i]);
      const yC = priceY(closes[i]);
      ctx.fillStyle = col;
      ctx.fillRect(px - cw / 2, Math.min(yO, yC), cw, Math.max(1, Math.abs(yC - yO)));
    }
  } else {
    // Line + area
    const grad = ctx.createLinearGradient(0, priceInnerTop, 0, priceBottom);
    grad.addColorStop(0, up ? "rgba(35,201,139,0.22)" : "rgba(255,92,114,0.22)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.beginPath();
    ctx.moveTo(x(0), priceY(closes[0]));
    for (let i = 0; i < n; i++) ctx.lineTo(x(i), priceY(closes[i]));
    ctx.lineTo(x(n - 1), priceBottom);
    ctx.lineTo(x(0), priceBottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = x(i);
      const py = priceY(closes[i]);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Moving-average / EMA overlays
  overlays.forEach((o) => drawSeries(o.data, o.color, 1.6, []));

  // Legend
  const legend = [
    cfg.type === "candle"
      ? { label: "Candles", color: "#c7cede" }
      : { label: "Price", color: lineColor },
    ...overlays,
  ];
  if (boll) legend.push({ label: "Bollinger", color: OVERLAY_COLORS.boll });
  let lx = plotLeft;
  legend.forEach((it) => {
    ctx.fillStyle = it.color;
    ctx.fillText("●", lx, 14);
    lx += 12;
    ctx.fillStyle = "#c7cede";
    ctx.fillText(it.label, lx, 14);
    lx += ctx.measureText(it.label).width + 14;
  });

  // Lower indicator pane
  if (hasPane) {
    const paneY = (v, dmin, dmax) => {
      const r = dmax - dmin || 1;
      return paneTop + 2 + (1 - (v - dmin) / r) * (paneBottom - paneTop - 2);
    };
    ctx.fillStyle = "#8b96b3";
    ctx.textAlign = "left";
    const label =
      cfg.pane === "rsi" ? "RSI (14)" : cfg.pane === "macd" ? "MACD (12,26,9)" : "Volume";
    ctx.fillText(label, plotLeft, paneTop - 8);

    if (cfg.pane === "rsi") {
      const rsi = rsiSeries(closes, 14);
      [30, 50, 70].forEach((lvl) => {
        const yy = paneY(lvl, 0, 100);
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.setLineDash(lvl === 50 ? [1, 3] : [3, 3]);
        ctx.beginPath();
        ctx.moveTo(plotLeft, yy);
        ctx.lineTo(plotRight, yy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#8b96b3";
        ctx.fillText(String(lvl), plotRight + 6, yy + 3);
      });
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (rsi[i] == null) continue;
        const px = x(i);
        const py = paneY(rsi[i], 0, 100);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = "#4f7cff";
      ctx.lineWidth = 1.6;
      ctx.stroke();
    } else if (cfg.pane === "macd") {
      const { macd, signal, hist } = macdSeriesCalc(closes);
      let dmin = Infinity;
      let dmax = -Infinity;
      [macd, signal, hist].forEach((a) =>
        a.forEach((v) => {
          if (v == null) return;
          if (v < dmin) dmin = v;
          if (v > dmax) dmax = v;
        })
      );
      if (!isFinite(dmin)) {
        dmin = -1;
        dmax = 1;
      }
      const padv = (dmax - dmin) * 0.1 || 1;
      dmin -= padv;
      dmax += padv;
      const zeroY = paneY(0, dmin, dmax);
      ctx.strokeStyle = "rgba(255,255,255,0.1)";
      ctx.beginPath();
      ctx.moveTo(plotLeft, zeroY);
      ctx.lineTo(plotRight, zeroY);
      ctx.stroke();
      const bw = Math.max(1, ((plotRight - plotLeft) / n) * 0.6);
      for (let i = 0; i < n; i++) {
        if (hist[i] == null) continue;
        const px = x(i);
        const py = paneY(hist[i], dmin, dmax);
        ctx.fillStyle = hist[i] >= 0 ? "rgba(35,201,139,0.6)" : "rgba(255,92,114,0.6)";
        ctx.fillRect(px - bw / 2, Math.min(py, zeroY), bw, Math.abs(py - zeroY));
      }
      const drawPane = (arr, color) => {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          if (arr[i] == null) continue;
          const px = x(i);
          const py = paneY(arr[i], dmin, dmax);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      };
      drawPane(macd, "#4f7cff");
      drawPane(signal, "#ff8fb0");
    } else {
      const maxV = Math.max(...vols, 1);
      const bw = Math.max(1, ((plotRight - plotLeft) / n) * 0.6);
      for (let i = 0; i < n; i++) {
        const px = x(i);
        const py = paneY(vols[i], 0, maxV);
        ctx.fillStyle =
          closes[i] >= opens[i] ? "rgba(35,201,139,0.5)" : "rgba(255,92,114,0.5)";
        ctx.fillRect(px - bw / 2, py, bw, paneBottom - py);
      }
      ctx.fillStyle = "#8b96b3";
      ctx.fillText(formatVol(maxV), plotRight + 6, paneY(maxV, 0, maxV) + 8);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Search / autocomplete                                                     */
/* -------------------------------------------------------------------------- */

let searchTimer = null;
let lastSuggestions = []; // most recent search results (search by symbol OR name)
let activeIdx = -1; // keyboard-highlighted suggestion

el.search.addEventListener("input", () => {
  const q = el.search.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 1) {
    closeSuggestions();
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(q)}&country=${state.country}`
      );
      const items = await res.json();
      renderSuggestions(items);
    } catch {
      closeSuggestions();
    }
  }, 200);
});

function closeSuggestions() {
  el.suggestions.classList.remove("open");
  lastSuggestions = [];
  activeIdx = -1;
}

function renderSuggestions(items) {
  lastSuggestions = items || [];
  activeIdx = -1;
  if (!lastSuggestions.length) {
    el.suggestions.innerHTML = `<div class="suggestion empty">No matches — press Enter to try the symbol anyway</div>`;
    el.suggestions.classList.add("open");
    return;
  }
  el.suggestions.innerHTML = lastSuggestions
    .map(
      (it, idx) =>
        `<div class="suggestion" data-idx="${idx}" data-symbol="${it.symbol}">
          <span class="sym">${it.symbol}</span>
          <span class="name">${it.name} · ${it.exchange}</span>
        </div>`
    )
    .join("");
  el.suggestions.classList.add("open");
  el.suggestions.querySelectorAll(".suggestion").forEach((node) => {
    node.addEventListener("click", () => {
      pickSymbol(node.dataset.symbol);
    });
  });
}

function pickSymbol(symbol) {
  addSymbol(symbol);
  el.search.value = "";
  closeSuggestions();
}

function highlight() {
  el.suggestions.querySelectorAll(".suggestion").forEach((n, i) => {
    n.classList.toggle("active", i === activeIdx);
  });
}

el.search.addEventListener("keydown", (e) => {
  const open = el.suggestions.classList.contains("open");
  if (e.key === "ArrowDown" && open) {
    e.preventDefault();
    activeIdx = Math.min(activeIdx + 1, lastSuggestions.length - 1);
    highlight();
  } else if (e.key === "ArrowUp" && open) {
    e.preventDefault();
    activeIdx = Math.max(activeIdx - 1, 0);
    highlight();
  } else if (e.key === "Enter") {
    const typed = el.search.value.trim();
    if (!typed) return;
    // Prefer the highlighted result, else the top match (so typing a company
    // NAME and pressing Enter resolves to the correct ticker).
    if (activeIdx >= 0 && lastSuggestions[activeIdx]) {
      pickSymbol(lastSuggestions[activeIdx].symbol);
    } else if (lastSuggestions.length) {
      pickSymbol(lastSuggestions[0].symbol);
    } else {
      pickSymbol(typed);
    }
  } else if (e.key === "Escape") {
    closeSuggestions();
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) closeSuggestions();
});

/* -------------------------------------------------------------------------- */
/*  Refresh controls                                                          */
/* -------------------------------------------------------------------------- */

function scheduleRefresh() {
  if (state.timer) clearInterval(state.timer);
  if (state.refreshMs > 0) {
    state.timer = setInterval(() => {
      refreshAll();
      refreshMovers();
    }, state.refreshMs);
  }
}

el.interval.addEventListener("change", () => {
  state.refreshMs = Number(el.interval.value);
  scheduleRefresh();
});

el.recoFilter.addEventListener("change", () => {
  state.recoFilter = el.recoFilter.value;
  renderWatchlist();
});

el.capFilter?.addEventListener("change", () => {
  state.capFilter = el.capFilter.value;
  renderWatchlist();
});

el.sortFilter?.addEventListener("change", () => {
  state.sortBy = el.sortFilter.value;
  renderWatchlist();
});

el.tabWatchlist?.addEventListener("click", () => {
  state.marketView = "watchlist";
  renderWatchlist();
});

el.tabAllStocks?.addEventListener("click", async () => {
  state.marketView = "all";
  renderWatchlist();
  if (!state.universe.length) await refreshUniverse();
  await refreshAll();
});

el.country.addEventListener("change", () => {
  state.country = el.country.value;
  saveCountry();
  updateMarketHoursUI();
  state.watchlist = loadWatchlist(state.country);
  state.universe = [];
  state.quotes = {};
  state.selected = null;
  el.detailContent.classList.add("hidden");
  el.emptyState.classList.remove("hidden");
  el.search.value = "";
  el.suggestions.classList.remove("open");
  closeMoversEditor();
  renderWatchlist();
  refreshMovers();
  refreshUniverse().then(() => refreshAll()).then(() => {
    if (state.marketView !== "all" && state.watchlist.length) selectSymbol(state.watchlist[0]);
  });
});

el.refreshAll.addEventListener("click", () => {
  refreshAll();
  refreshMovers();
});

el.moversConfig.addEventListener("click", () => {
  if (el.moversEditor.classList.contains("hidden")) openMoversEditor();
  else closeMoversEditor();
});
el.newsRefresh?.addEventListener("click", () => refreshNews(true));
el.moversCancel.addEventListener("click", closeMoversEditor);
el.moversSave.addEventListener("click", () => {
  const symbols = parseSymbolList(el.moversInput.value);
  applyMoversUniverse(symbols.length ? symbols : null);
});
el.moversUseWatchlist.addEventListener("click", () => {
  el.moversInput.value = state.watchlist.join(", ");
});
el.moversReset.addEventListener("click", () => {
  el.moversInput.value = "";
  applyMoversUniverse(null);
});

el.portfolioReset.addEventListener("click", () => {
  if (!confirm("Reset your paper portfolio? This clears all holdings and trade history.")) return;
  state.portfolio = { positions: {}, trades: [], realized: {} };
  state.signalAlerts = {};
  savePortfolio();
  saveSignalAlerts();
  renderPortfolio();
  if (state.selected && state.quotes[state.selected]) {
    renderDetail(state.quotes[state.selected]);
  }
});

if (el.pnlPeriodBar) {
  el.pnlPeriodBar.querySelectorAll(".pnl-period-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.pnlPeriod.key = btn.dataset.period;
      if (state.pnlPeriod.key === "custom") {
        // Default custom window to last 30 days if empty
        if (!state.pnlPeriod.from || !state.pnlPeriod.to) {
          const to = new Date();
          const from = new Date(to.getTime() - 29 * 86400000);
          const iso = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, "0");
            const day = String(d.getDate()).padStart(2, "0");
            return `${y}-${m}-${day}`;
          };
          state.pnlPeriod.from = iso(from);
          state.pnlPeriod.to = iso(to);
          if (el.pnlFrom) el.pnlFrom.value = state.pnlPeriod.from;
          if (el.pnlTo) el.pnlTo.value = state.pnlPeriod.to;
        }
      }
      savePnlPeriod();
      renderPortfolio();
    });
  });
}
if (el.pnlCustomApply) {
  el.pnlCustomApply.addEventListener("click", () => {
    state.pnlPeriod.key = "custom";
    state.pnlPeriod.from = el.pnlFrom?.value || "";
    state.pnlPeriod.to = el.pnlTo?.value || "";
    savePnlPeriod();
    renderPortfolio();
  });
}

window.addEventListener("resize", () => {
  if (state.selected && state.quotes[state.selected]) {
    const q = state.quotes[state.selected];
    drawChart(q.candles, q.analysis?.patterns || []);
  }
});

/* -------------------------------------------------------------------------- */
/*  Boot                                                                      */
/* -------------------------------------------------------------------------- */

function bootData() {
  setPage(getInitialPage(), false);
  updateAlertsUI();
  updateMarketTabs();
  updateMarketHoursUI();
  if (updateMarketHoursUI._timer) clearInterval(updateMarketHoursUI._timer);
  updateMarketHoursUI._timer = setInterval(updateMarketHoursUI, 30_000);
  el.country.value = state.country;
  renderWatchlist();
  renderPortfolio();
  refreshMovers();
  refreshUniverse().then(() => refreshAll()).then(() => {
    if (state.page === "market" && state.marketView !== "all" && !state.selected && state.watchlist.length) {
      selectSymbol(state.watchlist[0]);
    }
  });
}

// Re-read namespaced storage into state after an auth change, then re-render.
async function reloadUserData() {
  // Guests: local only. Signed-in: pull server copy (or upload local on first sync).
  if (currentUser) {
    await syncOnLogin();
  }
  state.country = loadCountry();
  state.watchlist = loadWatchlist(state.country);
  state.universe = [];
  state.chart = loadChartConfig();
  state.portfolio = loadPortfolio();
  state.pnlPeriod = loadPnlPeriod();
  state.signalAlerts = loadSignalAlerts();
  state.recoFilter = "ALL";
  state.quotes = {};
  state.selected = null;
  if (el.recoFilter) el.recoFilter.value = "ALL";
  el.detailContent.classList.add("hidden");
  el.emptyState.classList.remove("hidden");
  bootData();
}

/* --------------------------- Google authentication ----------------------- */

let authClientId = null;

function setUser(user) {
  currentUser = user;
  state.user = user;
}

function updateAuthUI() {
  if (state.user) {
    el.userChip.classList.remove("hidden");
    el.signInNav.classList.add("hidden");
    el.userAvatar.src = state.user.picture || "";
    el.userAvatar.style.display = state.user.picture ? "" : "none";
    el.userName.textContent = state.user.name || state.user.email || "Account";
  } else {
    el.userChip.classList.add("hidden");
    el.signInNav.classList.remove("hidden");
  }
}

function showAuthView(name) {
  el.viewSignin.classList.toggle("hidden", name !== "signin");
  el.viewSignup.classList.toggle("hidden", name !== "signup");
  el.viewVerify.classList.toggle("hidden", name !== "verify");
  el.viewReset.classList.toggle("hidden", name !== "reset");
  clearAuthErrors();
}

function clearAuthErrors() {
  [el.loginError, el.signupError, el.verifyError, el.resetError].forEach((n) => {
    if (n) {
      n.textContent = "";
      n.classList.add("hidden");
    }
  });
}

function showError(node, msg) {
  node.textContent = msg;
  node.classList.remove("hidden");
}

function showLogin(view) {
  el.loginOverlay.classList.remove("hidden");
  showAuthView(view || "signin");
  if (authClientId) {
    hideGoogleUnavailable();
    renderGoogleButton();
  } else {
    showGoogleUnavailable();
  }
}
function hideLogin() {
  el.loginOverlay.classList.add("hidden");
}
function showGoogleUnavailable() {
  el.googleUnavailable.classList.remove("hidden");
  el.googleBtn.classList.add("hidden");
}
function hideGoogleUnavailable() {
  el.googleUnavailable.classList.add("hidden");
  el.googleBtn.classList.remove("hidden");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function initGoogle(clientId) {
  loadScript("https://accounts.google.com/gsi/client")
    .then(() => {
      if (!window.google || !google.accounts || !google.accounts.id) {
        showGoogleUnavailable();
        return;
      }
      google.accounts.id.initialize({
        client_id: clientId,
        callback: onGoogleCredential,
      });
      renderGoogleButton();
    })
    .catch(() => showGoogleUnavailable());
}

function renderGoogleButton() {
  if (!window.google || !google.accounts || !google.accounts.id) return;
  el.googleBtn.innerHTML = "";
  google.accounts.id.renderButton(el.googleBtn, {
    theme: "filled_blue",
    size: "large",
    shape: "pill",
    text: "signin_with",
    logo_alignment: "left",
    width: 260,
  });
}

async function onGoogleCredential(resp) {
  try {
    const r = await fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: resp.credential }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Login failed");
    localStorage.removeItem("authMode");
    setUser(data.user);
    updateAuthUI();
    hideLogin();
    reloadUserData();
  } catch (e) {
    alert("Google sign-in failed: " + e.message);
  }
}

async function signOut() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {}
  if (window.google && google.accounts && google.accounts.id)
    google.accounts.id.disableAutoSelect();
  setUser(null);
  localStorage.removeItem("authMode");
  updateAuthUI();
  reloadUserData();
  showLogin();
}

/* ----------------------- Email + password authentication ----------------- */

let pendingEmail = "";

async function postJson(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

function onAuthSuccess(user) {
  localStorage.removeItem("authMode");
  setUser(user);
  updateAuthUI();
  hideLogin();
  reloadUserData();
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label || "Please wait…";
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
}

el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAuthErrors();
  const email = el.loginEmail.value.trim();
  const password = el.loginPassword.value;
  if (!email || !password) return showError(el.loginError, "Enter your email and password.");
  setBusy(el.loginSubmit, true, "Signing in…");
  try {
    const { ok, data } = await postJson("/api/auth/login", { email, password });
    if (!ok) return showError(el.loginError, data.error || "Sign in failed.");
    onAuthSuccess(data.user);
  } catch {
    showError(el.loginError, "Network error. Please try again.");
  } finally {
    setBusy(el.loginSubmit, false);
  }
});

el.signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAuthErrors();
  const name = el.signupName.value.trim();
  const email = el.signupEmail.value.trim();
  const password = el.signupPassword.value;
  if (!name || !email || !password)
    return showError(el.signupError, "Please fill in all fields.");
  if (password.length < 6)
    return showError(el.signupError, "Password must be at least 6 characters.");
  setBusy(el.signupSubmit, true, "Sending code…");
  try {
    const { ok, data } = await postJson("/api/auth/signup", { name, email, password });
    if (!ok) return showError(el.signupError, data.error || "Sign up failed.");
    pendingEmail = data.email || email;
    el.verifyEmail.textContent = pendingEmail;
    el.verifyCode.value = "";
    showDevOtp(data);
    showAuthView("verify");
    el.verifyCode.focus();
  } catch {
    showError(el.signupError, "Network error. Please try again.");
  } finally {
    setBusy(el.signupSubmit, false);
  }
});

el.verifyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAuthErrors();
  const code = el.verifyCode.value.trim();
  if (!/^[0-9]{6}$/.test(code))
    return showError(el.verifyError, "Enter the 6-digit code.");
  setBusy(el.verifySubmit, true, "Verifying…");
  try {
    const { ok, data } = await postJson("/api/auth/verify-otp", {
      email: pendingEmail,
      code,
    });
    if (!ok) return showError(el.verifyError, data.error || "Verification failed.");
    onAuthSuccess(data.user);
  } catch {
    showError(el.verifyError, "Network error. Please try again.");
  } finally {
    setBusy(el.verifySubmit, false);
  }
});

el.resendOtp.addEventListener("click", async () => {
  clearAuthErrors();
  if (!pendingEmail) return showAuthView("signup");
  setBusy(el.verifySubmit, true, "Sending…");
  try {
    const { ok, data } = await postJson("/api/auth/resend-otp", { email: pendingEmail });
    if (!ok) return showError(el.verifyError, data.error || "Could not resend code.");
    showDevOtp(data);
  } catch {
    showError(el.verifyError, "Network error. Please try again.");
  } finally {
    setBusy(el.verifySubmit, false);
  }
});

function showDevOtp(data) {
  if (data && data.emailDelivery === false && data.devOtp) {
    el.devOtpNote.textContent =
      `Email delivery isn't configured on this server, so here's your code for testing: ${data.devOtp}`;
    el.devOtpNote.classList.remove("hidden");
  } else {
    el.devOtpNote.classList.add("hidden");
    el.devOtpNote.textContent = "";
  }
}

el.toSignup.addEventListener("click", () => showAuthView("signup"));
el.toSignin.addEventListener("click", () => showAuthView("signin"));
el.backToSignup.addEventListener("click", () => showAuthView("signup"));
el.toReset.addEventListener("click", () => {
  el.resetStep2.classList.add("hidden");
  el.resetDevOtp.classList.add("hidden");
  el.resetCode.value = "";
  el.resetNewPw.value = "";
  if (el.loginEmail.value) el.resetEmail.value = el.loginEmail.value;
  showAuthView("reset");
});
el.backToSignin.addEventListener("click", () => showAuthView("signin"));

el.resetSendBtn.addEventListener("click", async () => {
  clearAuthErrors();
  const email = el.resetEmail.value.trim();
  if (!email) return showError(el.resetError, "Enter your email address.");
  setBusy(el.resetSendBtn, true, "Sending…");
  try {
    const { ok, data } = await postJson("/api/auth/forgot-password", { email });
    if (!ok) return showError(el.resetError, data.error || "Could not send code.");
    el.resetStep2.classList.remove("hidden");
    if (data.emailDelivery === false && data.devOtp) {
      el.resetDevOtp.textContent =
        `Email delivery isn't configured — use this code: ${data.devOtp}`;
      el.resetDevOtp.classList.remove("hidden");
    } else {
      el.resetDevOtp.classList.add("hidden");
    }
  } catch {
    showError(el.resetError, "Network error. Please try again.");
  } finally {
    setBusy(el.resetSendBtn, false);
  }
});

el.resetForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAuthErrors();
  const email = el.resetEmail.value.trim();
  const code = el.resetCode.value.trim();
  const newPassword = el.resetNewPw.value;
  if (!/^[0-9]{6}$/.test(code))
    return showError(el.resetError, "Enter the 6-digit code.");
  if (newPassword.length < 6)
    return showError(el.resetError, "New password must be at least 6 characters.");
  setBusy(el.resetSubmit, true, "Resetting…");
  try {
    const { ok, data } = await postJson("/api/auth/reset-password", {
      email,
      code,
      newPassword,
    });
    if (!ok) return showError(el.resetError, data.error || "Reset failed.");
    onAuthSuccess(data.user);
  } catch {
    showError(el.resetError, "Network error. Please try again.");
  } finally {
    setBusy(el.resetSubmit, false);
  }
});

el.signOutBtn.addEventListener("click", signOut);
el.signInNav.addEventListener("click", () => showLogin("signin"));
el.guestBtn.addEventListener("click", () => {
  localStorage.setItem("authMode", "guest");
  hideLogin();
});
el.loginOverlay.addEventListener("click", (e) => {
  if (e.target === el.loginOverlay) {
    localStorage.setItem("authMode", "guest");
    hideLogin();
  }
});

async function initAuth() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    authClientId = cfg.googleClientId || null;
  } catch {
    authClientId = null;
  }
  let user = null;
  try {
    const me = await (await fetch("/api/me")).json();
    user = me.user || null;
  } catch {}

  if (user) setUser(user);
  updateAuthUI();
  reloadUserData();

  if (authClientId) initGoogle(authClientId);

  if (!user && localStorage.getItem("authMode") !== "guest") showLogin();
  else hideLogin();
}

/* -------------------------------- Profile -------------------------------- */

function initials(name, email) {
  const src = (name || email || "?").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function showMsg(node, msg, ok) {
  node.textContent = msg;
  node.classList.remove("hidden");
  node.classList.toggle("ok", !!ok);
  node.classList.toggle("bad", !ok);
}
function clearMsg(node) {
  node.textContent = "";
  node.classList.add("hidden");
}

function openProfile() {
  const u = state.user;
  if (!u) return showLogin("signin");

  // Header
  if (u.picture) {
    el.profileAvatar.innerHTML = `<img src="${u.picture}" alt="" referrerpolicy="no-referrer" />`;
  } else {
    el.profileAvatar.textContent = initials(u.name, u.email);
  }
  el.profileName.textContent = u.name || "—";
  el.profileEmail.textContent = u.email || "";
  const providerLabel = u.provider === "google" ? "Google account" : "Email account";
  el.profileProvider.textContent = providerLabel;
  el.profileSince.textContent = u.createdAt
    ? "Joined " + new Date(u.createdAt).toLocaleDateString()
    : "";

  // Personal details list
  el.pdName.textContent = u.name || "—";
  el.pdEmail.textContent = u.email || "—";
  el.pdProvider.textContent = providerLabel;
  el.pdSince.textContent = u.createdAt
    ? new Date(u.createdAt).toLocaleString()
    : "—";
  el.pdId.textContent = (u.sub || "").replace(/^email:/, "") || "—";
  const watchN = state.watchlist.length;
  const holdN = Object.keys(state.portfolio.positions || {}).length;
  const tradeN = (state.portfolio.trades || []).length;
  el.pdWatch.textContent = String(watchN);
  el.pdHoldings.textContent = String(holdN);
  el.pdTrades.textContent = String(tradeN);
  renderTraderClassification();

  // Stats (from the current per-user local data)
  el.statWatch.textContent = watchN;
  el.statHoldings.textContent = holdN;
  el.statTrades.textContent = tradeN;

  const realized = state.portfolio.realized || {};
  const entries = Object.entries(realized).filter(([, v]) => v);
  if (entries.length) {
    el.statRealized.innerHTML =
      `<span class="realized-label">Realized P&amp;L</span>` +
      entries
        .map(
          ([ccy, v]) =>
            `<span class="realized-val ${v >= 0 ? "up" : "down"}">${signedMoney(v, ccy)}</span>`
        )
        .join("");
    el.statRealized.classList.remove("hidden");
  } else {
    el.statRealized.classList.add("hidden");
  }

  // Name edit + password change only apply to email accounts.
  const isEmail = u.provider === "email";
  el.profilePwWrap.classList.toggle("hidden", !isEmail);
  el.profileNameInput.value = u.name || "";
  clearMsg(el.profileNameMsg);
  clearMsg(el.profilePwMsg);
  el.pwCurrent.value = "";
  el.pwNew.value = "";
  el.profileResetBox.classList.add("hidden");
  el.profileResetStep2.classList.add("hidden");
  el.profileResetDev.classList.add("hidden");
  clearMsg(el.profileResetMsg);
  el.profileResetCode.value = "";
  el.profileResetNewPw.value = "";
  if (el.profileResetEmail) el.profileResetEmail.textContent = u.email || "";

  el.profileOverlay.classList.remove("hidden");
}

function closeProfile() {
  el.profileOverlay.classList.add("hidden");
}

el.profileBtn.addEventListener("click", openProfile);
el.profileClose.addEventListener("click", closeProfile);
el.profileOverlay.addEventListener("click", (e) => {
  if (e.target === el.profileOverlay) closeProfile();
});
el.profileSignOut.addEventListener("click", () => {
  closeProfile();
  signOut();
});

el.profileNameForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearMsg(el.profileNameMsg);
  const name = el.profileNameInput.value.trim();
  if (!name) return showMsg(el.profileNameMsg, "Name cannot be empty.", false);
  setBusy(el.profileNameSave, true, "Saving…");
  try {
    const { ok, data } = await postJson("/api/profile", { name });
    if (!ok) return showMsg(el.profileNameMsg, data.error || "Could not save.", false);
    setUser(data.user);
    updateAuthUI();
    el.profileName.textContent = data.user.name;
    if (el.pdName) el.pdName.textContent = data.user.name;
    showMsg(el.profileNameMsg, "Saved.", true);
  } catch {
    showMsg(el.profileNameMsg, "Network error.", false);
  } finally {
    setBusy(el.profileNameSave, false);
  }
});

el.profilePwForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearMsg(el.profilePwMsg);
  const currentPassword = el.pwCurrent.value;
  const newPassword = el.pwNew.value;
  if (!currentPassword || !newPassword)
    return showMsg(el.profilePwMsg, "Fill in both password fields.", false);
  if (newPassword.length < 6)
    return showMsg(el.profilePwMsg, "New password must be at least 6 characters.", false);
  setBusy(el.profilePwSave, true, "Updating…");
  try {
    const { ok, data } = await postJson("/api/auth/change-password", {
      currentPassword,
      newPassword,
    });
    if (!ok) return showMsg(el.profilePwMsg, data.error || "Could not update password.", false);
    el.pwCurrent.value = "";
    el.pwNew.value = "";
    showMsg(el.profilePwMsg, "Password updated.", true);
  } catch {
    showMsg(el.profilePwMsg, "Network error.", false);
  } finally {
    setBusy(el.profilePwSave, false);
  }
});

el.profileResetPw.addEventListener("click", () => {
  el.profileResetBox.classList.toggle("hidden");
  clearMsg(el.profileResetMsg);
});

el.profileResetSend.addEventListener("click", async () => {
  clearMsg(el.profileResetMsg);
  const email = state.user?.email;
  if (!email) return;
  setBusy(el.profileResetSend, true, "Sending…");
  try {
    const { ok, data } = await postJson("/api/auth/forgot-password", { email });
    if (!ok) return showMsg(el.profileResetMsg, data.error || "Could not send code.", false);
    el.profileResetStep2.classList.remove("hidden");
    if (data.emailDelivery === false && data.devOtp) {
      el.profileResetDev.textContent = `Dev code: ${data.devOtp}`;
      el.profileResetDev.classList.remove("hidden");
    } else {
      el.profileResetDev.classList.add("hidden");
    }
    showMsg(el.profileResetMsg, "Code sent. Check your email.", true);
  } catch {
    showMsg(el.profileResetMsg, "Network error.", false);
  } finally {
    setBusy(el.profileResetSend, false);
  }
});

el.profileResetConfirm.addEventListener("click", async () => {
  clearMsg(el.profileResetMsg);
  const email = state.user?.email;
  const code = el.profileResetCode.value.trim();
  const newPassword = el.profileResetNewPw.value;
  if (!/^[0-9]{6}$/.test(code))
    return showMsg(el.profileResetMsg, "Enter the 6-digit code.", false);
  if (newPassword.length < 6)
    return showMsg(el.profileResetMsg, "New password must be at least 6 characters.", false);
  setBusy(el.profileResetConfirm, true, "Saving…");
  try {
    const { ok, data } = await postJson("/api/auth/reset-password", {
      email,
      code,
      newPassword,
    });
    if (!ok) return showMsg(el.profileResetMsg, data.error || "Reset failed.", false);
    setUser(data.user);
    updateAuthUI();
    el.profileResetCode.value = "";
    el.profileResetNewPw.value = "";
    el.profileResetStep2.classList.add("hidden");
    el.profileResetBox.classList.add("hidden");
    showMsg(el.profilePwMsg, "Password reset successfully.", true);
  } catch {
    showMsg(el.profileResetMsg, "Network error.", false);
  } finally {
    setBusy(el.profileResetConfirm, false);
  }
});

// Register the service worker (only succeeds on https or localhost).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => reg.update())
      .catch(() => {});
  });
}

scheduleRefresh();
initAuth();
