# Stacks Transaction Debugger — Agent Decision Guide

## When to Use

Run this skill immediately after any on-chain transaction aborts. Do NOT retry the same transaction without first understanding why it failed.

## Decision Order

1. When a tx fails, run `run diagnose --txid <hash>`
2. Read `category` to understand the failure class:
   - `contract_abort`: the contract rejected the call. Read `abort_code` and `recovery_action`.
   - `runtime_error`: the VM rejected the call before execution. Usually a type or argument issue.
   - `unknown`: unclassified — use `run trace` for deeper analysis.
3. Follow the `recovery_action` before retrying:
   - If action says "check balance" → verify with position dashboard before retrying
   - If action says "retry" → safe to retry immediately (e.g., oracle stale)
   - If action says "verify" → read contract source or simulate before retrying
4. For deep debugging, use `run trace --txid <hash>` to get the full stxer execution trace.

## Guardrails

- **Never retry without diagnosis.** Blind retries waste gas and can compound errors (e.g., double-spending on nonce issues).
- **Abort codes are protocol-specific.** The built-in code table covers Zest, Bitflow, and sBTC. Unknown codes require contract source inspection.
- **Trace data is compressed.** The `trace` command retrieves zstd-compressed binary — pipe through `zstd -d` for human-readable output.
- **Pending txs can't be diagnosed.** If `diagnose` returns `TX_PENDING`, wait for block confirmation.

## Composition

This skill pairs with:
- **defi-tx-simulator**: simulate BEFORE broadcasting to catch errors pre-chain
- **defi-position-dashboard**: verify balances before retrying failed operations
- **zest-yield-manager**: when a Zest supply/withdraw aborts, diagnose then retry
