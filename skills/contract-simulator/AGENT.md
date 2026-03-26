# Contract Simulator — Agent Decision Guide

## When to use this skill

**Before ANY on-chain contract call.** This is a pre-broadcast safety gate. The pattern:

1. Build your contract call (function name, arguments, contract address)
2. Run `--action=simulate` with the exact Clarity code
3. Check `broadcast_safe` in the output
4. Only proceed with MCP broadcast tool if `broadcast_safe: true`

## Decision order

1. Run `doctor` to verify stxer API and wallet.
2. Construct the Clarity code for your intended contract call.
3. Run `--action=simulate --contract=ADDR.name --code='(contract-call? ...)'`.
4. If `broadcast_safe: true` → proceed with `call_contract` MCP tool.
5. If `broadcast_safe: false` → DO NOT broadcast. Check the error code:
   - `(err u1)` on SIP-010 tokens = insufficient balance
   - `(err u2)` on SIP-010 tokens = not authorized
   - Other errors: check the contract source for error code meanings
6. For read-only queries, use `--action=read` (same simulation, just cleaner interface).

## Guardrails

- **Always simulate before broadcast.** No exceptions. A 2-second simulation saves gas and prevents on-chain reverts.
- **Do not ignore `broadcast_safe: false`.** The simulation runs against current chain state. If it fails in simulation, it will fail on-chain.
- **State can change.** Simulation reflects state at the latest block. For high-value or time-sensitive calls, minimize delay between simulation and broadcast.
- **Eval errors are not contract errors.** If the simulation itself fails (wrong contract address, malformed Clarity), the error is in your call construction, not the contract.

## Chaining with other skills

This skill is a universal safety gate. Use it before:
- **Zest Yield Manager:** Simulate `supply` or `withdraw` before executing
- **Multi-DEX Aggregator:** Simulate swap calls before broadcasting
- **Any token transfer:** Simulate to verify balance and authorization
- **Contract deployments:** Simulate init functions before deploying

## Example: Pre-flight a Zest supply

```bash
npx tsx contract-simulator.ts run \
  --action=simulate \
  --contract=SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3 \
  --code='(contract-call? .pool-borrow-v2-3 supply ...args...)'
```

If result is `(ok true)` → safe to call `zest_supply` MCP tool.
If result is `(err uN)` → check Zest contract for error code N.
