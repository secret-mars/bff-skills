---
name: styx-bridge-monitor
description: "Monitor Styx BTC-to-sBTC bridge health — pool liquidity, deposit tracking, fee timing, and alerts for agents that depend on fast BTC bridging."
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "true"
  arguments: "doctor | run --action=status | run --action=fees | run --action=deposits | install-packs"
  entry: "styx-bridge-monitor/styx-bridge-monitor.ts"
  requires: "settings"
  tags: "defi, read-only, mainnet-only, l1, l2"
---

# Styx Bridge Monitor

## What it does

Monitors the Styx protocol that agents use to bridge BTC to sBTC without the native sBTC deposit queue delay. Reads pool state directly from the `SP6SA6BTPNN5WDAWQ7GWJF1T5E2KWY01K9SZDBJQ.styx-v1` contract on Stacks mainnet. Tracks pool liquidity, checks BTC fee environment for optimal deposit timing, and raises alerts when liquidity drops or fees spike.

## Why agents need it

Any agent that bridges BTC to sBTC through Styx needs to know: is the pool liquid enough for my deposit? Are BTC fees reasonable right now? Did my last deposit confirm? This skill answers all three in one call. Without it, agents either deposit into illiquid pools (transaction fails), overpay in fees (bad timing), or lose track of pending deposits.

## Commands

| Command | Description |
|---------|-------------|
| `doctor` | Checks Styx contract reachability, pool liquidity, BTC fee levels, and wallet configuration |
| `run --action=status` | Full bridge health: pool capacity, fees, price, utilization, alerts, recommended timing |
| `run --action=fees` | BTC fee analysis with estimated deposit costs and timing recommendation |
| `run --action=deposits` | Wallet sBTC balance check against pool availability |
| `install-packs` | Reports dependencies (@stacks/transactions, @stacks/network) |

## On-chain proof

Tested against live Styx mainnet contract on April 8, 2026:

| Check | Result |
|-------|--------|
| Main pool status | 1,964,189 sats sBTC available (90% utilization) |
| Pool total | 20,194,421 sats total sBTC in pool |
| Protocol fee | 3,000 sats per deposit |
| Fee environment | 1 sat/vB — optimal deposit window |
| Contract | `SP6SA6BTPNN5WDAWQ7GWJF1T5E2KWY01K9SZDBJQ.styx-v1` verified active |

## Safety notes

- **Read-only.** This skill does not submit transactions or move funds. It only queries pool status, fees, and deposit history.
- **No wallet required for pool monitoring.** The `status`, `fees` actions work without a configured wallet. Only `deposits` needs a STACKS_ADDRESS.
- **Alert thresholds.** Low liquidity alert at <50,000 sats available. High fee alert at >50 sat/vB.
- **API dependency.** Reads from Styx contract via Hiro API and mempool.space for fees. If either is down, the affected check returns an error status — other checks still run.
