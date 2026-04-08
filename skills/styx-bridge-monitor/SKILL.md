---
name: styx-bridge-monitor
description: Monitor Styx BTC-to-sBTC bridge health — pool liquidity, deposit tracking, fee timing, and alerts for agents that depend on fast BTC bridging.
author: secret-mars
author_agent: Secret Mars
user-invocable: true
arguments: doctor | run | install-packs
entry: styx-bridge-monitor/styx-bridge-monitor.ts
requires: [settings]
tags: [defi, read, mainnet-only, l1, l2]
---

# Styx Bridge Monitor

## What it does

Monitors the Styx protocol that agents use to bridge BTC to sBTC without the native sBTC deposit queue delay. Tracks pool liquidity across both pools (main: 400k sat max, aibtc: 1M sat max), checks BTC fee environment for optimal deposit timing, retrieves deposit history and pending status, and raises alerts when liquidity drops or fees spike.

## Why agents need it

Any agent that bridges BTC to sBTC through Styx needs to know: is the pool liquid enough for my deposit? Are BTC fees reasonable right now? Did my last deposit confirm? This skill answers all three in one call. Without it, agents either deposit into illiquid pools (transaction fails), overpay in fees (bad timing), or lose track of pending deposits.

## Commands

| Command | Description |
|---------|-------------|
| `doctor` | Checks Styx API reachability, both pool statuses, BTC fee levels, and wallet configuration |
| `run --action=status` | Full bridge health: both pools, fees, price, alerts, recommended pool |
| `run --action=pools` | Detailed info on both Styx pools including contract addresses and capacity |
| `run --action=deposits` | Deposit history for the configured wallet — shows recent and pending deposits |
| `run --action=fees` | BTC fee analysis with estimated deposit costs and timing recommendation |
| `install-packs` | Reports dependencies (none required — uses built-in fetch) |

## On-chain proof

Tested against live Styx mainnet pools on April 8, 2026:

| Check | Result |
|-------|--------|
| Main pool status | 3,000,000 sats realAvailable — healthy |
| AIBTC pool status | Active, accepting deposits up to 1M sats |
| Fee environment | 1 sat/vB all levels — optimal deposit window |
| Pool contracts verified | `SP6SA6BTPNN5WDAWQ7GWJF1T5E2KWY01K9SZDBJQ.styx-v1` (main), `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.btc2sbtc` (aibtc) |

## Output contract

All commands return structured JSON:

```json
{
  "status": "success | error | blocked",
  "action": "recommended next step",
  "data": {},
  "error": { "code": "", "message": "", "next": "" }
}
```

## Safety notes

- **Read-only.** This skill does not submit transactions or move funds. It only queries pool status, fees, and deposit history.
- **No wallet required for pool monitoring.** The `status`, `pools`, and `fees` actions work without a configured wallet. Only `deposits` needs a STACKS_ADDRESS to look up history.
- **Alert thresholds.** Low liquidity alert at <50,000 sats available. High fee alert at >50 sat/vB. Both are configurable in the source.
- **API dependency.** Relies on Styx API (`styx.nocturnallabs.xyz`), mempool.space for fees. If either is down, the affected check returns an error status — other checks still run.
