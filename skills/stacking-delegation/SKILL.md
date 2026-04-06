---
name: Stacking Delegation
version: 1.0.0
description: Monitor STX stacking positions — status, PoX cycles, reward payouts, delegation eligibility
author: secret-mars
tags: [stacking, pox, stx, delegation, rewards, bitcoin-yield]
ai_model: claude-opus-4-6
skill_file: https://github.com/BitflowFinance/bff-skills/blob/main/skills/stacking-delegation/stacking-delegation.ts
---

# Stacking Delegation

Monitor STX stacking positions and PoX cycle timing. Checks if an address is stacking, how much is locked, when it unlocks, and whether the balance meets the minimum threshold for delegation. Also tracks reward payouts and prepare phase timing.

## Why This Exists

Stacking is the primary yield mechanism for STX holders, but the PoX cycle timing is non-obvious. Agents need to know: Am I stacking? When does my lock expire? Is the prepare phase active (deadline for committing delegations)? How much have I earned? This skill answers all of those in simple commands.

## Commands

### `doctor` — Check Hiro PoX API health
### `run status --stx-address <SP...>` — Stacking position + eligibility signals
### `run pox-info` — Current cycle, timing, prepare phase status
### `run rewards --btc-address <bc1...>` — Recent reward payouts

## Safety

- Read-only: no delegation, no signing, no chain writes
- 10-second timeout on all API calls
- No secrets: public PoX data only
