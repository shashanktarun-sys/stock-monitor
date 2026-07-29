/**
 * Broker adapter contract (paper now; live venues later).
 *
 * Every broker implements:
 *   placeOrder(ctx) -> OrderResult
 *   getPositions(userSub) -> Position[]
 *   getOrders(userSub) -> Order[]
 *   cancelOrder?(userSub, orderId) -> void
 *
 * Live adapters must NOT reuse paper fill logic. They place at the venue,
 * then sync status / positions from the broker.
 *
 * @typedef {object} PlaceOrderInput
 * @property {string} userSub
 * @property {string} symbol
 * @property {"buy"|"sell"|"BUY"|"SELL"} side
 * @property {number} qty
 * @property {"market"|"limit"} [orderType]
 * @property {number} [limitPrice]
 * @property {number} [clientPrice]  // paper fallback when quote fetch fails
 * @property {string} [currency]
 * @property {string} [name]
 * @property {{ recommendation?: string, score?: number }} [signal]
 * @property {{ industry?: string, sector?: string, capLabel?: string }} [industryInfo]
 * @property {{ source?: string, basketId?: string }} [opts]
 *
 * @typedef {object} OrderResult
 * @property {string} orderId
 * @property {string} venue
 * @property {string} status  // filled | rejected | submitted | ...
 * @property {object} [fill]
 * @property {object} [portfolio]
 * @property {string} [error]
 */

export const VENUES = Object.freeze({
  PAPER: "paper",
  ALPACA: "alpaca",
  ZERODHA: "zerodha",
});

/** @type {ReadonlyArray<string>} */
export const SUPPORTED_LIVE_VENUES = Object.freeze([VENUES.ALPACA, VENUES.ZERODHA]);
