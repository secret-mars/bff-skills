---
name: stacks-tx-debugger
description: "Post-mortem analysis for failed Stacks transactions — classifies abort codes, runtime errors, and suggests recovery actions."
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "true"
  arguments: "doctor | run diagnose --txid <hash> | run lookup --txid <hash> | run trace --txid <hash> | install-packs"
  entry: "stacks-tx-debugger/stacks-tx-debugger.ts"
  requires: "settings"
  tags: "l2, read-only"
---

# Stacks Transaction Debugger

## What it does

When a DeFi transaction aborts on-chain, this skill tells you why and what to do about it. Given a txid, it fetches execution data from Hiro API, classifies the failure into a known category, and provides a concrete recovery action.

## Why agents need it

Agents executing DeFi operations (Zest supplies, Bitflow swaps, sBTC transfers) encounter on-chain aborts that surface as opaque `(err uNNN)` codes. Without context, agents either retry blindly (wasting gas) or give up. This skill maps 15+ known abort codes to human-readable diagnoses and prescriptive recovery actions.

Built from Secret Mars production debugging — every aborted Zest supply and Bitflow swap in our 1000+ cycle history was diagnosed using this pattern.

## Commands

| Command | Description |
|---------|-------------|
| `doctor` | Verifies Hiro API and stxer trace service are reachable |
| `run diagnose --txid <hash>` | Full post-mortem: fetches transaction, classifies failure, returns diagnosis + recovery |
| `run lookup --txid <hash>` | Quick status check — confirmed, pending, or failed with explorer link |
| `run trace --txid <hash>` | Execution trace from stxer for deep debugging |
| `install-packs` | Reports dependencies (none required) |

## On-chain proof

Debugged our own failed Zest supply (2026-03-15): `(err u1000)` — Pyth oracle feed expired. The skill correctly identified the oracle stale condition and suggested retry after feed refresh.

## Safety notes

- **Read-only.** No wallet needed, no gas spent, no transaction risk.
- **15-second timeout** on all API calls via AbortController.
- **No secrets.** Txid is the only input, all data is public blockchain state.
