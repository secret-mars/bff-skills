---
name: zest-collateral-health-agent
skill: zest-collateral-health
description: "Monitors Zest Protocol borrower collateral health — health factor, liquidation distance, and alert routing for agents managing leveraged sBTC positions."
---

# Agent Behavior — Zest Collateral Health

## Decision order

1. Run `doctor` first. If Hiro API or Zest contract check fails, stop and surface the blocker.
2. Call `check-health --address <borrower>` to get current position health.
3. Route on `status` field:
   - `healthy` → no action needed, log and continue.
   - `warning` → alert the user, recommend adding collateral or reducing borrow.
   - `danger` → urgent alert, recommend immediate repayment or collateral top-up.
   - `liquidatable` → critical alert, position is at risk of liquidation.
4. Check `alerts` array for specific actionable guidance.
5. Use `reserve-state` for pool-level monitoring and supply/borrow rate awareness.

## Guardrails

- This skill is read-only. It never writes to chain or moves funds.
- Never ignore a `danger` or `liquidatable` status — always surface to the user.
- Never suppress alerts — each alert contains actionable guidance.
- Default to safe/read-only behavior when intent is ambiguous.
- Never expose secrets or private keys in args or logs.

## Monitoring cadence

- For active borrow positions: check every cycle (15 min).
- For idle supply-only positions: check every 3rd cycle.
- If `status` transitions from `healthy` to `warning`: increase check frequency.

## Output contract

**check-health output:**
```json
{
  "network": "mainnet",
  "address": "string",
  "supplied": "number (sats)",
  "borrowed": "number (sats)",
  "useAsCollateral": "boolean",
  "healthFactor": "number (-1 = no borrows, >1 = healthy, <1 = liquidatable)",
  "distanceToLiquidationPct": "number (0-100)",
  "maxAdditionalBorrow": "number (sats)",
  "status": "healthy | warning | danger | liquidatable",
  "alerts": "string[]",
  "timestamp": "ISO 8601"
}
```

**reserve-state output:**
```json
{
  "network": "mainnet",
  "contract": "string",
  "asset": "string",
  "baseLtv": "number",
  "liquidationThreshold": "number",
  "totalSupply": "number",
  "totalBorrow": "number",
  "supplyRate": "number",
  "borrowRate": "number",
  "lastUpdated": "number (block height)",
  "timestamp": "ISO 8601"
}
```

## On error

- Errors are returned as JSON: `{ "error": "descriptive message" }`
- Do not retry silently — surface the error to the user.
- Common errors: "Hiro API error", "Contract call failed", timeout.
- If Hiro is degraded, fall back to cached health data if available.

## On success

- Report the health classification and key metrics.
- If health factor is below warning threshold, include specific remediation guidance.
- Always include timestamp for cache/staleness checks.
