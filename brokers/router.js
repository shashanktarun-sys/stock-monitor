/**
 * Execution router — paper by default; Shoonya when connected + venue requested.
 */
import { VENUES, LIVE_VENUES_ENABLED } from "./types.js";
import { createPaperBroker } from "./paper.js";
import { createShoonyaBroker } from "./shoonya.js";
import {
  ensureBrokerConnectionStub,
  listBrokerConnections,
  getBrokerConnection,
} from "../lib/store.js";

const EXECUTION_MODE = String(process.env.EXECUTION_MODE || "paper").toLowerCase();

export function createExecutionRouter({ resolvePrice }) {
  const paper = createPaperBroker({ resolvePrice });
  const shoonya = createShoonyaBroker();

  return {
    mode: EXECUTION_MODE === "live" ? "live" : "paper",

    async placeOrder(input, preferredVenue) {
      const venue = String(preferredVenue || VENUES.PAPER).toLowerCase();

      // Explicit paper always allowed
      if (venue === VENUES.PAPER) {
        await ensureBrokerConnectionStub(input.userSub, VENUES.PAPER);
        return paper.placeOrder(input);
      }

      if (venue === VENUES.SHOONYA) {
        const conn = await getBrokerConnection(input.userSub, VENUES.SHOONYA);
        if (!conn || conn.status !== "connected") {
          const err = new Error(
            "Shoonya is not connected. Open Profile → Connect Shoonya, then retry."
          );
          err.status = 401;
          throw err;
        }
        return shoonya.placeOrder(input);
      }

      if (LIVE_VENUES_ENABLED.includes(venue)) {
        const err = new Error(`Live broker "${venue}" adapter is not ready yet.`);
        err.status = 501;
        throw err;
      }

      const err = new Error(`Unknown venue: ${venue}`);
      err.status = 400;
      throw err;
    },

    async getPositions(userSub, venue = VENUES.PAPER) {
      if (venue === VENUES.SHOONYA) return shoonya.getPositions(userSub);
      return paper.getPositions(userSub);
    },

    async getOrders(userSub, venue = VENUES.PAPER) {
      if (venue === VENUES.SHOONYA) return shoonya.getOrders(userSub);
      return paper.getOrders(userSub);
    },

    listConnections(userSub) {
      return listBrokerConnections(userSub);
    },

    shoonya,
    paper,
  };
}

export { EXECUTION_MODE, VENUES };
