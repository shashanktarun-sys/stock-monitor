# Broker adapter contract

Pulse keeps **paper trading** as the default execution path (`EXECUTION_MODE=paper`).
Live brokerage firms plug in later by implementing the same adapter surface used by
[`brokers/paper.js`](../brokers/paper.js) and routing through [`brokers/router.js`](../brokers/router.js).

## Interface

```js
placeOrder({
  userSub, symbol, side, qty,
  orderType?, limitPrice?, clientPrice?, currency?, name?,
  signal?, industryInfo?, opts?
}) -> { orderId, venue, status, fill?, portfolio?, error? }

getPositions(userSub) -> Position[]
getOrders(userSub) -> Order[]
cancelOrder?(userSub, orderId)
```

## Rules for live adapters

1. **Do not** call paper fill logic for real money.
2. Place the order at the broker → store `broker_order_id` on `orders`.
3. Poll or webhook until `filled` / `rejected` / `cancelled`.
4. Treat the **broker** as source of truth for live positions; sync into Pulse for display.
5. Map Pulse symbols (e.g. `RELIANCE.NS`) to broker symbols inside the adapter.
6. Store OAuth/API tokens only in `broker_connections.encrypted_tokens` (encrypt at rest).

## Schema

- `orders` — venue `paper|alpaca|zerodha`, status, fill fields
- `broker_connections` — per-user provider link (status `paper_only` | `connected` | `disconnected`)

## Enabling live later

1. Implement `brokers/alpaca.js` or `brokers/zerodha.js`.
2. Register it in `createExecutionRouter`.
3. Add OAuth connect UI that writes `broker_connections`.
4. Set `EXECUTION_MODE=live` only for users with a connected venue (keep paper as fallback).

Pulse remains a client/router — KYC and custody stay with the brokerage.
