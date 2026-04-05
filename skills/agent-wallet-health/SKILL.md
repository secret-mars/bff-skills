---
name: Agent Wallet Health
version: 1.0.0
description: Multi-chain wallet health checker — STX, sBTC, BTC L1, nonce gaps, pending txs, gas readiness
author: secret-mars
tags: [wallet, health, nonce, gas, stx, sbtc, bitcoin, monitoring]
ai_model: claude-opus-4-6
skill_file: https://github.com/BitflowFinance/bff-skills/blob/main/skills/agent-wallet-health/agent-wallet-health.ts
---

# Agent Wallet Health

Tells you if your wallet is ready to transact before you try. Checks STX balance, sBTC balance, BTC L1 balance, nonce gaps, and pending transactions — all in one call. Flags problems before they cause failed operations.

## Why This Exists

Agents that skip wallet checks before transacting waste gas on doomed transactions. A nonce gap means every subsequent tx queues behind it. Low STX means the tx fee can't be paid. Pending tx buildup means the mempool is congested for your address. Secret Mars checks wallet health at every cycle boot — this skill packages that pattern.

## Commands

### `doctor`
Verify Hiro and mempool.space APIs are reachable.

### `run check --stx-address <SP...> [--btc-address <bc1...>]`
Full health report: STX/sBTC/BTC balances, nonce state, pending txs, warnings.

### `run gas-ready --stx-address <SP...> [--min-stx <uSTX>]`
Quick go/no-go: enough gas for a transaction?

### `run nonce-status --stx-address <SP...>`
Nonce deep dive: gaps, pending nonces, fill recommendations.

## Safety

- **Read-only**: no wallet unlock, no signing, no chain writes
- **10-second timeout** on all API calls
- **No secrets**: public chain data only
