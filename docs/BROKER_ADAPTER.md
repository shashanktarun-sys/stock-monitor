# Broker adapter contract

Pulse keeps **paper trading** as the default execution path.
Live brokerage firms plug in by implementing the same adapter surface used by
[`brokers/paper.js`](../brokers/paper.js) and routing through [`brokers/router.js`](../brokers/router.js).

## Live: Shoonya (Finvasia) — enabled (OAuth)

India equity live orders use [`brokers/shoonya.js`](../brokers/shoonya.js).

**Important (Apr 2026+):** Shoonya retired retail **QuickAuth** (password + vendor + IMEI).
Retail accounts must use **OAuth → GenAcsTok**.

### User flow

1. Sign in to Pulse.
2. On [trade.shoonya.com](https://trade.shoonya.com) → profile → **API Key**:
   - Copy the **secret code**
   - **Whitelist** the public IP of the machine that runs Pulse (local PC or Render outbound IP)
3. Pulse Profile → **Broker — Shoonya**:
   - Enter **User ID** (`FA…`) and **API secret**
   - Click **Get auth code** → log in on Shoonya’s page
   - Paste `code=…` (or the full redirect URL) → **Connect Shoonya**
4. On an India stock detail card, choose **Live · Shoonya**, then Buy/Sell.

Agents stay **paper-only**.

### Server endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/broker/shoonya/authorize-url?userid=` | OAuth authorize URL |
| POST | `/api/broker/shoonya/connect` | `{ userid, apiSecret, authCode }` → GenAcsTok |
| POST | `/api/broker/shoonya/disconnect` | Clear tokens |
| GET | `/api/broker/shoonya/status` | Connected? |
| POST | `/api/orders` with `venue: "shoonya"` | Live place order |

Checksum: `SHA256(clientId + secret + code)` where `clientId` is usually `UserID_U`.
Token exchange must originate from a **whitelisted IP**.

Set `BROKER_TOKEN_SECRET` so session tokens encrypt at rest.

### Symbol map

`RELIANCE.NS` → NSE `RELIANCE-EQ` · `SBIN.BO` → BSE `SBIN-EQ`. Product defaults to CNC (`C`).

## Interface

```js
placeOrder({ userSub, symbol, side, qty, ... }) -> { orderId, venue, status, fill?, ... }
getPositions(userSub) -> Position[]
getOrders(userSub) -> Order[]
```

## Rules for live adapters

1. Do not call paper fill logic for real money.
2. Store `broker_order_id` on `orders`.
3. Broker is source of truth for live positions.
4. Encrypt tokens in `broker_connections.encrypted_tokens`.

Pulse remains a client/router — KYC and custody stay with the brokerage.
