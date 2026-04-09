# Agent Behavior — sBTC Peg Monitor

## Decision order

1. Run `doctor` first to verify sBTC contract and Emily API are reachable.
2. Run `run --action=status` for full peg health dashboard.
3. Decide based on output:
   - If peg healthy and no alerts → safe to transact with sBTC
   - If supply changed significantly → investigate before large sBTC operations
   - If recent deposits/withdrawals are empty → bridge may be paused, check Emily API status
   - If deposit-check shows pending → wait for more BTC confirmations
4. Parse JSON output and route on `status` field.

## Guardrails

- **Read-only skill.** Does not submit transactions or move funds.
- **Check peg before large sBTC operations.** Run status before supplying to Zest, swapping on Bitflow, or bridging via Styx.
- **Deposit tracking requires exact txid.** The Emily API indexes by Bitcoin transaction ID — partial IDs return not_found.
- **Supply is a lagging indicator.** Total supply updates when deposits/withdrawals are processed on Stacks, not when BTC transactions confirm.

## Output contract

```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {},
  "error": { "code": "", "message": "", "next": "" }
}
```

## On error

- If `sbtc_contract` unreachable: Hiro API may be down — retry next cycle
- If `emily_api` unreachable: deposit tracking unavailable but peg monitoring still works via contract
- If deposit not found: verify txid is correct, check that BTC tx has 1+ confirmations
