---
name: defi-tx-simulator-agent
skill: defi-tx-simulator
description: "Agent behavior rules for the DeFi Transaction Simulator — pre-broadcast safety gate for Stacks contract calls."
---

# Agent Behavior — DeFi Transaction Simulator

## Decision order

1. Run `doctor` first. If stxer API is down, skip simulation and log the blocker. Do NOT proceed to broadcast without simulation unless explicitly overridden by the operator.
2. Before any DeFi contract call (supply, swap, transfer, borrow), run `run simulate` with the exact parameters you plan to broadcast.
3. If verdict is `SAFE_TO_BROADCAST` — proceed with the MCP tool broadcast (e.g. `zest_supply`, `bitflow_swap`, `transfer_stx`).
4. If verdict is `DO_NOT_BROADCAST` — read the `interpretation` field, log the error, and do NOT broadcast. Surface the blocker to the operator or attempt a fix (e.g., reduce amount, check balance).
5. For common operations, use `run preset` with the appropriate preset name instead of constructing raw Clarity.

## Guardrails

- **Never broadcast a transaction that failed simulation.** This is the core safety rule. A simulation failure means the transaction WILL abort on-chain, wasting gas.
- **Always simulate with the exact parameters you plan to broadcast.** Don't simulate u10000 and then broadcast u100000. The simulation is only valid for the exact inputs tested.
- **Respect the safety cap.** The default max-amount is 500k sats. For larger operations, explicitly override with `--max-amount` — this forces conscious acknowledgment of the larger amount.
- **Minimize simulation-to-broadcast gap.** Chain state can change between simulation and broadcast. Run the simulation immediately before broadcasting — not minutes or cycles earlier.
- **Never expose private keys in simulation parameters.** Simulation uses sender addresses only (public), never signing keys.
- **When in doubt, simulate twice.** If the first simulation passes but you changed something, re-simulate.

## On error

- Log the full error payload including `raw_error`, `interpretation`, and `session_id`.
- Do NOT retry the same simulation with the same parameters — if it failed once, it will fail again unless you change something.
- Surface the `error.next` field to the operator as a suggested action.
- If the error is `STXER_DOWN`, defer the DeFi operation to the next cycle. Do not broadcast without simulation.

## On success

- Confirm the verdict is `SAFE_TO_BROADCAST` before proceeding.
- Log the `session_id` for audit trail.
- Proceed immediately to broadcast — minimize the time gap.
- After broadcast, verify with `get_transaction_status` to confirm on-chain success.

## Composition with other skills

This skill is designed as a safety primitive that other skills call before writing to chain:

```
[Agent decides to supply sBTC to Zest]
  → defi-tx-simulator run preset --name zest-supply --sender <addr> --amount <sats>
  → If SAFE_TO_BROADCAST → zest_supply(amount)
  → If DO_NOT_BROADCAST → log error, skip, try next cycle
```

Any skill that writes to chain should call this simulator first. It's the seatbelt for DeFi agents.
