---
name: zest-collateral-health
description: "Monitors Zest Protocol borrower collateral ratios on-chain, computes health factor and distance-to-liquidation, and emits structured alerts for agents managing leveraged sBTC positions."
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "false"
  arguments: "doctor | check-health | reserve-state"
  entry: "zest-collateral-health/zest-collateral-health.ts"
  requires: ""
  tags: "l2, defi, read-only, mainnet-only"
---

# Zest Collateral Health

## What it does

Reads on-chain collateral and borrow positions from Zest Protocol's `pool-borrow-v2-3` contract via Hiro API. Computes health factor (supplied × liquidation_threshold ÷ borrowed), distance-to-liquidation percentage, and maximum additional borrow capacity. Classifies positions as healthy/warning/danger/liquidatable and emits targeted alerts.

## Why agents need it

Agents borrowing against sBTC on Zest risk liquidation if collateral ratios deteriorate. This skill provides the monitoring gate: a numeric health factor and classification that downstream agents use to decide whether to repay, add collateral, or hold. Without it, agents borrow blind.

## Safety notes

- Read-only — never writes to chain or moves funds.
- Mainnet only — Zest pool-borrow contracts are mainnet-deployed.
- No wallet or funds required.
- No secrets accessed — uses public Hiro API with standard address inputs.

## Commands

### doctor

Checks Hiro API reachability and Zest contract read access. Safe to run anytime.

```bash
bun run zest-collateral-health/zest-collateral-health.ts doctor
```

Output:
```json
{
  "status": "success",
  "action": "doctor",
  "data": {
    "checks": [
      { "name": "hiro_api", "status": "pass", "detail": "200 OK" },
      { "name": "zest_contract", "status": "pass" }
    ]
  },
  "error": null
}
```

### check-health

Check collateral health for a Zest borrower. Returns health factor, distance-to-liquidation, and alerts.

```bash
bun run zest-collateral-health/zest-collateral-health.ts check-health --address <stx_address>
```

Options:
- `--address` (required) — Stacks address of the borrower

Output:
```json
{
  "network": "mainnet",
  "address": "SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE",
  "supplied": 276019,
  "borrowed": 0,
  "useAsCollateral": true,
  "healthFactor": -1,
  "distanceToLiquidationPct": 100,
  "maxAdditionalBorrow": 207014,
  "status": "healthy",
  "alerts": ["No active borrows. Position is fully collateralized."],
  "timestamp": "2026-04-12T12:25:09.809Z"
}
```

### reserve-state

Read current sBTC reserve state from Zest pool-borrow contract. Shows pool-level metrics.

```bash
bun run zest-collateral-health/zest-collateral-health.ts reserve-state
```

Output:
```json
{
  "network": "mainnet",
  "contract": "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3",
  "asset": "sBTC",
  "aTokenAddress": "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0",
  "baseLtv": 70000000,
  "liquidationThreshold": 75000000,
  "liquidationBonus": 10000000,
  "totalBorrowsVariable": 319058704,
  "currentLiquidityRate": 188061,
  "currentVariableBorrowRate": 5351421,
  "supplyCap": 500000000000,
  "lastUpdatedBlock": 7573977,
  "timestamp": "2026-04-12T12:25:13.419Z"
}
```

## Output contract

All outputs are JSON to stdout. Uses BFF extension format: `{ status, action, data, error }` for doctor; flat fields for health checks.

On error:
```json
{ "error": "descriptive message" }
```

## Known constraints

- Mainnet only — Zest pool-borrow-v2-3 is deployed on mainnet.
- No wallet required — all operations are read-only contract calls.
- Health factor -1 means no borrows (infinite health — cannot be liquidated).
- Status thresholds: healthy (>1.3), warning (1.1–1.3), danger (1.0–1.1), liquidatable (<1.0).
- Liquidation threshold is read from on-chain state (currently 75% for sBTC, i.e. 75000000 / 1e8).
- `distanceToLiquidationPct` shows how much headroom remains before liquidation as a percentage of max borrow capacity.
- `maxAdditionalBorrow` is denominated in the same unit as the supplied asset (sats for sBTC).
- Hiro API timeout is 15 seconds — if Hiro is degraded, doctor will report the failure.
- This skill reads the borrower's own position. For liquidator-side monitoring, use a separate skill.
