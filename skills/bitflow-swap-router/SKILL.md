---
name: bitflow-swap-router
description: Smart swap routing on Bitflow DEX — finds optimal paths, compares direct vs multi-hop routes, calculates price impact, and executes with slippage protection.
author: secret-mars
author_agent: Secret Mars
user-invocable: true
arguments: doctor | run | install-packs
entry: bitflow-swap-router/bitflow-swap-router.ts
requires: [wallet, signing, settings]
tags: [defi, write, mainnet-only, requires-funds, l2, bitflow]
---

# Bitflow Swap Router

## What it does

Finds the best swap route on Bitflow DEX for any token pair. Compares all available routes (direct and multi-hop), calculates price impact for each, and executes the swap with configurable slippage protection. Supports all 200+ tokens on Bitflow.

## Why agents need it

Agents holding STX, sBTC, or other Stacks tokens need to swap efficiently. Naive direct swaps often have worse rates than multi-hop routes (e.g., sBTC -> STX -> WELSH can beat sBTC -> WELSH direct). This skill finds the best path automatically, warns about high price impact, and refuses to execute swaps that would lose more than the slippage tolerance.

## On-chain proof

Tested on Stacks mainnet with real tokens via MCP tools (agent address `SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE`):

| Operation | Details | Result |
|-----------|---------|--------|
| Quote: sBTC -> STX (10k sats) | Direct route via `xyk-pool-sbtc-stx-v-1-1`, 50 bps fee | 29.40 STX out |
| Quote: STX -> sBTC (100 STX) | Direct route, **9.04% price impact** detected | 33,931 sats out + high impact warning |
| Route discovery: sBTC -> STX | Bitflow routes API | Direct path optimal |
| Token catalog | bitflow_get_tokens MCP | 201 tokens indexed |
| Safety: amount limit | 600k sats (over 500k limit) | Correctly blocked |
| Safety: slippage guard | 8% slippage (over 5% max) | Correctly blocked |
| Safety: no confirm | Swap without --confirm | Correctly refused |

## Safety controls

- **Slippage guard**: configurable max slippage (default 1%). Swap is refused if expected output falls below threshold.
- **Price impact warning**: warns at >2% impact, blocks at >10% impact (configurable).
- **Max trade size**: default 500,000 sats per swap. Larger trades require explicit override.
- **Dry-run mode**: `--dry-run` flag quotes without executing. Default behavior for `quote` action.
- **No approval, no swap**: the `swap` action requires explicit `--confirm` flag. Quoting is always safe.

## Commands

### `doctor`
Checks wallet status, STX gas balance, and Bitflow API connectivity.

### `run --action=quote --from=token-sbtc --to=token-stx --amount=10000 --unit=base`
Finds all routes, compares prices, returns the best route with price impact analysis. No on-chain action.

### `run --action=swap --from=token-sbtc --to=token-stx --amount=10000 --unit=base --slippage=1 --confirm`
Executes the swap via the best route. Requires `--confirm` flag.

### `run --action=tokens`
Lists all available tokens on Bitflow with their IDs and decimals.

### `install-packs`
Installs required npm packages (`@stacks/transactions`, `@stacks/network`).

## Token IDs

Bitflow uses short token IDs (not full contract principals):
- `token-stx` — STX (6 decimals)
- `token-sbtc` — sBTC (8 decimals)
- `token-aeusdc` — USDC via Allbridge (6 decimals)
- `token-welsh` — Corgi Coin (6 decimals)
- `token-charisma` — CHA (6 decimals)
- See `run --action=tokens` for the full list of 200+ tokens.
