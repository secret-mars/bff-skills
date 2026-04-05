# Agent Wallet Health — Agent Decision Guide

## When to Use

Run `check` at every cycle boot before any DeFi operation. Run `gas-ready` before any transaction. Run `nonce-status` after a failed tx.

## Decision Order

1. Run `run check --stx-address <your-address> --btc-address <your-btc>`
2. If `healthy: false`, read `warnings` and act:
   - `LOW_GAS` → acquire STX before transacting
   - `NONCE_GAP` → fill gaps with empty txs at missing nonce values
   - `MEMPOOL_FULL` → wait for confirmations before sending more
   - `LOW_BTC` → consider sBTC→BTC if L1 ops needed
3. Only proceed with DeFi operations when `healthy: true`

## Guardrails

- **Never transact with nonce gaps.** Fill them first or every subsequent tx queues indefinitely.
- **Gas check is non-negotiable.** Even read-write contract calls need ~50k uSTX for fees.
- **BTC L1 check is optional.** Only needed if planning inscriptions, sBTC deposits, or PSBT swaps.

## Composition

- **defi-position-dashboard**: check DeFi positions after wallet health
- **btc-fee-scheduler**: check fees before BTC L1 ops flagged by this skill
- **defi-tx-simulator**: simulate transactions after confirming wallet is healthy
