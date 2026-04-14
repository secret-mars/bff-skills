---
name: stacks-market-trader-agent
skill: stacks-market-trader
description: "Read-only prediction market monitor — list, get, quote, and position on stacksmarket.app without signing any transactions."
---

# Agent Behavior — Stacks Market Trader

## Decision order

1. Run `doctor` first. If the Stacks Market API, Hiro API, or factory contract check fails, stop and surface the blocker.
2. Use `list-markets` (or `search`) to pick candidate markets. Prefer `--status open` for trading decisions.
3. Use `get-market` to pull full metadata (resolution rules, end date, options, volume) before quoting.
4. Use `quote` to price an intended trade before committing capital in any v2 execution skill.
5. Use `position` to check share balances for an address before redeeming or exiting.

## Guardrails

- This skill is strictly read-only. It never signs, broadcasts, or moves funds. Do not pretend otherwise.
- Never infer fill price from `impliedProbability` alone. Always call `quote` for trade sizing.
- Never skip `doctor` at the start of a run — if the upstream API or Hiro is degraded, every subsequent call will be unreliable.
- Treat `endDate` as hard-authoritative. Do not quote or advise trades on markets whose `endDate` is in the past.
- Never expose secrets or private keys in args or logs (this skill does not accept any).
- Default to safe/read-only behavior when intent is ambiguous.

## Output routing

All commands return `{ status, action, data, error }`. Branch on `status`:

- `success` → read `data` and continue.
- `error` → surface `error` to the caller; do not retry silently.

## Command-specific contracts

**doctor `data`:**
```json
{ "checks": [{ "name": "string", "status": "pass|fail", "detail": "string" }] }
```

**list-markets `data`:**
```json
{
  "network": "mainnet",
  "filters": { "status": "open", "category": "Sports|null", "featured": true, "limit": 20 },
  "count": 5,
  "totalAvailable": 93,
  "markets": [
    {
      "marketId": "1776084784236",
      "id": "69dce731d6163b057e847ad5",
      "title": "string",
      "category": "string",
      "endDate": "ISO 8601",
      "isActive": true,
      "isResolved": false,
      "totalVolume": 199680000,
      "totalTrades": 2,
      "options": [{ "text": "Yes|No", "impliedProbability": 24, "totalVolume": 0 }]
    }
  ]
}
```

**get-market `data`:** full poll object plus derived `isOpen` boolean.

**quote `data`:**
```json
{
  "marketId": "1776084784236",
  "option": "yes|no",
  "action": "buy|sell",
  "amount": 1000000,
  "contract": "SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA.market-factory-v20-bias",
  "function": "quote-buy-yes",
  "result": "(ok u...)",
  "costOrProceedsMicroStx": 12345
}
```

**position `data`:**
```json
{
  "marketId": "1776084784236",
  "address": "SP...",
  "yesShares": 0,
  "noShares": 0,
  "spentMicroStx": 0,
  "claim": {
    "canRedeem": false,
    "claimableMicroStx": 0,
    "status": "open",
    "outcome": "",
    "winningShares": 0
  }
}
```

**search `data`:** same shape as `list-markets`.

## On error

- Surface `error` string unchanged to the caller.
- Common errors: "Stacks Market API error", "Hiro API error", "Contract call failed", "market not found".
- Do not retry — the upstream may be rate-limiting or genuinely down.

## On success

- Emit the full JSON payload.
- For `quote`, include the explicit disclaimer that this is a price projection, not a reservation — actual fill price at execution time may drift.
- Always include the `timestamp` when rendering to humans for staleness assessment.
