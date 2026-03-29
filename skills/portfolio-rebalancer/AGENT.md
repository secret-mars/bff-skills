---
name: portfolio-rebalancer-agent
skill: portfolio-rebalancer
description: "Agent behavior for the Portfolio Rebalancer — multi-position DeFi portfolio drift detection and rebalance execution."
---

# Agent Behavior — Portfolio Rebalancer

## Decision order

1. Run `doctor` first. If APIs are down, skip portfolio check this cycle.
2. Run `run status` with your Stacks address and current target allocations.
3. If `needs_rebalance` is false, log the positions and move on — no action needed.
4. If `needs_rebalance` is true, review `suggested_moves`:
   - For each move, run `run rebalance --dry-run` to preview.
   - If the move looks correct, use the appropriate MCP tool to execute it.
   - After execution, re-run `run status` to verify the rebalance landed.
5. Log the portfolio state in your journal every cycle.

## Guardrails

- **Never move funds without checking drift first.** Always run `status` before `rebalance`.
- **Respect the safety cap.** Default max single move is 100k sats. Override only with explicit reasoning.
- **Never drain liquid below 50k sats.** This floor ensures the agent always has operational funds for messaging, fees, and emergency actions.
- **Use defi-tx-simulator before broadcasting.** The rebalance command tells you WHAT to move; simulate before actually doing it.
- **Don't rebalance on small drift.** The 5% threshold prevents unnecessary churn. Trust it.
- **Two-step moves need careful ordering.** For zest-to-v0 or v0-to-zest, withdraw first, then deposit. Don't attempt both in one tx.

## On error

- If `status` fails with FETCH_FAIL, check API connectivity with `doctor`.
- If `rebalance` returns OVER_CAP, reduce the amount or increase the cap (with justification).
- If `rebalance` returns EXECUTION_DEFERRED, use the specified MCP tool to execute the move.
- Log all errors to the journal. Don't retry the same failing operation without changing parameters.

## On success

- Log the portfolio state: total sats, per-bucket allocation, drift values.
- If a rebalance was executed, log the tx hash and verify with `get_transaction_status`.
- Update `health.json` with the new balance values.

## Composition with other skills

This skill pairs naturally with:
- **defi-tx-simulator** — simulate the rebalance transaction before broadcast
- **zest-yield-manager** — execute the Zest supply/withdraw portion of a rebalance
- **sbtc-auto-funnel** — route new revenue to the right bucket based on current allocation
