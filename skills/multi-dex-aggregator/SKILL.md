---
name: multi-dex-aggregator
version: 1.0.0
description: Compare quotes across Bitflow and ALEX DEXes, execute swaps at the best rate
author: Secret Mars
agent_address: SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE
tags: [defi, dex, trading, bitflow, alex, aggregator]
commands: [doctor, run, install-packs]
actions: [compare, swap, routes]
mcp_tools: [bitflow_get_quote, bitflow_swap, alex_get_swap_quote, alex_swap]
network: mainnet
---

# Multi-DEX Quote Aggregator

Compares live quotes from Bitflow and ALEX — Stacks' two primary DEXes — and routes swaps through whichever offers the better rate. Built from 800+ cycles of real DeFi operations where even small rate differences compound across hundreds of trades.

## Why this exists

Stacks has two major DEXes with different liquidity pools, fee structures, and routing algorithms. Manually checking both before every swap is slow and error-prone. This skill automates the comparison and outputs the exact MCP command to execute on the winning DEX.

## Commands

### `doctor`
Pre-flight checks: wallet balance, Bitflow API, ALEX API, required MCP tools.

### `run --action=compare --from=STX --to=sBTC --amount=1`
Fetches quotes from both DEXes in parallel, compares rates, and reports:
- Best DEX and expected output amount
- Rate comparison and savings percentage
- Ready-to-execute MCP command for the winning DEX

### `run --action=swap --from=STX --to=sBTC --amount=1`
Same as compare, plus balance and spend-limit validation. Outputs the MCP command payload only after all pre-checks pass.

### `run --action=routes --from=STX --to=sBTC`
Lists available routing paths on both DEXes for a given pair.

### `install-packs`
No additional packages — uses native fetch API.

## Supported Tokens

| Symbol | Bitflow | ALEX | Decimals |
|--------|---------|------|----------|
| STX | token-stx | token-wstx | 6 |
| sBTC | token-sbtc | - | 8 |
| wBTC | token-wbtc | token-wbtc | 8 |
| sUSDT | token-susdt | token-susdt | 6 |
| ALEX | token-alex | age000-governance-token | 8 |
| aeUSDC | token-aeusdc | - | 6 |
| stSTX | token-ststx | - | 6 |

Not all tokens are available on both DEXes. When a token is only on one DEX, the skill returns a single-DEX quote and notes the limitation.

## Output Contract

```json
{
  "status": "success | error | blocked",
  "action": "string — human-readable next step",
  "data": {
    "comparison": {
      "from": "STX",
      "to": "sBTC",
      "amount": "1",
      "quotes": {
        "bitflow": { "dex": "Bitflow", "amountIn": "1", "amountOut": "0.000012", "rate": 0.000012, "route": [], "available": true },
        "alex": { "dex": "ALEX", "amountIn": "1", "amountOut": "0.000011", "rate": 0.000011, "route": [], "available": true }
      },
      "best_dex": "Bitflow",
      "savings_pct": 8.33
    },
    "mcp_command": {
      "tool": "bitflow_swap",
      "params": { "tokenX": "token-stx", "tokenY": "token-sbtc", "amountIn": "1", "amountUnit": "human" }
    }
  },
  "error": null
}
```

## Safety Controls

- **Spend limits enforced in code:** sBTC max 500,000 sats, STX max 100 per swap. Hard block if exceeded.
- **Balance validation:** Checks on-chain balance before generating swap command. Blocks if insufficient.
- **Gas check:** Verifies STX gas balance > 100,000 uSTX before proceeding.
- **No auto-execute:** Outputs MCP command payload but does not broadcast. Agent decides whether to execute.
- **Slippage default:** 2% slippage tolerance (configurable).

## On-Chain Proof

| Operation | Txid | Block | Result |
|-----------|------|-------|--------|
| Bitflow swap (STX→sBTC) | [841a35cb3351dc6e2e35db8cbd94a13668810e21011994921cbae61f48a77554](https://explorer.hiro.so/txid/841a35cb3351dc6e2e35db8cbd94a13668810e21011994921cbae61f48a77554?chain=mainnet) | mainnet | `(ok ...)` |

## Limitations

- v1 does not implement transaction simulation (stxer dry-run) before swap. Pre-checks cover balance, gas, and spend limits.
- **ALEX MCP token resolution:** `alex_get_swap_quote` currently has a token resolution issue — `alex_list_pools` returns full contract IDs but the quote tool may not accept them. Bitflow is the reliable primary DEX for sBTC pairs. ALEX support improves as the MCP server matures.
- **sBTC is Bitflow-only** on Stacks. ALEX does not list sBTC, so STX/sBTC and sBTC/* pairs route through Bitflow exclusively.
- Token mappings are hardcoded for 7 common tokens. The skill gracefully handles tokens missing from one DEX by surfacing single-DEX quotes.
