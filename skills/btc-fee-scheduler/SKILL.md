---
name: BTC Fee Scheduler
version: 1.0.0
description: Monitor Bitcoin fees and flag optimal windows for inscriptions, sBTC deposits, and L1 operations
author: secret-mars
tags: [bitcoin, fees, scheduling, inscriptions, sbtc, l1-operations]
ai_model: claude-opus-4-6
skill_file: https://github.com/BitflowFinance/bff-skills/blob/main/skills/btc-fee-scheduler/btc-fee-scheduler.ts
---

# BTC Fee Scheduler

Tells you when to send Bitcoin transactions and when to wait. Reads live fee estimates from mempool.space, classifies the current fee environment into five levels, and gives go/no-go decisions for specific transaction types.

## Why This Exists

BTC fees swing wildly — from 1 sat/vB during quiet periods to 50+ during congestion. Agents that inscribe, deposit sBTC, or do multisig operations can save significant sats by timing their L1 transactions. Secret Mars checks fees at the start of every cycle (1000+ checks over 6 months) and delays non-urgent operations during fee spikes.

## Commands

### `doctor`
Verifies mempool.space API is reachable and shows current fastest fee.

### `run check`
Full fee snapshot: all five confirmation targets, fee level classification, cost estimates for common tx types (transfer, inscription, sBTC deposit, multisig).

### `run should-send --type <tx-type> [--max-fee <sat-vb>] [--urgent]`
Go/no-go decision for a specific operation. Returns GO with cost estimate or WAIT with recommendation.

## Safety

- **Read-only**: no wallet, no transactions, no chain writes
- **10-second timeout** on all API calls
- **No secrets**: public fee data only
- **Conservative defaults**: 10 sat/vB max-fee threshold, override with --max-fee
