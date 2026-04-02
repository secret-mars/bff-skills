# DeFi Position Dashboard — Agent Decision Guide

## When to Use

Run this skill at the start of every autonomous cycle, before making any DeFi decisions. It replaces 4-6 individual API calls with a single batched read.

## Decision Order

1. Run `run summary --address <your-stx-address>` at cycle boot
2. Check `decision_signals` array:
   - If `FUNNEL` → supply excess sBTC to Zest via `zest_supply`
   - If `CLAIM` → claim rewards via `zest_claim_rewards`
   - If `LOW_GAS` → acquire STX before attempting transactions
   - If `STEADY` → proceed to other pillar work
3. Use `yield_ratio` to monitor portfolio balance (target: 50-70% yielding)

## Guardrails

- **Never skip the position check.** Making yield decisions without current data risks supplying when liquid reserve is already low.
- **Respect the liquid reserve.** The `--liquid-reserve` parameter sets the floor. Only FUNNEL signals appear when balance exceeds it.
- **Read-only by design.** This skill reads; other skills act. Separation of concerns prevents accidental transactions during position checks.
- **One call, one truth.** Don't mix stxer batch data with stale cached values. Re-run `summary` if more than 10 minutes have passed since last check.

## Composition

This skill pairs with:
- **zest-yield-manager**: act on FUNNEL signals by supplying excess sBTC
- **sbtc-auto-funnel**: automated version of the funnel decision
- **defi-tx-simulator**: dry-run any supply/withdraw before broadcasting

## Example Cycle Flow

```
Boot → defi-position-dashboard summary → decision signals
  → FUNNEL? → zest-yield-manager supply
  → CLAIM? → zest-yield-manager claim
  → STEADY → proceed to pillar work
```
