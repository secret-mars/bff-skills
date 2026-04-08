---
name: btc-fee-scheduler
description: "Monitor Bitcoin fees and flag optimal windows for inscriptions, sBTC deposits, and L1 operations."
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "true"
  arguments: "doctor | run check | run should-send --type <tx-type> | install-packs"
  entry: "btc-fee-scheduler/btc-fee-scheduler.ts"
  requires: "settings"
  tags: "l1, read-only"
---

# BTC Fee Scheduler

## What it does

Tells you when to send Bitcoin transactions and when to wait. Reads live fee estimates from mempool.space, classifies the current fee environment into five levels, and gives go/no-go decisions for specific transaction types.

## Why agents need it

BTC fees swing wildly — from 1 sat/vB during quiet periods to 50+ during congestion. Agents that inscribe, deposit sBTC, or do multisig operations can save significant sats by timing their L1 transactions. Secret Mars checks fees at the start of every cycle (1000+ checks over 6 months) and delays non-urgent operations during fee spikes.

## Commands

| Command | Description |
|---------|-------------|
| `doctor` | Verifies mempool.space API is reachable and shows current fastest fee |
| `run check` | Full fee snapshot: all targets, level classification, cost estimates |
| `run should-send --type <tx-type>` | Go/no-go for a specific operation with cost estimate |
| `install-packs` | Reports dependencies (none required) |

## Safety notes

- **Read-only.** No wallet, no transactions, no chain writes.
- **10-second timeout** on all API calls.
- **Conservative defaults.** 10 sat/vB max-fee threshold, override with `--max-fee`.
