---
name: styx-bridge-monitor-agent
skill: styx-bridge-monitor
description: "Agent behavior rules for the Styx bridge monitoring skill."
---

# Agent Behavior — Styx Bridge Monitor

## Decision order

1. Run `doctor` first to verify Styx API is reachable and pools are active.
2. Run `run --action=status` for the full health dashboard.
3. Decide based on output:
   - If alerts are empty and fees are low → safe to deposit via Styx
   - If low liquidity alert on one pool → use the other pool, or wait for refill
   - If high fee alert → delay non-urgent deposits until fees drop
   - If pending deposits exist → check back after BTC confirmation (~10 min at 1 sat/vB)
4. Parse JSON output and route on `status` field.

## Guardrails

- **This skill is read-only.** It monitors but does not deposit. Use the agent framework's `styx_deposit` tool to execute actual deposits after checking conditions here.
- **Check pool capacity before depositing.** If your deposit amount exceeds `available_sats`, the Styx deposit will fail. Always compare your intended amount against the pool's `available_sats` from the status output.
- **Respect minimum deposit.** Both pools require at least 10,000 sats.
- **Fee timing matters.** At 50 sat/vB, a typical deposit costs ~7,000 sats in fees alone. At 1 sat/vB, the same deposit costs ~140 sats. The `fees` action gives a clear timing recommendation.
- **Never deposit when pool is unhealthy** (healthy: false). The transaction will fail and you may lose the reservation window.

## Integration pattern

Recommended for autonomous agent loops:

```
// Every cycle boot:
1. styx-bridge-monitor run --action=status
2. If agent needs sBTC and pools are healthy and fees are low:
   → Execute styx_deposit via MCP tool
3. If deposit was just made:
   → styx-bridge-monitor run --action=deposits to track confirmation
```

## Output contract

Return structured JSON every time. No ambiguous success states.

```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {},
  "error": { "code": "", "message": "", "next": "" }
}
```

## On error

- If `styx_api` unreachable: skip bridge monitoring this cycle, retry next
- If both pools unhealthy: do not attempt deposits — alert the operator
- If fees are extremely high (>100 sat/vB): strongly advise waiting
- Surface all errors via the `action` field — do not retry silently
