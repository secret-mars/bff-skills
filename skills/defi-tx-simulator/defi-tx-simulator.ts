#!/usr/bin/env bun
/**
 * DeFi Transaction Simulator — Pre-broadcast safety gate for Stacks DeFi
 *
 * Commands: doctor | run | install-packs
 * Run actions: simulate | presets | decode
 *
 * Dry-runs any Stacks contract call via stxer simulation before broadcast.
 * Catches abort errors, insufficient balances, and bad args BEFORE spending gas.
 *
 * Built by Secret Mars — used in production every cycle as our pre-broadcast guard.
 * On-chain proof: We run this before every Zest supply, Bitflow swap, and sBTC transfer.
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const STXER_API = "https://api.stxer.xyz";
const FETCH_TIMEOUT_MS = 10_000;

// All preset example_code strings MUST use this address for the sender position.
// The `run preset` command replaces it with the actual --sender value.
const PRESET_SENDER_PLACEHOLDER = "SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE";

// Common DeFi contract addresses (mainnet)
// amount_position: index of the `uNNN` token to replace (0-based) when --amount is used
const PRESETS: Record<string, { contract: string; description: string; example: string; amount_position: number }> = {
  "zest-supply": {
    contract: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7",
    description: "Supply sBTC to Zest Protocol lending pool",
    example: `(supply 'SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0 'SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token u10000 '${PRESET_SENDER_PLACEHOLDER})`,
    amount_position: 0,
  },
  "zest-withdraw": {
    contract: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7",
    description: "Withdraw sBTC from Zest Protocol lending pool",
    example: `(withdraw 'SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0 'SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token u10000 '${PRESET_SENDER_PLACEHOLDER})`,
    amount_position: 0,
  },
  "zest-claim": {
    contract: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7",
    description: "Claim wSTX incentive rewards from Zest Protocol",
    example: `(claim-rewards 'SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token 'SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.wstx)`,
    amount_position: -1,
  },
  "bitflow-swap": {
    contract: "SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stableswap-stx-ststx-v-1-2",
    description: "Swap tokens on Bitflow DEX",
    example: `(swap-x-for-y '${PRESET_SENDER_PLACEHOLDER} u1000000 u990000)`,
    amount_position: 0,
  },
  "sbtc-transfer": {
    contract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    description: "Transfer sBTC to another address",
    example: `(transfer u10000 '${PRESET_SENDER_PLACEHOLDER} 'SP2AE98ED8GVVV0S6V9CHDVXD1EKSA204K7GHJQCZ none)`,
    amount_position: 0,
  },
};

// Known Clarity error codes → human-readable messages
const ERROR_CODES: Record<string, string> = {
  "u1": "Not authorized / permission denied",
  "u2": "Insufficient balance",
  "u3": "Amount too low / below minimum",
  "u4": "Transfer failed",
  "u5": "Invalid principal / address",
  "u100": "Pool not found",
  "u101": "Insufficient liquidity in pool",
  "u102": "Slippage exceeded",
  "u1000": "Oracle price stale / Pyth feed expired",
  "u3001": "Zero value not allowed",
  "u3002": "Already supplied to this pool",
  "u3200": "Borrow capacity exceeded",
};

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

// ── Helpers ────────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function errOut(action: string, code: string, message: string, next: string): void {
  out({ status: "error", action, data: {}, error: { code, message, next } });
}

async function checkStxerHealth(): Promise<{ ok: boolean; latency: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(`${STXER_API}/sidecar/v2/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stx: ["SP000000000000000000002Q6VF78.pox-4"] }),
    });
    const latency = Date.now() - start;
    if (!res.ok) return { ok: false, latency, error: `HTTP ${res.status}` };
    return { ok: true, latency };
  } catch (e: unknown) {
    return { ok: false, latency: Date.now() - start, error: (e as Error).message };
  }
}

async function createSimSession(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${STXER_API}/devtools/v2/simulations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skip_tracing: true }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Failed to create simulation session: HTTP ${res.status}`);
    const data = await res.json() as { id: string };
    return data.id;
  } finally {
    clearTimeout(timer);
  }
}

async function simulateCall(
  sessionId: string,
  sender: string,
  contract: string,
  code: string,
): Promise<{ ok: boolean; result: string; raw: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${STXER_API}/devtools/v2/simulations/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        steps: [{ Eval: [sender, "", contract, code] }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Simulation API error: HTTP ${res.status}`);
  const data = await res.json() as { steps: Array<{ Eval: { Ok?: string; Err?: string } }> };

  const step = data.steps?.[0]?.Eval;
  if (!step) throw new Error("Unexpected simulation response format");

  if (step.Ok !== undefined) {
    return { ok: true, result: step.Ok, raw: data };
  }
  return { ok: false, result: step.Err ?? "Unknown error", raw: data };
}

function interpretError(errStr: string): string {
  // Try to match (err uNNN) pattern
  const match = errStr.match(/\(err (u\d+)\)/);
  if (match) {
    const code = match[1];
    return ERROR_CODES[code] ?? `Unknown Clarity error code: ${code}`;
  }
  // Try to match runtime abort messages
  if (errStr.includes("NotEnoughBalance")) return "Insufficient STX balance for gas";
  if (errStr.includes("NoSuchContract")) return "Contract not found on mainnet";
  if (errStr.includes("UncheckedErrors")) return "Unhandled error in contract code";
  if (errStr.includes("BadFunctionArgType")) return "Wrong argument type passed to function";
  if (errStr.includes("ArityMismatch")) return "Wrong number of arguments";
  if (errStr.includes("IncorrectArgumentCount")) {
    const m = errStr.match(/IncorrectArgumentCount\((\d+),\s*(\d+)\)/);
    return m ? `Wrong argument count: expected ${m[1]}, got ${m[2]}` : "Wrong number of arguments";
  }
  if (errStr.includes("UnknownFunction")) return "Function not found in contract";
  if (errStr.includes("TraitReferenceUnknown")) return "Trait reference not found — check contract principal";
  if (errStr.includes("TypeError")) return "Type mismatch in function arguments";
  return errStr;
}

function decodeClarityHex(hex: string): string {
  // Basic Clarity value decoding for common types
  if (!hex || hex.length < 2) return hex;
  const prefix = hex.substring(0, 2);
  switch (prefix) {
    case "01": { // uint
      const val = BigInt("0x" + hex.substring(2));
      return `(ok u${val})`;
    }
    case "00": { // int
      const val = BigInt("0x" + hex.substring(2));
      return `(ok ${val})`;
    }
    case "03": // true
      return "(ok true)";
    case "04": // false
      return "(ok false)";
    case "07": { // optional some
      const inner = decodeClarityHex(hex.substring(2));
      return `(some ${inner})`;
    }
    case "08": // response ok
      return `(ok ${decodeClarityHex(hex.substring(2))})`;
    case "09": // response err
      return `(err ${decodeClarityHex(hex.substring(2))})`;
    default:
      return `0x${hex}`;
  }
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("defi-tx-simulator")
  .description("Pre-broadcast safety gate — dry-run Stacks DeFi transactions via stxer simulation");

// ── doctor ─────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check stxer simulation API health and readiness")
  .action(async () => {
    const health = await checkStxerHealth();
    if (!health.ok) {
      errOut("doctor", "STXER_DOWN", `stxer API unreachable: ${health.error}`, "Retry later or check https://api.stxer.xyz status");
      return;
    }

    // Try creating a test session
    try {
      const sessionId = await createSimSession();
      out({
        status: "success",
        action: "doctor",
        data: {
          stxer_api: "healthy",
          latency_ms: health.latency,
          simulation_sessions: "available",
          test_session_id: sessionId,
          presets_available: Object.keys(PRESETS).length,
          known_error_codes: Object.keys(ERROR_CODES).length,
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("doctor", "SESSION_FAIL", `API healthy but session creation failed: ${(e as Error).message}`, "Check stxer devtools API status");
    }
  });

// ── run ────────────────────────────────────────────────────────────────

const runCmd = program
  .command("run")
  .description("Simulate a contract call or list presets");

runCmd
  .command("simulate")
  .description("Dry-run a Stacks contract call before broadcasting")
  .requiredOption("--sender <address>", "Stacks address of the transaction sender")
  .requiredOption("--contract <principal>", "Contract to call (e.g. SP2VCQ...pool-borrow-v2-3)")
  .requiredOption("--code <clarity>", "Clarity expression to evaluate (e.g. '(supply ...args)')")
  .action(async (opts: { sender: string; contract: string; code: string }) => {
    // Validate sender format
    if (!opts.sender.startsWith("SP") && !opts.sender.startsWith("SM")) {
      errOut("simulate", "BAD_SENDER", "Sender must be a mainnet Stacks address (SP... or SM...)", "Use a valid mainnet address");
      return;
    }

    // Validate contract format
    if (!opts.contract.includes(".")) {
      errOut("simulate", "BAD_CONTRACT", "Contract must be in principal.contract-name format", "Example: SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3");
      return;
    }

    try {
      const sessionId = await createSimSession();
      const result = await simulateCall(sessionId, opts.sender, opts.contract, opts.code);

      if (result.ok) {
        const decoded = decodeClarityHex(result.result);
        out({
          status: "success",
          action: "simulate",
          data: {
            verdict: "SAFE_TO_BROADCAST",
            session_id: sessionId,
            sender: opts.sender,
            contract: opts.contract,
            code: opts.code,
            result_hex: result.result,
            result_decoded: decoded,
            recommendation: "Simulation succeeded. Proceed with broadcast.",
          },
          error: null,
        });
      } else {
        const interpretation = interpretError(result.result);
        out({
          status: "blocked",
          action: "simulate",
          data: {
            verdict: "DO_NOT_BROADCAST",
            session_id: sessionId,
            sender: opts.sender,
            contract: opts.contract,
            code: opts.code,
            raw_error: result.result,
            interpretation,
            recommendation: "Simulation failed. DO NOT broadcast this transaction.",
          },
          error: {
            code: "SIM_FAILED",
            message: interpretation,
            next: "Fix the issue and re-simulate before broadcasting",
          },
        });
      }
    } catch (e: unknown) {
      errOut("simulate", "SIM_ERROR", (e as Error).message, "Check contract address and Clarity syntax");
    }
  });

runCmd
  .command("presets")
  .description("List available DeFi transaction presets")
  .action(() => {
    const presetList = Object.entries(PRESETS).map(([name, p]) => ({
      name,
      contract: p.contract,
      description: p.description,
      example_code: p.example,
    }));
    out({
      status: "success",
      action: "presets",
      data: {
        count: presetList.length,
        presets: presetList,
        usage: "Use --contract and --code from a preset with 'run simulate'",
      },
      error: null,
    });
  });

runCmd
  .command("preset")
  .description("Simulate a preset DeFi operation with custom parameters")
  .requiredOption("--name <preset>", "Preset name (e.g. zest-supply, bitflow-swap)")
  .requiredOption("--sender <address>", "Stacks address of the sender")
  .option("--amount <sats>", "Override amount in the preset (in smallest unit)")
  .option("--max-amount <sats>", "Safety cap: refuse to simulate above this amount", "500000")
  .action(async (opts: { name: string; sender: string; amount?: string; maxAmount: string }) => {
    const preset = PRESETS[opts.name];
    if (!preset) {
      errOut("preset-simulate", "BAD_PRESET", `Unknown preset: ${opts.name}`, `Available presets: ${Object.keys(PRESETS).join(", ")}`);
      return;
    }

    let code = preset.example;

    // Replace amount if provided
    if (opts.amount) {
      const amount = parseInt(opts.amount, 10);
      const maxAmount = parseInt(opts.maxAmount, 10);
      if (isNaN(amount) || amount <= 0) {
        errOut("preset-simulate", "BAD_AMOUNT", "Amount must be a positive integer", "Provide amount in smallest unit (sats for sBTC, uSTX for STX)");
        return;
      }
      if (amount > maxAmount) {
        errOut("preset-simulate", "OVER_CAP", `Amount ${amount} exceeds safety cap ${maxAmount}`, `Increase --max-amount or reduce amount`);
        return;
      }
      // Replace the uNNNN at the preset's declared amount_position
      if (preset.amount_position < 0) {
        errOut("preset-simulate", "NO_AMOUNT", `Preset ${opts.name} has no amount parameter`, "Use 'run simulate' for custom calls");
        return;
      }
      let matchIndex = 0;
      code = code.replace(/u\d+/g, (match) => {
        if (matchIndex++ === preset.amount_position) return `u${amount}`;
        return match;
      });
    }

    // Replace the placeholder sender address with the actual sender
    const senderRegex = new RegExp(`'${PRESET_SENDER_PLACEHOLDER}`, "g");
    code = code.replace(senderRegex, `'${opts.sender}`);

    try {
      const sessionId = await createSimSession();
      const result = await simulateCall(sessionId, opts.sender, preset.contract, code);

      if (result.ok) {
        const decoded = decodeClarityHex(result.result);
        out({
          status: "success",
          action: "preset-simulate",
          data: {
            verdict: "SAFE_TO_BROADCAST",
            preset: opts.name,
            session_id: sessionId,
            sender: opts.sender,
            contract: preset.contract,
            code,
            result_hex: result.result,
            result_decoded: decoded,
            recommendation: "Simulation succeeded. Proceed with broadcast.",
          },
          error: null,
        });
      } else {
        const interpretation = interpretError(result.result);
        out({
          status: "blocked",
          action: "preset-simulate",
          data: {
            verdict: "DO_NOT_BROADCAST",
            preset: opts.name,
            session_id: sessionId,
            sender: opts.sender,
            contract: preset.contract,
            code,
            raw_error: result.result,
            interpretation,
          },
          error: {
            code: "SIM_FAILED",
            message: interpretation,
            next: "Fix the issue and re-simulate before broadcasting",
          },
        });
      }
    } catch (e: unknown) {
      errOut("preset-simulate", "SIM_ERROR", (e as Error).message, "Check preset parameters");
    }
  });

runCmd
  .command("decode")
  .description("Decode a Clarity hex value to human-readable form")
  .requiredOption("--hex <value>", "Clarity hex value (from simulation result)")
  .action((opts: { hex: string }) => {
    const hex = opts.hex.startsWith("0x") ? opts.hex.substring(2) : opts.hex;
    const decoded = decodeClarityHex(hex);
    out({
      status: "success",
      action: "decode",
      data: { input: opts.hex, decoded },
      error: null,
    });
  });

// ── install-packs ──────────────────────────────────────────────────────

program
  .command("install-packs")
  .description("Install dependencies (commander only)")
  .action(() => {
    try {
      const result = Bun.spawnSync(["bun", "add", "commander"], { stdio: ["pipe", "pipe", "pipe"] });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      out({
        status: "success",
        action: "install-packs",
        data: { installed: ["commander"] },
        error: null,
      });
    } catch (e: unknown) {
      errOut("install-packs", "INSTALL_FAIL", (e as Error).message, "Run 'bun add commander' manually");
    }
  });

program.parse();
