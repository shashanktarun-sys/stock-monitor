/**
 * PaperBroker — educational fills against Pulse portfolio tables.
 * Does not send orders to any real brokerage.
 */
import crypto from "node:crypto";
import { VENUES } from "./types.js";
import {
  applyPaperFill,
  insertOrder,
  loadUserData,
  listOrders,
} from "../lib/store.js";

export function createPaperBroker({ resolvePrice }) {
  return {
    venue: VENUES.PAPER,

    async placeOrder(input) {
      const qty = Math.floor(Number(input.qty) || 0);
      if (!(qty > 0)) {
        const err = new Error("Quantity must be a positive integer");
        err.status = 400;
        throw err;
      }
      const symbol = String(input.symbol || "").toUpperCase().trim();
      if (!symbol) {
        const err = new Error("Symbol is required");
        err.status = 400;
        throw err;
      }
      const side = String(input.side || "").toLowerCase();
      if (side !== "buy" && side !== "sell") {
        const err = new Error('Side must be "buy" or "sell"');
        err.status = 400;
        throw err;
      }

      let price = Number(input.clientPrice);
      let currency = input.currency || (symbol.endsWith(".NS") || symbol.endsWith(".BO") ? "INR" : "USD");
      let name = input.name || symbol;

      if (typeof resolvePrice === "function") {
        try {
          const q = await resolvePrice(symbol);
          if (q?.price > 0) price = q.price;
          if (q?.currency) currency = q.currency;
          if (q?.name) name = q.name;
        } catch {
          /* keep client price */
        }
      }
      if (!(price > 0)) {
        const err = new Error("Could not resolve a fill price");
        err.status = 400;
        throw err;
      }

      const orderId = crypto.randomUUID();
      const now = Date.now();
      await insertOrder({
        id: orderId,
        userSub: input.userSub,
        venue: VENUES.PAPER,
        symbol,
        side,
        qty,
        orderType: input.orderType || "market",
        limitPrice: input.limitPrice ?? null,
        status: "accepted",
        fillPrice: null,
        createdAt: now,
        updatedAt: now,
        meta: { source: input.opts?.source || null },
      });

      const result = await applyPaperFill(input.userSub, {
        symbol,
        side,
        qty,
        price,
        currency,
        name,
        signal: input.signal,
        industryInfo: input.industryInfo,
        opts: input.opts,
        orderId,
      });

      return {
        orderId,
        venue: VENUES.PAPER,
        status: "filled",
        fill: result.fill,
        portfolio: result.portfolio,
      };
    },

    async getPositions(userSub) {
      const data = await loadUserData(userSub);
      return Object.entries(data.portfolio.positions || {}).map(([symbol, pos]) => ({
        symbol,
        ...pos,
        venue: VENUES.PAPER,
      }));
    },

    async getOrders(userSub) {
      return listOrders(userSub, 100);
    },

    async cancelOrder() {
      const err = new Error("Paper market orders fill immediately and cannot be cancelled");
      err.status = 400;
      throw err;
    },
  };
}
