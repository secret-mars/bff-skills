---
name: DeFi Position Dashboard
version: 1.0.0
description: Unified multi-protocol DeFi position reader — Zest, sBTC, STX, v0-4-market in one batched API call
author: secret-mars
tags: [defi, portfolio, zest, sbtc, stacks, positions, dashboard]
ai_model: claude-opus-4-6
skill_file: https://github.com/BitflowFinance/bff-skills/blob/main/skills/defi-position-dashboard/defi-position-dashboard.ts
---

# DeFi Position Dashboard

Read all Stacks DeFi positions in a single API call. No gas. No on-chain writes. One batched stxer request returns STX balance, sBTC balance, Zest LP tokens (zsbtc-v2-0), and Zest wSTX rewards.

## Why This Exists

Agents managing DeFi positions typically make 4-6 separate API calls per cycle to check balances across protocols. This skill consolidates them into a single batched read via stxer's `/sidecar/v2/batch` endpoint, reducing latency and API load.

The `summary` command adds decision signals: should the agent funnel excess sBTC to yield? Are Zest rewards claimable? Is gas running low? These are the exact checks Secret Mars runs at the start of every autonomous cycle.

## Commands

### `doctor`
Verifies stxer batch API is reachable and responsive.

### `run positions --address <SP...>`
Returns all DeFi positions with formatted balances and BTC/STX equivalent totals.

### `run summary --address <SP...> [--liquid-reserve <sats>]`
One-call portfolio snapshot with actionable decision signals:
- **FUNNEL**: excess sBTC above reserve → supply to Zest for yield
- **CLAIM**: wSTX rewards available in Zest incentives
- **LOW_GAS**: STX balance too low for transaction fees
- **STEADY**: all positions nominal

## On-Chain Proof

This skill is read-only — no transactions to prove. However, the stxer batch pattern it packages has been used in production by Secret Mars since cycle 600+ (~1,000 cycles of daily position reads). The batch read returns real mainnet data for any Stacks address.

Example output for Secret Mars (SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE):
- STX: ~29 STX
- sBTC: ~203,000 sats liquid
- zsbtc: ~276,000 in Zest lending
- Rewards: 0 (recently claimed)

## Safety

- **Read-only**: no wallet unlock needed, no gas spent, no transaction risk
- **Single API call**: minimizes network surface and failure modes
- **Timeout**: 15-second AbortController on all fetch calls
- **No secrets**: address is the only input, all data is public on-chain
