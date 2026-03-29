---
name: portfolio-rebalancer
description: "Multi-position DeFi portfolio manager — reads Zest, v0-4-market, and liquid sBTC positions, computes allocation drift against targets, and suggests rebalance moves with safety caps."
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "false"
  arguments: "doctor | run status | run rebalance | install-packs"
  entry: "portfolio-rebalancer/portfolio-rebalancer.ts"
  requires: ""
  tags: "defi, read-only, infrastructure, l2, mainnet-only"
---

# Portfolio Rebalancer

## What it does

Reads an agent's DeFi positions across three buckets — liquid sBTC, Zest Protocol lending (zsbtc LP), and v0-4-market collateral — computes current allocation percentages against configurable targets, measures drift, and suggests rebalance moves when any bucket exceeds a threshold. The rebalance command maps bucket transitions to specific contract calls and caps single moves for safety.

## Why agents need it

Agents holding sBTC across multiple DeFi protocols need to maintain target allocations. Without active rebalancing, yield-generating positions can become overweight (missing liquidity for operations) or underweight (leaving yield on the table). This skill automates the "check positions, compute drift, decide what to move" workflow that agents otherwise do manually every cycle.

## Safety notes

- **Read-only by design.** Status reads positions, rebalance computes the move but defers execution to MCP tools. This skill never broadcasts transactions.
- **No wallet required** for status checks. Only the Stacks address is needed.
- **Safety cap:** Single rebalance moves are capped at 100,000 sats by default.
- **Minimum liquid floor:** The liquid bucket is never drained below 50,000 sats, preserving operational funds.
- **Drift threshold:** Rebalances are only suggested when drift exceeds 5% — no churn on small fluctuations.
- **Mainnet only.** Reads mainnet contract state via stxer and Hiro APIs.

## Commands

### doctor

Check API connectivity (stxer + Hiro), display target allocations and safety parameters.

```bash
bun run portfolio-rebalancer/portfolio-rebalancer.ts doctor
```

Output:
```json
{
  "status": "success",
  "action": "doctor",
  "data": {
    "apis": { "stxer": "healthy", "hiro": "healthy" },
    "targets": { "liquid": 35, "zest": 45, "v0_market": 20 },
    "safety": { "min_liquid_sats": 50000, "max_single_move_sats": 100000, "drift_threshold_pct": 5 }
  },
  "error": null
}
```

### run status

Read current portfolio positions and compute allocation drift against targets.

```bash
bun run portfolio-rebalancer/portfolio-rebalancer.ts run status \
  --address SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE \
  --v0-override 102976
```

Options:
- `--address` (required) — Stacks address to read positions for
- `--v0-override <sats>` — Override v0-4-market balance (useful when on-chain read is complex)
- `--target-liquid <pct>` — Target liquid allocation (default: 35%)
- `--target-zest <pct>` — Target Zest allocation (default: 45%)
- `--target-v0 <pct>` — Target v0-market allocation (default: 20%)

Output:
```json
{
  "status": "success",
  "action": "status",
  "data": {
    "total_sats": 549388,
    "positions": [
      { "bucket": "liquid", "balance_sats": 201410, "pct": 36.66, "target_pct": 35, "drift_pct": 1.66, "action": "hold" },
      { "bucket": "zest", "balance_sats": 245002, "pct": 44.60, "target_pct": 45, "drift_pct": -0.40, "action": "hold" },
      { "bucket": "v0_market", "balance_sats": 102976, "pct": 18.74, "target_pct": 20, "drift_pct": -1.26, "action": "hold" }
    ],
    "needs_rebalance": false,
    "suggested_moves": []
  }
}
```

### run rebalance

Compute a specific rebalance move between buckets.

```bash
bun run portfolio-rebalancer/portfolio-rebalancer.ts run rebalance \
  --from liquid --to zest --amount 50000 --dry-run
```

Options:
- `--from` (required) — Source bucket: `liquid`, `zest`, `v0_market`
- `--to` (required) — Destination bucket
- `--amount <sats>` (required) — Amount to move
- `--dry-run` — Simulate only, show what would happen

### install-packs

Install the commander dependency.

```bash
bun run portfolio-rebalancer/portfolio-rebalancer.ts install-packs
```

## On-chain proof

Live output against Secret Mars's real portfolio (2026-03-29):

```
$ npx tsx portfolio-rebalancer.ts run status \
  --address SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE --v0-override 102976

→ total_sats: 549,388
→ liquid: 201,410 sats (36.7%, target 35%, drift +1.7%) → hold
→ zest: 245,002 sats (44.6%, target 45%, drift -0.4%) → hold
→ v0_market: 102,976 sats (18.7%, target 20%, drift -1.3%) → hold
→ needs_rebalance: false (all within 5% threshold)
→ stx_balance: ~29.6 STX
```

Safety cap test:
```
$ npx tsx portfolio-rebalancer.ts run rebalance --from liquid --to zest --amount 200000
→ error: Amount 200000 exceeds safety cap 100000
```

## Output contract

All commands output JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "doctor | status | rebalance | rebalance-dry-run | install-packs",
  "data": {},
  "error": null | { "code": "...", "message": "...", "next": "..." }
}
```

## Known constraints

- **Mainnet only.** All contract reads use mainnet APIs.
- **v0-4-market read is simplified.** The get-position return tuple is complex — use `--v0-override` for known positions until full Clarity tuple parsing is implemented.
- **Read-only by design.** Rebalance computes the move but outputs an instruction for MCP tools to execute. This is intentional — the skill is a decision layer, not an execution layer.
- **Target allocations must sum to 100%.** The skill validates this and rejects misconfigured targets.
- **zsbtc LP tokens are treated as 1:1 with sBTC sats.** In practice, the exchange rate drifts with accrued yield — actual sBTC value is slightly higher than the LP token count.
- **Two-step moves (zest↔v0_market) require two separate transactions.** The skill identifies these but the agent must execute them sequentially.
