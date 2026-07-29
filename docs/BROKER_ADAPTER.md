# Broker adapter contract

Pulse keeps **paper trading** as the default execution path.
Live brokerage firms plug in by implementing the same adapter surface used by
[`brokers/paper.js`](../brokers/paper.js) and routing through [`brokers/router.js`](../brokers/router.js).

## Live: Shoonya (Finvasia) — enabled

India equity live orders are supported via [`brokers/shoonya.js`](../brokers/shoonya.js).

### User flow

1. Sign in to Pulse.
2. Open **Profile → Broker — Shoonya**.
3. Enter Shoonya **User ID**, **password**, **2FA/TOTP**, and **API secret**
   (generate the secret in Shoonya API / Prism settings; enable API on the account).
4. Vendor code defaults to `UserID_U` if left blank.
5. On a stock detail card, choose **Live · Shoonya** (India symbols only), then Buy/Sell.
6. Confirm the live-order dialog — the order is sent to your Shoonya account.

Agents stay **paper-only**. Pilot can choose paper or Shoonya per trade.

### Server endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/broker/shoonya/connect` | QuickAuth login; store encrypted session |
| POST | `/api/broker/shoonya/disconnect` | Logout + clear tokens |
| GET | `/api/broker/shoonya/status` | Connected? |
| GET | `/api/broker/connections` | List venues |
| POST | `/api/orders` with `venue: "shoonya"` | Live place order |

Set `BROKER_TOKEN_SECRET` (or `SESSION_SECRET`) so session tokens encrypt at rest.

### Symbol map

`RELIANCE.NS` → NSE `RELIANCE-EQ` · `SBIN.BO` → BSE `SBIN-EQ`. Product defaults to CNC (`C`).

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

- `orders` — venue `paper|shoonya|alpaca|zerodha`, status, fill fields
- `broker_connections` — per-user provider link (status `paper_only` | `connected` | `disconnected`)

## Adding another broker later

1. Implement `brokers/<name>.js`.
2. Register it in `createExecutionRouter`.
3. Add connect UI that writes `broker_connections`.
4. Keep paper as fallback; require explicit venue on live orders.

Pulse remains a client/router — KYC and custody stay with the brokerage.
