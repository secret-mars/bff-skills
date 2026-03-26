---
name: contract-simulator
version: 1.0.0
description: Dry-run Stacks contract calls before broadcasting to prevent on-chain failures
author: Secret Mars
agent_address: SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE
tags: [defi, safety, simulation, stacks, smart-contracts]
commands: [doctor, run, install-packs]
actions: [simulate, read]
network: mainnet
---

# Contract Simulation Runner

Dry-runs any Stacks contract call against live chain state before you spend gas. Returns a clear go/no-go decision: `broadcast_safe: true` means proceed, `broadcast_safe: false` means the call would revert on-chain.

## Why this exists

Agents making autonomous DeFi transactions face a real problem: a contract call that looks correct can still fail on-chain due to insufficient balance, expired approvals, changed pool state, or parameter mismatches. Each failed transaction wastes gas and creates noise. Over 800+ autonomous cycles, we learned that simulating every contract call before broadcast eliminates these failures entirely.

This skill wraps the [stxer.xyz](https://api.stxer.xyz) simulation API — a free service that evaluates Clarity code against the current Stacks chain state without broadcasting. The simulation returns the exact Clarity value the contract would return, which this skill parses into a human-readable go/no-go decision.

## Commands

### `doctor`
Checks stxer API connectivity, Hiro API for balance verification, and wallet configuration.

### `run --action=simulate --contract=ADDR.name --code='(contract-call? ...)'`
Creates a simulation session, evaluates the Clarity code as the wallet address, and parses the result:
- `response_ok` (0x07 prefix) → `broadcast_safe: true` — proceed with on-chain broadcast
- `response_err` (0x08 prefix) → `broadcast_safe: false` — DO NOT broadcast, check error code
- Eval-level errors (malformed call, wrong contract) → `broadcast_safe: false` with diagnostic

Optional `--sponsor=ADDR` for sponsored transaction simulation.

### `run --action=read --contract=ADDR.name --fn=function-name --args='arg1 arg2'`
Read-only contract call via simulation. Returns the decoded Clarity value.

### `install-packs`
No packages needed — uses native fetch against stxer.xyz (free, no auth required).

## Output Contract

```json
{
  "status": "success | error | blocked",
  "action": "SAFE to broadcast — simulation returned (ok u295810)",
  "data": {
    "session_id": "e03c10cb...",
    "sender": "SP4DXVEC...",
    "contract": "SM3VDX...sbtc-token",
    "code": "(contract-call? .sbtc-token get-balance tx-sender)",
    "result": {
      "success": true,
      "clarity_type": "response_ok",
      "raw_hex": "070100000000000000000000000000048382",
      "decoded": "(ok u295810)",
      "broadcast_safe": true
    },
    "broadcast_safe": true,
    "recommendation": "Proceed with MCP tool broadcast"
  },
  "error": null
}
```

## Clarity Type Decoding

The skill decodes serialized Clarity values (hex) into human-readable form:

| Prefix | Type | Meaning | Broadcast? |
|--------|------|---------|-----------|
| `0x07` | response_ok | Contract call succeeded | Yes |
| `0x08` | response_err | Contract call would revert | **No** |
| `0x09` | optional_none | No value | Context-dependent |
| `0x0a` | optional_some | Value present | Context-dependent |
| `0x01` | uint | Unsigned integer | Context-dependent |
| `0x03` | bool_true | Boolean true | Context-dependent |

## On-Chain Proof

These simulations were run against live mainnet state and verified against actual on-chain values:

| Test | Code | Simulation Result | On-Chain Match |
|------|------|-------------------|---------------|
| Balance query | `(contract-call? .sbtc-token get-balance tx-sender)` | `(ok u295810)` | Verified: 295,810 sats sBTC |
| Failed transfer | `(contract-call? .sbtc-token transfer u99999999 ...)` | `(err u1)` | Correctly blocked (insufficient balance) |

The balance returned by simulation exactly matches the on-chain sBTC balance queried via Hiro API, proving simulation fidelity.

## Safety Notes

- **No gas spent.** Simulation runs off-chain on stxer infrastructure. Zero cost.
- **Current state.** Simulates against the latest confirmed block. Results reflect actual chain state.
- **Not a guarantee.** State can change between simulation and broadcast (MEV, competing txs). For time-sensitive operations, minimize the gap.
- **Free API.** stxer.xyz requires no API key. Rate limits apply but are generous for agent use.
