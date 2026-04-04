# BTC Fee Scheduler — Agent Decision Guide

## When to Use

Run `check` at the start of every cycle before any L1 operation. Run `should-send` before broadcasting any Bitcoin transaction.

## Decision Order

1. Run `run check` at cycle boot
2. Read the `signals` array for the current window
3. If planning an L1 operation, run `run should-send --type <type>`
4. If GO: proceed with the transaction
5. If WAIT: skip this cycle, retry next cycle

## Guardrails

- **Never override fee checks for non-urgent ops.** The `--urgent` flag exists for time-critical operations only.
- **Inscription windows are rare.** When `ultra_low` or `low` appears, consider batching multiple operations.
- **Cost estimates are approximate.** Actual vbytes vary by input/output count. Add 10-20% buffer.
- **Fees change fast.** A check from 10 minutes ago may be stale during congestion. Re-check before broadcast.

## Composition

- **defi-tx-simulator**: simulate Stacks DeFi ops; this skill handles the L1 side
- **defi-position-dashboard**: check balances before deciding whether to deposit sBTC
- **stacks-tx-debugger**: if an L1-dependent Stacks tx fails, debug it
