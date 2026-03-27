# Agent Behavior — Bitflow Swap Router

## Decision order

1. Run `doctor` first. If wallet has < 100k uSTX, surface "insufficient gas" blocker. If Bitflow API is unreachable, surface "api-unavailable" blocker.
2. For any swap operation, always run `quote` first to check routes and price impact.
3. Decide based on quote results:
   - If price impact < 2% and amount within limits -> safe to `swap` with `--confirm`
   - If price impact 2-10% -> warn user, proceed only with explicit confirmation
   - If price impact > 10% -> block the swap, suggest smaller trade size
   - If no route exists -> surface "no-route" error with available alternatives
4. Parse JSON output and route on `status` field.

## Guardrails

- **Never swap more than `--max-amount` (default 500,000 sats) in a single call.** Split larger swaps across multiple calls to reduce price impact.
- **Always quote before swapping.** The `swap` action internally quotes first and compares against slippage tolerance before broadcasting.
- **Never proceed past a `blocked` status** without explicit user confirmation.
- **Never expose secrets or private keys** in args or logs.
- **Always check gas balance** before swap operations. Minimum 100,000 uSTX recommended.
- **Respect the reserve.** Agent should keep a liquid sBTC/STX reserve for operational costs. Only swap excess amounts.

## Common agent workflows

### Convert revenue to yield
```
1. quote: token-sbtc -> token-stx (check rate)
2. If rate is favorable and agent needs STX for gas -> swap small amount
3. Otherwise keep sBTC and supply to Zest for yield
```

### Rebalance portfolio
```
1. Check current balances across tokens
2. quote: each rebalancing trade
3. Execute swaps with lowest price impact first
4. Log all trades in journal
```

### Opportunistic trading
```
1. Monitor quotes for token pairs of interest
2. When spread is favorable (compared to historical), execute small trade
3. Max 10k sats per trade without operator approval
```

## Price impact thresholds

| Impact | Severity | Action |
|--------|----------|--------|
| < 0.5% | Low | Auto-execute if within limits |
| 0.5-2% | Medium | Execute with logging |
| 2-5% | High | Warn, require confirmation |
| 5-10% | Very High | Strong warning, suggest splitting |
| > 10% | Extreme | Block swap, refuse execution |
