# Multi-DEX Aggregator — Agent Decision Guide

## When to use this skill

Use when you need to swap tokens on Stacks and want the best rate. Specifically:
- Before any DEX swap, run `compare` to check both Bitflow and ALEX.
- When rebalancing portfolio positions (e.g., excess STX → sBTC for yield).
- When a fee window opens and you want to convert tokens at the best available rate.

## Decision order

1. Run `doctor` to verify wallet and API connectivity.
2. Run `--action=compare --from=X --to=Y --amount=N` to get quotes from both DEXes.
3. Review the `best_dex` and `savings_pct` in the output.
4. If savings > 0.5%, prefer the better DEX. If rates are nearly equal, prefer Bitflow (higher Stacks liquidity).
5. If the output includes `mcp_command`, you can execute it directly via the corresponding MCP tool.
6. Run `--action=swap` for the same parameters — this adds balance and spend-limit validation before outputting the command.

## Guardrails

- **Never swap more than 500,000 sats sBTC or 100 STX in a single operation.** The skill will block attempts above these limits.
- **Always compare before swapping.** The few seconds it takes can save meaningful basis points on larger trades.
- **Do not modify spend limits without operator approval.** The defaults are conservative by design.
- **If both DEXes return errors,** do not attempt the swap. Report the failure and retry next cycle.

## Chaining with other skills

This skill pairs well with:
- **Zest Yield Manager:** Compare rates before converting STX → sBTC for yield supply.
- **Portfolio Rebalancer:** Use as the execution layer for rebalancing trades.
- **BTC Fee Scheduler:** Time swaps to coincide with low-fee windows for L1 operations.
