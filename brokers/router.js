/**
 * Execution router — paper now; live venues rejected until an adapter is linked.
 */
import { VENUES, SUPPORTED_LIVE_VENUES } from "./types.js";
import { createPaperBroker } from "./paper.js";
import { ensureBrokerConnectionStub, listBrokerConnections } from "../lib/store.js";

const EXECUTION_MODE = String(process.env.EXECUTION_MODE || "paper").toLowerCase();

export function createExecutionRouter({ resolvePrice }) {
  const paper = createPaperBroker({ resolvePrice });

  return {
    mode: EXECUTION_MODE === "live" ? "live" : "paper",

    async placeOrder(input, preferredVenue) {
      const venue = (preferredVenue || VENUES.PAPER).toLowerCase();

      if (venue === VENUES.PAPER || this.mode === "paper") {
        await ensureBrokerConnectionStub(input.userSub, VENUES.PAPER);
        return paper.placeOrder(input);
      }

      if (SUPPORTED_LIVE_VENUES.includes(venue)) {
        const err = new Error(
          `Live broker "${venue}" is not connected yet. Pulse stays paper-only until you link a broker adapter.`
        );
        err.status = 501;
        throw err;
      }

      const err = new Error(`Unknown venue: ${venue}`);
      err.status = 400;
      throw err;
    },

    getPositions(userSub) {
      return paper.getPositions(userSub);
    },

    getOrders(userSub) {
      return paper.getOrders(userSub);
    },

    listConnections(userSub) {
      return listBrokerConnections(userSub);
    },
  };
}

export { EXECUTION_MODE, VENUES };
