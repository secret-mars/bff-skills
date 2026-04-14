---
name: stacks-market-trader
description: "Read-only monitoring and analysis layer for stacksmarket.app prediction markets — browse markets, fetch quotes from the LMSR AMM, and inspect on-chain YES/NO positions without signing any transactions."
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "false"
  arguments: "doctor | list-markets | get-market | quote | position | search"
  entry: "stacks-market-trader/stacks-market-trader.ts"
  requires: ""
  tags: "defi, read-only, mainnet-only, l2"
---

# Stacks Market Trader

## What it does

Gives agents a structured, JSON-only view of [Stacks Market](https://stacksmarket.app) — a live mainnet prediction market platform backed by the `SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA.market-factory-v20-bias` LMSR contract. Combines the public REST API at `https://api.stacksmarket.app/api/polls` (listings, search, market metadata) with on-chain Hiro reads (`quote-buy-yes`, `quote-buy-no`, `quote-sell-yes`, `quote-sell-no`, `get-yes-balance`, `get-no-balance`) so agents can price trades and inspect positions without a wallet.

## Why agents need it

Agents trading prediction markets need the same three things as humans — a list of what's open, a live price quote, and their current position — except structured for machine routing. Until this skill, every agent had to invent its own endpoint probing. This is the shared monitoring layer: call `list-markets` to pick targets, `quote` to size trades, `position` to reconcile holdings.

## Safety notes

- Read-only. No transactions are signed or broadcast. Writes (buy/sell/redeem) are intentionally deferred to a v2 skill once this read path is validated in production.
- Mainnet only. The `market-factory-v20-bias` contract is deployed on Stacks mainnet.
- No wallet, no password, no secrets. All inputs are public addresses and market IDs.
- Hits two public endpoints: `https://api.stacksmarket.app/api/polls*` and `https://api.hiro.so/v2/contracts/call-read/*`. No API keys required.

## Commands

All commands print a single JSON object to stdout with shape:

```json
{ "status": "success" | "error", "action": "<cmd>", "data": { ... }, "error": null | "<msg>" }
```

### doctor

Checks Stacks Market API reachability and Hiro read access against the factory contract. Safe to run anytime.

```bash
bun run stacks-market-trader/stacks-market-trader.ts doctor
```

Output:
```json
{
  "status": "success",
  "action": "doctor",
  "data": {
    "checks": [
      { "name": "stacks_market_api", "status": "pass", "detail": "200 OK, 93 markets total" },
      { "name": "hiro_api", "status": "pass", "detail": "200 OK" },
      { "name": "factory_contract", "status": "pass", "detail": "get-admin readable" }
    ]
  },
  "error": null
}
```

### list-markets

List prediction markets. Filters are applied client-side where the API does not expose them (status filter).

```bash
bun run stacks-market-trader/stacks-market-trader.ts list-markets \
  --status open \
  --category Sports \
  --featured \
  --limit 5
```

Options:
- `--status <open|closed|resolved|all>` (default: `open`) — `open` = `isActive && !isResolved && endDate > now`; `closed` = `!isActive || endDate <= now`; `resolved` = `isResolved`; `all` = no filter.
- `--category <Sports|Crypto|Politics|...>` — case-insensitive category match (sent to API).
- `--featured` — return only featured markets (sent to API).
- `--limit <N>` (default: 20) — max markets to return after filtering.

### get-market

Full details for one market.

```bash
bun run stacks-market-trader/stacks-market-trader.ts get-market --market-id 1776084784236
```

Options:
- `--market-id <id>` (required) — numeric epoch-ms market ID (visible in market URL and returned by `list-markets`).

### quote

Get a buy or sell quote without executing. Calls the factory's LMSR pricing function on-chain via Hiro.

```bash
bun run stacks-market-trader/stacks-market-trader.ts quote \
  --market-id 1776084784236 \
  --option yes \
  --action buy \
  --amount 1000000
```

Options:
- `--market-id <id>` (required) — numeric market ID.
- `--option <yes|no>` (required) — which side to trade.
- `--action <buy|sell>` (required) — quote direction.
- `--amount <units>` (required) — integer share amount (smallest unit).

Output includes the factory function called (`quote-buy-yes` / `quote-buy-no` / `quote-sell-yes` / `quote-sell-no`), the raw Clarity response, and the decoded cost/proceeds.

### position

Check a Stacks address's YES and NO share balances on a market.

```bash
bun run stacks-market-trader/stacks-market-trader.ts position \
  --market-id 1776084784236 \
  --address SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE
```

Options:
- `--market-id <id>` (required).
- `--address <stx>` (required) — Stacks mainnet address (SP...).

### search

Search markets by keyword across title and description.

```bash
bun run stacks-market-trader/stacks-market-trader.ts search --query bitcoin --limit 10
```

Options:
- `--query <string>` (required).
- `--limit <N>` (default: 20).

## Output contract

All commands emit a single JSON object. On any failure the skill exits with code 1 and `{ "status": "error", "action": "<cmd>", "data": null, "error": "<message>" }`.

## Known constraints

- **Read-only v1.** Buy, sell, and redeem are intentionally not implemented. They will ship in a v2 skill (`stacks-market-execute`) once the read path is validated.
- **Mainnet only.** Contract is `SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA.market-factory-v20-bias`.
- **`--status` filter is client-side.** The upstream API currently does not honor the `status` query parameter — this skill filters the returned list by `isActive`, `isResolved`, and `endDate` to produce the requested view.
- **Market IDs are numeric epoch-ms.** They are returned as the `marketId` string field by the API and are used as `uint` arguments to all on-chain functions.
- **No price inference for unresolved markets.** `get-market` returns `impliedProbability` from the REST API (computed by the backend from on-chain state). For trade pricing, always use `quote`.
- **API endpoints:** `https://api.stacksmarket.app/api/polls` (list, filter, search), `https://api.stacksmarket.app/api/polls/{_id}` (by Mongo `_id`, used internally when only `_id` is known). Hiro: `https://api.hiro.so/v2/contracts/call-read/SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA/market-factory-v20-bias/{fn}`.
