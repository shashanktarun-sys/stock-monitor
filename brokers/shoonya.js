/**
 * Shoonya (Finvasia) live broker adapter.
 * Retail auth (from Apr 2026): OAuth authorize → GenAcsTok access_token (Bearer).
 * QuickAuth / vendor code / IMEI are obsolete for retail accounts.
 * Does NOT fill the paper portfolio — broker is source of truth for live orders.
 */
import crypto from "node:crypto";
import { VENUES } from "./types.js";
import { insertOrder, getBrokerConnection, upsertBrokerConnection } from "../lib/store.js";

const HOST_API = "https://api.shoonya.com/NorenWClientAPI";

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** OAuth authorize URL — open this, log in, then copy `code` from the redirect URL. */
export function shoonyaAuthorizeUrl(userid) {
  const uid = String(userid || "").trim().toUpperCase();
  const clientId = uid.endsWith("_U") ? uid : `${uid}_U`;
  return `https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id=${encodeURIComponent(clientId)}`;
}

async function shoonyaPost(endpoint, jData, accessToken = null, { allowEmpty = false } = {}) {
  // Shoonya expects raw `jData={json}` (+ optional Bearer access token).
  const body = `jData=${JSON.stringify(jData)}`;
  const url = `${HOST_API}/${endpoint}`;
  const headers = { "Content-Type": "text/plain" };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  let res;
  let text;
  try {
    res = await fetch(url, { method: "POST", headers, body });
    text = await res.text();
  } catch (netErr) {
    const err = new Error(`Could not reach Shoonya API: ${netErr.message}`);
    err.status = 502;
    throw err;
  }

  console.log(
    `[shoonya] /${endpoint} http=${res.status} body=${String(text).slice(0, 300)}`
  );

  if (res.status >= 500 && /bad gateway|html/i.test(text)) {
    const err = new Error(
      `Shoonya gateway error (${res.status}) on ${endpoint}. Try again shortly.`
    );
    err.status = 502;
    throw err;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error(
      `Shoonya returned non-JSON (${res.status}): ${String(text).slice(0, 160)}`
    );
    err.status = 502;
    throw err;
  }
  if (json?.stat === "Not_Ok") {
    const emsg = String(json.emsg || "");
    if (
      allowEmpty &&
      /no data|no (open )?position|no order|no trade|not available/i.test(emsg)
    ) {
      return [];
    }
    const err = new Error(emsg || "Shoonya API error");
    err.status = 400;
    err.shoonya = json;
    throw err;
  }
  return json;
}

/**
 * Map Pulse symbols to Shoonya equity contract.
 * RELIANCE.NS → { exch: "NSE", tsym: "RELIANCE-EQ" }
 * SBIN.BO → { exch: "BSE", tsym: "SBIN-EQ" }
 */
export function mapPulseSymbolToShoonya(symbol) {
  const raw = String(symbol || "").toUpperCase().trim();
  if (!raw) return null;
  let exch = "NSE";
  let base = raw;
  if (raw.endsWith(".NS")) {
    exch = "NSE";
    base = raw.slice(0, -3);
  } else if (raw.endsWith(".BO") || raw.endsWith(".BSE")) {
    exch = "BSE";
    base = raw.replace(/\.BO$|\.BSE$/, "");
  }
  const tsym = base.includes("-") ? base : `${base}-EQ`;
  return { exch, tsym, base };
}

/**
 * OAuth token exchange (retail flow since Apr 2026).
 * checksum = SHA256(clientId + secretCode + authCode) with no separators.
 * clientId for OAuth is typically UserID_U.
 */
export async function shoonyaLogin({ userid, apiSecret, authCode, clientId }) {
  const uid = String(userid || "").trim().toUpperCase();
  const secret = String(apiSecret || "").trim();
  let code = String(authCode || "").trim();
  // Allow pasting a full redirect URL that contains ?code=...
  try {
    if (/code=/i.test(code)) {
      const u = new URL(code.includes("://") ? code : `https://x/?${code.replace(/^\?/, "")}`);
      code = u.searchParams.get("code") || code;
    }
  } catch {
    /* keep raw code */
  }
  const oauthClientId = String(clientId || (uid.endsWith("_U") ? uid : `${uid}_U`)).trim();

  if (!uid || !secret || !code) {
    const err = new Error(
      "User ID, API secret (from trade.shoonya.com), and OAuth auth code are required"
    );
    err.status = 400;
    throw err;
  }

  const checksum = sha256Hex(`${oauthClientId}${secret}${code}`);
  console.log(
    `[shoonya] GenAcsTok uid=${uid} clientId=${oauthClientId} code_len=${code.length}`
  );

  const data = await shoonyaPost("GenAcsTok", {
    uid,
    code,
    checksum,
  });

  const token = data.access_token || data.susertoken;
  if (!token) {
    const err = new Error(
      data.emsg ||
        "Shoonya did not return an access token. Whitelist this server's public IP in Shoonya API settings, then retry with a fresh auth code."
    );
    err.status = 401;
    throw err;
  }

  return {
    susertoken: token, // used as Bearer
    accessToken: token,
    uid: data.USERID || data.uid || uid,
    actid: data.actid || data.accountId || data.USERID || uid,
    uname: data.uname || data.userName || "",
    email: data.email || "",
    exarr: data.exarr || [],
    loggedInAt: Date.now(),
    clientId: oauthClientId,
    authMethod: "oauth",
    apiSecretFingerprint: sha256Hex(secret).slice(0, 12),
  };
}

export async function shoonyaLogout(tokens) {
  if (!tokens?.susertoken || !tokens?.uid) return;
  try {
    await shoonyaPost("Logout", { uid: tokens.uid }, tokens.susertoken);
  } catch {
    /* ignore */
  }
}

async function withSession(userSub, fn) {
  const conn = await getBrokerConnection(userSub, VENUES.SHOONYA);
  if (!conn || conn.status !== "connected" || !conn.tokens?.susertoken) {
    const err = new Error("Shoonya is not connected. Open Profile → Connect Shoonya.");
    err.status = 401;
    throw err;
  }
  try {
    return await fn(conn.tokens);
  } catch (err) {
    const msg = String(err.message || "").toLowerCase();
    if (msg.includes("session") || msg.includes("invalid") || msg.includes("login")) {
      await upsertBrokerConnection({
        userSub,
        provider: VENUES.SHOONYA,
        status: "disconnected",
        tokens: null,
        meta: { lastError: err.message, disconnectedAt: Date.now() },
      });
    }
    throw err;
  }
}

export function createShoonyaBroker() {
  return {
    venue: VENUES.SHOONYA,

    async placeOrder(input) {
      const qty = Math.floor(Number(input.qty) || 0);
      if (!(qty > 0)) {
        const err = new Error("Quantity must be a positive integer");
        err.status = 400;
        throw err;
      }
      const mapped = mapPulseSymbolToShoonya(input.symbol);
      if (!mapped) {
        const err = new Error("Symbol is required");
        err.status = 400;
        throw err;
      }
      if (!String(input.symbol).match(/\.NS$|\.BO$|\.BSE$/i) && input.currency === "USD") {
        const err = new Error("Shoonya only supports Indian exchange symbols (.NS / .BO)");
        err.status = 400;
        throw err;
      }

      const side = String(input.side || "").toLowerCase();
      if (side !== "buy" && side !== "sell") {
        const err = new Error('Side must be "buy" or "sell"');
        err.status = 400;
        throw err;
      }

      const orderType = String(input.orderType || "market").toLowerCase();
      const isMarket = orderType === "market";
      const product = String(input.product || "C").toUpperCase();

      const orderId = crypto.randomUUID();
      const now = Date.now();

      let brokerOrderId = null;
      let status = "submitted";
      let fillPrice = null;
      let errorMsg = null;

      try {
        const resp = await withSession(input.userSub, async (tokens) => {
          const jData = {
            uid: tokens.uid,
            actid: tokens.actid || tokens.uid,
            exch: mapped.exch,
            tsym: mapped.tsym,
            qty: String(qty),
            prc: isMarket ? "0" : String(input.limitPrice ?? input.clientPrice ?? 0),
            trgprc: "0",
            dscqty: "0",
            prd: product === "I" || product === "MIS" ? "I" : "C",
            trantype: side === "buy" ? "B" : "S",
            prctyp: isMarket ? "MKT" : "LMT",
            ret: "DAY",
            remarks: `pulse:${orderId}`,
            ordersource: "API",
          };
          return shoonyaPost("PlaceOrder", jData, tokens.susertoken);
        });

        brokerOrderId = resp.norenordno || null;
        status = brokerOrderId ? "submitted" : "rejected";
        if (!brokerOrderId) errorMsg = resp.emsg || "No order id returned";
        fillPrice = Number(input.clientPrice) || null;
      } catch (err) {
        status = "rejected";
        errorMsg = err.message;
        await insertOrder({
          id: orderId,
          userSub: input.userSub,
          venue: VENUES.SHOONYA,
          symbol: String(input.symbol).toUpperCase(),
          side,
          qty,
          orderType: isMarket ? "market" : "limit",
          limitPrice: input.limitPrice ?? null,
          status,
          fillPrice: null,
          brokerOrderId: null,
          error: errorMsg,
          createdAt: now,
          updatedAt: Date.now(),
          meta: { exch: mapped.exch, tsym: mapped.tsym, source: input.opts?.source || "pilot" },
        });
        throw err;
      }

      await insertOrder({
        id: orderId,
        userSub: input.userSub,
        venue: VENUES.SHOONYA,
        symbol: String(input.symbol).toUpperCase(),
        side,
        qty,
        orderType: isMarket ? "market" : "limit",
        limitPrice: input.limitPrice ?? null,
        status,
        fillPrice,
        brokerOrderId,
        error: errorMsg,
        createdAt: now,
        updatedAt: Date.now(),
        meta: { exch: mapped.exch, tsym: mapped.tsym, source: input.opts?.source || "pilot" },
      });

      return {
        orderId,
        venue: VENUES.SHOONYA,
        status,
        brokerOrderId,
        fill: fillPrice
          ? {
              symbol: String(input.symbol).toUpperCase(),
              side: side.toUpperCase(),
              qty,
              price: fillPrice,
              currency: "INR",
              orderId,
              brokerOrderId,
            }
          : null,
        portfolio: null,
        note: "Order sent to Shoonya. Positions sync from your brokerage account.",
      };
    },

    async getPositions(userSub) {
      return withSession(userSub, async (tokens) => {
        const data = await shoonyaPost(
          "PositionBook",
          { uid: tokens.uid, actid: tokens.actid || tokens.uid },
          tokens.susertoken,
          { allowEmpty: true }
        );
        const rows = Array.isArray(data) ? data : [];
        return rows
          .filter((p) => Number(p.netqty || 0) !== 0)
          .map((p) => ({
            symbol: `${String(p.tsym || "").replace(/-EQ$/i, "")}.${p.exch === "BSE" ? "BO" : "NS"}`,
            qty: Math.abs(Number(p.netqty) || 0),
            avgCost: Number(p.netavgprc || p.upldprc || 0),
            currency: "INR",
            name: p.tsym,
            venue: VENUES.SHOONYA,
            side: Number(p.netqty) >= 0 ? "long" : "short",
            raw: { exch: p.exch, tsym: p.tsym, urmtom: p.urmtom, rpnl: p.rpnl },
          }));
      });
    },

    async getOrders(userSub) {
      return withSession(userSub, async (tokens) => {
        const data = await shoonyaPost(
          "OrderBook",
          { uid: tokens.uid },
          tokens.susertoken,
          { allowEmpty: true }
        );
        if (!Array.isArray(data)) return [];
        return data.map((o) => ({
          brokerOrderId: o.norenordno,
          symbol: o.tsym,
          side: o.trantype === "B" ? "buy" : "sell",
          qty: Number(o.qty || 0),
          status: o.status,
          fillPrice: Number(o.avgprc || 0) || null,
          venue: VENUES.SHOONYA,
          exchange: o.exch,
          raw: o,
        }));
      });
    },

    async cancelOrder(userSub, brokerOrderId) {
      return withSession(userSub, async (tokens) => {
        return shoonyaPost(
          "CancelOrder",
          { uid: tokens.uid, norenordno: String(brokerOrderId) },
          tokens.susertoken
        );
      });
    },
  };
}
