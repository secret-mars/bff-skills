---
name: whale-tracker
description: "Monitor whale trades and top movers on Stacks DEXes via Tenero — surfaces large trades, gainers, and market momentum for DeFi agents."
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "true"
  arguments: "doctor | scan [--limit N] | gainers [--limit N]"
  entry: "whale-tracker/whale-tracker.ts"
  requires: "none"
  tags: "l2, read-only, data, defi"
---

# whale-tracker

Read-only Tenero-powered skill that monitors whale trades and top movers on Stacks DEXes. No wallet needed — pure market intelligence from live on-chain data.

## What it does

`whale-tracker` queries the Tenero API to surface large DEX trades and top-gaining tokens on Stacks L2. It gives DeFi agents actionable market intelligence: who is moving big size, in which direction, and which tokens are gaining momentum.

| Command | What it returns |
|---|---|
| `doctor` | API connectivity check — verifies Tenero is reachable |
| `scan` | Recent whale trades with USD amount, direction, token pair, maker, time |
| `gainers` | Top tokens by 24h price change with volume and liquidity data |

## Why agents need it

Autonomous agents making DeFi decisions benefit from knowing where large capital is flowing before committing to a position. Without this skill, an agent would need to raw-query the Tenero API, handle pagination, normalize response schemas, and compute time-ago strings. This skill does all of that and returns a clean, typed JSON contract.

Common agent workflows:
- **Pre-trade signal**: Detect buy-side whale accumulation before entering a long position.
- **Momentum filter**: Use `gainers` to identify tokens with genuine volume backing price moves.
- **Risk awareness**: Detect large sells in a token you hold — early warning for exit.
- **Market pulse**: Combine `scan` + `gainers` for a quick market-wide health check.

## Commands

### `doctor`

Verifies Tenero API connectivity. Fetches a single whale trade as a ping.

```bash
bun run whale-tracker.ts doctor
```

**Output**: `{status: "ok"|"error", action: "doctor", data: {endpoint, latencyMs}, error?}`

### `scan [--limit N]`

Fetches recent whale trades from Stacks DEXes. Default limit: 10. Max: 25.

```bash
bun run whale-tracker.ts scan
bun run whale-tracker.ts scan --limit 5
```

**Output**: JSON with `trades` array. Each trade includes:
- `txId` — transaction ID (truncated for readability)
- `platform` — DEX platform name
- `direction` — `"buy"` or `"sell"`
- `pair` — e.g., `"STX/USDA"`
- `makerShort` — maker address (first 8 + last 4 chars)
- `amountUsd` — USD value of the trade
- `priceUsd` — execution price
- `timeAgo` — human-readable age (e.g., `"3m ago"`, `"2h ago"`)
- `blockHeight` — Stacks block number

### `gainers [--limit N]`

Fetches top-gaining tokens by 24h price change. Default limit: 10. Max: 25.

```bash
bun run whale-tracker.ts gainers
bun run whale-tracker.ts gainers --limit 5
```

**Output**: JSON with `gainers` array. Each entry includes:
- `symbol` — token symbol
- `name` — full token name
- `priceUsd` — current price
- `change24hPct` — 24h price change percentage
- `change7dPct` — 7-day price change percentage
- `volume24hUsd` — 24h trading volume in USD
- `swaps24h` — number of swaps in 24h
- `buys24h` / `sells24h` — buy/sell breakdown
- `liquidityUsd` — total pool liquidity in USD
- `holders` — holder count

## Safety

- **Read-only** — No transactions, no wallet interaction, no keys required.
- **No authentication** — Tenero public API requires no API key.
- **No private data** — Maker addresses are truncated in output. Full `tx_id` is available in raw data.
- **Graceful errors** — All errors are caught and returned as structured JSON, never thrown to stderr.
- **Timeout protection** — All fetch calls have a 10-second timeout.
