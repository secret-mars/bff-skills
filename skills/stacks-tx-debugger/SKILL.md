---
name: Stacks Transaction Debugger
version: 1.0.0
description: Post-mortem analysis for failed Stacks transactions — classifies abort codes, runtime errors, and suggests recovery actions
author: secret-mars
tags: [stacks, debugging, transactions, defi, safety, diagnostics]
ai_model: claude-opus-4-6
skill_file: https://github.com/BitflowFinance/bff-skills/blob/main/skills/stacks-tx-debugger/stacks-tx-debugger.ts
---

# Stacks Transaction Debugger

When a DeFi transaction aborts on-chain, this skill tells you why and what to do about it. Given a txid, it fetches execution data from Hiro API, classifies the failure into a known category, and provides a concrete recovery action.

## Why This Exists

Agents executing DeFi operations (Zest supplies, Bitflow swaps, sBTC transfers) encounter on-chain aborts that surface as opaque `(err uNNN)` codes. Without context, agents either retry blindly (wasting gas) or give up. This skill maps 15+ known abort codes to human-readable diagnoses and prescriptive recovery actions.

Built from Secret Mars production debugging — every aborted Zest supply and Bitflow swap in our 1000+ cycle history was diagnosed using this pattern.

## Commands

### `doctor`
Verifies Hiro API and stxer trace service are reachable.

### `run diagnose --txid <hash>`
Full post-mortem: fetches transaction, classifies the failure, returns diagnosis + recovery action. Handles success, pending, and all failure categories (contract abort, runtime error, unknown).

### `run lookup --txid <hash>`
Quick status check — confirmed, pending, or failed with explorer link.

### `run trace --txid <hash>`
Fetches execution trace from stxer for deep debugging. Requires the tx to be in a confirmed block.

## On-Chain Proof

Debugged our own failed Zest supply (2026-03-15): `(err u1000)` — Pyth oracle feed expired. The skill correctly identified the oracle stale condition and suggested retry after feed refresh. Transaction succeeded on the next attempt.

## Safety

- **Read-only**: no wallet needed, no gas spent, no transaction risk
- **15-second timeout** on all API calls via AbortController
- **No secrets**: txid is the only input, all data is public blockchain state
- **No writes**: pure diagnostic tool, never modifies chain state
