# Agent Behavior — sBTC Yield Optimizer

## Decision order
1. Run `doctor` first. If APIs are unreachable or wallet has zero sBTC, surface the blocker and stop.
2. Run `run --action=compare` to get the full APY ranking.
3. Read `data.winner.venue` and `data.winner.apy_pct` to identify the top opportunity.
4. If `data.wallet_sbtc_sats < data.min_viable_sats`, inform the user that balance is too low to deploy but the ranking is still valid intelligence.
5. If proceeding: pass `data.winner.mcp_command` to the appropriate MCP tool. Do not modify the params without confirmation.
6. After executing the recommended action, re-run `doctor` to confirm the position was opened.

## Guardrails
- Never auto-execute the recommended MCP command. Always present it to the user or loop for confirmation before acting.
- Never proceed past a `blocked` status without explicit user confirmation.
- Never expose private keys or mnemonic phrases in args, logs, or output.
- If `status` is `error`, log the full error payload and surface `error.next` as the suggested recovery action.
- If APY data for any venue returns stale (>30 min old per `fetched_at` timestamp), flag it in your response and note that the ranking may be outdated.
- Default to read-only behavior when intent is ambiguous. Running `doctor` or `compare` is always safe.

## Output contract
Return structured JSON every time. No ambiguous success states.

```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {
    "winner": {
      "venue": "zest | hodlmm | alex",
      "apy_pct": 0.0,
      "mechanism": "lending | lp | concentrated-lp",
      "mcp_command": {}
    },
    "rankings": [],
    "wallet_sbtc_sats": 0,
    "min_viable_sats": 1000
  },
  "error": { "code": "", "message": "", "next": "" }
}
```

## On error
- Log the full error payload — do not swallow it.
- Surface `error.next` as the recommended recovery step.
- Do not retry silently. If a venue API is down, exclude it from rankings and note the exclusion in `data.rankings` with `"notes": "API unreachable — excluded"`.

## On success
- Report `winner.venue` and `winner.apy_pct` clearly.
- Include the full rankings table for transparency.
- If acting on the recommendation, confirm the on-chain result (tx hash) after executing the MCP command.
- Re-run doctor post-execution to verify the position is live.

## Routing on status
- `success` → present winner and rankings, offer to execute MCP command
- `blocked` → surface blocker with exact message, do not proceed
- `error` → log error, surface `next` action, offer to retry after fix

## HODLMM integration note
When `winner.venue === "hodlmm"`, the recommended MCP command will reference Bitflow's HODLMM Keeper contract. Confirm the user's wallet has been initialized with the Keeper contract before executing (bitflow-hodlmm-manager `doctor` will verify this).
