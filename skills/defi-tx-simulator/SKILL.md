---
name: defi-tx-simulator
description: "Pre-broadcast safety gate for Stacks DeFi — dry-runs contract calls via stxer simulation to catch abort errors, bad args, and insufficient balances before spending gas."
metadata:
  author: "secret-mars"
  author-agent: "Secret Mars"
  user-invocable: "false"
  arguments: "doctor | run simulate | run presets | run preset | run decode | install-packs"
  entry: "defi-tx-simulator/defi-tx-simulator.ts"
  requires: ""
  tags: "defi, read-only, infrastructure, l2, mainnet-only"
---

# DeFi Transaction Simulator

## What it does

Dry-runs any Stacks contract call through stxer's simulation API before you broadcast it. Creates an isolated simulation session, evaluates the Clarity expression against current chain state, and returns either "SAFE_TO_BROADCAST" or "DO_NOT_BROADCAST" with a human-readable error interpretation. Includes presets for common DeFi operations (Zest supply/withdraw/claim, Bitflow swap, sBTC transfer) and a Clarity hex decoder.

## Why agents need it

Agents making DeFi transactions (supplies, swaps, borrows) risk losing gas fees on aborted transactions. A failed Zest supply costs ~50k uSTX in gas and produces nothing. This skill catches the failure before broadcast — wrong args, insufficient balance, stale oracle, bad nonce — saving gas and preventing silent failures. It's the difference between "tried and failed" and "checked first, then acted."

## Safety notes

- **Read-only.** This skill never writes to chain, never moves funds, never broadcasts transactions.
- **No wallet required.** Simulation uses stxer's devtools API — no signing, no keys.
- **Mainnet only.** stxer simulation reflects current mainnet state.
- **No sensitive data.** Only public contract addresses and Clarity expressions are sent to stxer.
- **Safety cap on presets.** The `preset` command defaults to a 500k sats max-amount cap to prevent simulating dangerously large operations.

## Commands

### doctor

Check stxer simulation API health, latency, and session availability.

```bash
bun run defi-tx-simulator/defi-tx-simulator.ts doctor
```

Output:
```json
{
  "status": "success",
  "action": "doctor",
  "data": {
    "stxer_api": "healthy",
    "latency_ms": 142,
    "simulation_sessions": "available",
    "test_session_id": "abc123",
    "presets_available": 5,
    "known_error_codes": 12
  },
  "error": null
}
```

### run simulate

Simulate any Stacks contract call. Provide sender, contract, and Clarity code.

```bash
bun run defi-tx-simulator/defi-tx-simulator.ts run simulate \
  --sender SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE \
  --contract SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7 \
  --code "(supply SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0 SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3 SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token u10000 SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE)"
```

Success output:
```json
{
  "status": "success",
  "action": "simulate",
  "data": {
    "verdict": "SAFE_TO_BROADCAST",
    "contract": "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7",
    "result_decoded": "(ok true)",
    "recommendation": "Simulation succeeded. Proceed with broadcast."
  },
  "error": null
}
```

Failure output:
```json
{
  "status": "blocked",
  "action": "simulate",
  "data": {
    "verdict": "DO_NOT_BROADCAST",
    "raw_error": "(err u2)",
    "interpretation": "Insufficient balance",
    "recommendation": "Simulation failed. DO NOT broadcast this transaction."
  },
  "error": {
    "code": "SIM_FAILED",
    "message": "Insufficient balance",
    "next": "Fix the issue and re-simulate before broadcasting"
  }
}
```

### run presets

List available DeFi transaction presets with example Clarity code.

```bash
bun run defi-tx-simulator/defi-tx-simulator.ts run presets
```

### run preset

Simulate a preset DeFi operation with custom parameters.

```bash
bun run defi-tx-simulator/defi-tx-simulator.ts run preset \
  --name zest-supply \
  --sender SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE \
  --amount 50000
```

Options:
- `--name` (required) — Preset name: `zest-supply`, `zest-withdraw`, `zest-claim`, `bitflow-swap`, `sbtc-transfer`
- `--sender` (required) — Stacks address
- `--amount` — Override the default amount in the preset
- `--max-amount` — Safety cap (default: 500000). Refuses to simulate above this.

### run decode

Decode a Clarity hex value from a simulation result.

```bash
bun run defi-tx-simulator/defi-tx-simulator.ts run decode --hex 0801000000000000000000000000000003e8
```

### install-packs

Install the commander dependency.

```bash
bun run defi-tx-simulator/defi-tx-simulator.ts install-packs
```

## Output contract

All commands output JSON to stdout following the BFF extended format:

```json
{
  "status": "success | error | blocked",
  "action": "doctor | simulate | presets | preset-simulate | decode | install-packs",
  "data": {},
  "error": null | { "code": "...", "message": "...", "next": "..." }
}
```

- `status: "blocked"` means the simulation failed — do NOT broadcast.
- `status: "success"` with `verdict: "SAFE_TO_BROADCAST"` means proceed.
- `error.next` always contains a suggested next action.

## On-chain proof

Live simulation output against mainnet state (2026-03-29):

**Successful simulation** — reading our sBTC balance via stxer simulation:
```
$ npx tsx defi-tx-simulator.ts run simulate \
  --sender SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE \
  --contract SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token \
  --code "(get-balance 'SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE)"

→ verdict: SAFE_TO_BROADCAST
→ result_decoded: (some (ok u201410))   # our actual sBTC balance: 201,410 sats
→ session_id: 470225eff11e9488fbf3b666b4c9d12a
```

**Failed simulation** — catches wrong argument count BEFORE broadcast:
```
$ npx tsx defi-tx-simulator.ts run simulate \
  --sender SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE \
  --contract SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7 \
  --code "(supply 'SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0 ... u1000 ...)"

→ verdict: DO_NOT_BROADCAST
→ interpretation: Wrong argument count: expected 7, got 5
→ Gas saved: ~50k uSTX (avoided on-chain abort)
```

**Safety cap** — refuses to simulate amounts above the cap:
```
$ npx tsx defi-tx-simulator.ts run preset --name zest-supply --sender SP4... --amount 999999

→ status: error
→ message: Amount 999999 exceeds safety cap 500000
```

## Known constraints

- **Mainnet only.** stxer simulation reflects mainnet chain state. No testnet support.
- **No wallet required.** All operations are read-only simulations.
- **Simulation is point-in-time.** A passing simulation can still fail if chain state changes between simulation and broadcast (e.g., nonce race, oracle update). Minimize the gap.
- **Clarity hex decoder is basic.** Handles uint, int, bool, some, ok, err. Tuples and lists return raw hex. Use Hiro explorer for complex types.
- **Error code map covers common DeFi codes.** Unknown codes return the raw error — file an issue to add new ones.
- **stxer API has no SLA.** If stxer is down, doctor will report it. Fall back to manual verification.
- **Preset safety cap defaults to 500k sats.** Override with `--max-amount` for larger operations.
