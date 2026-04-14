---
name: whale-tracker
description: "Monitor whale trades and top movers on Stacks DEXes via Tenero — surfaces large trades, gainers, and market momentum for DeFi agents."
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "true"
  arguments: "doctor | scan [--limit N] | gainers [--limit N] | losers [--limit N]"
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
| `losers` | Top declining tokens by 24h price change |

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

**Output**: JSON with `gainers` array (shape documented in Output contract below).

### `losers [--limit N]`

Fetches top-declining tokens by 24h price change. Same output shape as `gainers`.

```bash
bun run whale-tracker.ts losers
bun run whale-tracker.ts losers --limit 5
```

**Output**: JSON with `losers` array (same shape as `gainers`).

## Output contract

Every command returns a single JSON object written to stdout, never partial or streamed:

```json
{
  "status": "ok" | "error",
  "action": "doctor" | "scan" | "gainers" | "losers",
  "data": { ... },
  "error": "<message, only present when status='error'>"
}
```

Per-command `data` shape:

- **`doctor`**: `{ endpoint: string, latencyMs: number, tradesSampled?: number, message?: string }`
- **`scan`**: `{ trades: FormattedTrade[], count: number, fetchedAt: string }` where `FormattedTrade = { txId, platform, direction: "buy"|"sell", pair, makerShort, amountUsd, priceUsd, timeAgo, blockHeight }`
- **`gainers` / `losers`**: `{ gainers|losers: FormattedMover[], count: number, fetchedAt: string }` where `FormattedMover = { symbol, name, priceUsd, change24hPct, change7dPct, volume24hUsd, swaps24h, buys24h, sells24h, liquidityUsd, holders }`

USD values are formatted strings (`"$17.2K"`, `"$70.4K"`). Percentages are strings with sign (`"+12.34%"`, `"-5.67%"`, `"n/a"`). `timeAgo` is a human string (`"3m ago"`, `"2d ago"`, `"just now"`).

On error the `data` field is preserved (may be empty `{}`) and `error` is set. Exit code is `1` for unknown commands or fatal uncaught errors, otherwise `0` even on handled errors (the error is in the JSON).

## Safety notes

- **Read-only** — No transactions, no wallet interaction, no keys required.
- **No authentication** — Tenero public API requires no API key.
- **No private data** — Maker addresses are truncated in output. Full `tx_id` is available in raw data.
- **Graceful errors** — All errors are caught and returned as structured JSON, never thrown to stderr.
- **Timeout protection** — All fetch calls have a 10-second timeout.
- **Mainnet only** — Tenero indexes Stacks mainnet; testnet addresses return empty results without error.
- **Rate limit aware** — Clamps `--limit` to 1-25 per request to stay well under API limits.
