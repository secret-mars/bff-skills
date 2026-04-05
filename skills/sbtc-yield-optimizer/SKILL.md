---
name: sbtc-yield-optimizer
description: Compare live sBTC yield across Zest Protocol, Bitflow HODLMM, and ALEX pools — then output the highest-APY strategy with exact MCP commands to execute.
author: flamiinngo
author_agent: Flamingo
user-invocable: true
arguments: doctor | run | install-packs
entry: sbtc-yield-optimizer/sbtc-yield-optimizer.ts
requires: [wallet, signing, settings]
tags: [defi, read-only, mainnet-only, l2, infrastructure]
---

# sBTC Yield Optimizer

## What it does

Queries live APY data from three sBTC yield venues — Zest Protocol (lending), Bitflow HODLMM (concentrated liquidity), and ALEX (standard AMM pools) — ranks them by net yield, and outputs the optimal allocation strategy with ready-to-execute MCP commands. Agents get a single, actionable answer: where does my sBTC earn the most right now?

## Why agents need it

sBTC yield opportunities change daily. An agent holding idle sBTC but checking only one protocol misses 2–5x better returns available elsewhere. This skill eliminates the need to query three separate APIs by hand, normalizes APY calculations across fundamentally different mechanisms (lending rate vs. LP fee APY vs. HODLMM range yield), and surfaces the winner with zero ambiguity.

## Safety notes

- **Read-only.** This skill never submits transactions. All outputs are advisory.
- **No funds moved.** Wallet is queried for balance context only — nothing is signed or broadcast.
- **MCP commands are suggestions.** The agent must explicitly invoke the recommended MCP tool to act. This skill does not auto-execute.
- **APY is live, not guaranteed.** Rates reflect current on-chain state. Lending rates are utilization-dependent; LP yields depend on volume.
- **Mainnet only.** All three protocols are mainnet-only.

## Commands

### doctor
Checks wallet sBTC balance, connectivity to Zest/Bitflow/ALEX APIs, and whether balances are sufficient for any action. Safe to run anytime.
```bash
bun run skills/sbtc-yield-optimizer/sbtc-yield-optimizer.ts doctor
```

### run
Queries all three protocols, ranks by APY, and outputs the winning strategy.

**Compare all venues (default):**
```bash
bun run skills/sbtc-yield-optimizer/sbtc-yield-optimizer.ts run
```

**Show full breakdown of all venues:**
```bash
bun run skills/sbtc-yield-optimizer/sbtc-yield-optimizer.ts run --action=compare
```

**Check a specific venue:**
```bash
bun run skills/sbtc-yield-optimizer/sbtc-yield-optimizer.ts run --action=venue --venue=zest
bun run skills/sbtc-yield-optimizer/sbtc-yield-optimizer.ts run --action=venue --venue=hodlmm
bun run skills/sbtc-yield-optimizer/sbtc-yield-optimizer.ts run --action=venue --venue=alex
```

### install-packs
Reports on required runtime dependencies (no external packages beyond bun built-ins).
```bash
bun run skills/sbtc-yield-optimizer/sbtc-yield-optimizer.ts install-packs --pack all
```

## Output contract
All outputs are JSON to stdout.

```json
{
  "status": "success | error | blocked",
  "action": "what the agent should do next",
  "data": {
    "winner": {
      "venue": "zest | hodlmm | alex",
      "apy_pct": 4.2,
      "mechanism": "lending | lp | concentrated-lp",
      "mcp_command": {
        "tool": "zest_supply",
        "params": { "asset": "sBTC", "amount": "100000" }
      }
    },
    "rankings": [
      { "venue": "zest", "apy_pct": 4.2, "tvl_usd": 2100000, "notes": "" },
      { "venue": "hodlmm", "apy_pct": 3.1, "tvl_usd": 1300000, "notes": "sBTC/STX pool" },
      { "venue": "alex", "apy_pct": 1.8, "tvl_usd": 800000, "notes": "sBTC/STX standard AMM" }
    ],
    "wallet_sbtc_sats": 200,
    "min_viable_sats": 1000
  },
  "error": null
}
```

## Known constraints
- ALEX APY is estimated from 7-day trailing fee volume divided by TVL (annualized). Real returns vary with volume.
- Bitflow HODLMM APY reflects the full-range average — in-range positions earn more; out-of-range earn nothing.
- Zest lending APY is the current supply rate, which changes with utilization. Check before large deposits.
- Minimum viable deposit for Zest: ~1,000 sats (gas cost exceeds yield below this threshold).
- Doctor command flags if wallet sBTC < 1,000 sats as `low_balance` (not blocked — read-only still works).
