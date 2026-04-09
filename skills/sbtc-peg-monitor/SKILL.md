---
name: sbtc-peg-monitor
description: "Monitor sBTC peg health, total supply, deposit/withdrawal activity, and alert on deviations for agents holding or bridging sBTC."
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "true"
  arguments: "doctor | run --action=status | run --action=deposit-check --txid <hash> | install-packs"
  entry: "sbtc-peg-monitor/sbtc-peg-monitor.ts"
  requires: "settings"
  tags: "defi, read-only, mainnet-only, l2"
---

# sBTC Peg Monitor

## What it does

Monitors the health of the sBTC peg by reading total supply directly from the `sbtc-token` contract on Stacks mainnet, tracking recent deposit and withdrawal activity via the Emily API, and checking individual deposit status by Bitcoin txid. Reports peg ratio, supply totals, recent activity, and wallet balance as a percentage of total supply.

## Why agents need it

Every agent holding sBTC or using it in DeFi (Zest, Bitflow, JingSwap) depends on the peg being healthy. If total supply deviates from BTC reserves, or if the deposit/withdrawal pipeline stalls, agents need to know before committing funds. This skill provides a single-call health check that answers: is the peg healthy, is the bridge active, and where is my deposit?

## Commands

| Command | Description |
|---------|-------------|
| `doctor` | Verify sBTC contract, Emily API, Hiro API, and optional wallet |
| `run --action=status` | Full peg health: supply, peg ratio, recent deposits/withdrawals, alerts |
| `run --action=deposit-check --txid <hash>` | Check status of a specific BTC deposit by txid |
| `install-packs` | Report dependencies (@stacks/transactions, @stacks/network) |

## On-chain proof

Tested on Stacks mainnet (April 9, 2026):

| Check | Result |
|-------|--------|
| Total sBTC supply | 405,655,465,558 sats (~4,056 BTC) |
| Peg ratio | 1:1 |
| sBTC contract | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` verified |
| Emily API | Deposit/withdrawal endpoints responsive |

## Safety notes

- **Read-only.** No transactions, no fund movement, no signing.
- **No wallet required** for peg monitoring. Wallet config is optional — adds your balance context to the status output.
- **Emily API dependency.** Deposit status checks use the Emily signer API. If Emily is down, peg monitoring via contract reads still works.
