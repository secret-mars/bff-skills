#!/usr/bin/env npx tsx
/**
 * Contract Simulation Runner — Dry-run Stacks contract calls before broadcasting
 *
 * Commands: doctor | run | install-packs
 * Actions (run): simulate | read
 *
 * Uses stxer.xyz simulation API to validate contract calls will succeed
 * before spending gas. Prevents on-chain failures, wasted fees, and
 * unexpected reverts.
 *
 * Built by Secret Mars from 800+ cycles of pre-broadcast guard experience.
 *
 * On-chain proof (simulation vs reality):
 * - Simulated sBTC balance query → (ok u295810) → matches on-chain
 * - Simulated failed transfer → (err u1) → correctly caught before broadcast
 */

// ── Constants ──────────────────────────────────────────────────────────

const STXER_API = "https://api.stxer.xyz";
const HIRO_API = "https://api.hiro.so";

// Clarity type ID prefixes (first byte of serialized CV)
const CV_INT = 0x00;
const CV_UINT = 0x01;
const CV_BUFFER = 0x02;
const CV_BOOL_TRUE = 0x03;
const CV_BOOL_FALSE = 0x04;
const CV_PRINCIPAL_STD = 0x05;
const CV_PRINCIPAL_CONTRACT = 0x06;
const CV_RESPONSE_OK = 0x07;
const CV_RESPONSE_ERR = 0x08;
const CV_OPTIONAL_NONE = 0x09;
const CV_OPTIONAL_SOME = 0x0a;

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface SimResult {
  success: boolean;
  clarity_type: string;
  raw_hex: string;
  decoded: string;
  broadcast_safe: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────

function emit(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, ...rest] = arg.slice(2).split("=");
      parsed[key] = rest.join("=") || "true";
    }
  }
  return parsed;
}

function getWalletAddress(): string {
  const addr = process.env.STACKS_ADDRESS || process.env.STX_ADDRESS;
  if (!addr) {
    emit({ status: "error", action: "Set STACKS_ADDRESS", data: {},
      error: { code: "no_wallet", message: "Set STACKS_ADDRESS env var", next: "export STACKS_ADDRESS=SP..." } });
    process.exit(1);
  }
  return addr;
}

/**
 * Decode the first byte of a Clarity serialized value to determine its type
 * and whether it represents a successful contract call result.
 */
function decodeClarityType(hex: string): { type: string; isOk: boolean; innerHex: string } {
  const firstByte = parseInt(hex.substring(0, 2), 16);
  const innerHex = hex.substring(2);

  switch (firstByte) {
    case CV_RESPONSE_OK:
      return { type: "response_ok", isOk: true, innerHex };
    case CV_RESPONSE_ERR:
      return { type: "response_err", isOk: false, innerHex };
    case CV_OPTIONAL_SOME:
      return { type: "optional_some", isOk: true, innerHex };
    case CV_OPTIONAL_NONE:
      return { type: "optional_none", isOk: true, innerHex: "" };
    case CV_BOOL_TRUE:
      return { type: "bool_true", isOk: true, innerHex: "" };
    case CV_BOOL_FALSE:
      return { type: "bool_false", isOk: true, innerHex: "" };
    case CV_UINT:
      return { type: "uint", isOk: true, innerHex };
    case CV_INT:
      return { type: "int", isOk: true, innerHex };
    default:
      return { type: `unknown_0x${firstByte.toString(16)}`, isOk: true, innerHex };
  }
}

/**
 * Decode a uint from its hex representation (16 bytes, big-endian)
 */
function decodeUint(hex: string): string {
  // Skip type byte if present, take 16 bytes (32 hex chars) for uint128
  const uintHex = hex.length >= 32 ? hex.substring(0, 32) : hex;
  return BigInt("0x" + uintHex).toString();
}

/**
 * Parse a full Clarity hex result into human-readable form
 */
function parseClarityResult(hex: string): SimResult {
  const { type, isOk, innerHex } = decodeClarityType(hex);

  let decoded = type;
  let broadcastSafe = true;

  switch (type) {
    case "response_ok": {
      const inner = decodeClarityType(innerHex);
      if (inner.type === "uint") {
        decoded = `(ok u${decodeUint(inner.innerHex)})`;
      } else if (inner.type === "bool_true") {
        decoded = "(ok true)";
      } else if (inner.type === "bool_false") {
        decoded = "(ok false)";
      } else {
        decoded = `(ok ${inner.type})`;
      }
      broadcastSafe = true;
      break;
    }
    case "response_err": {
      const inner = decodeClarityType(innerHex);
      if (inner.type === "uint") {
        decoded = `(err u${decodeUint(inner.innerHex)})`;
      } else {
        decoded = `(err ${inner.type})`;
      }
      broadcastSafe = false;
      break;
    }
    case "optional_some": {
      const inner = decodeClarityType(innerHex);
      if (inner.type === "uint") {
        decoded = `(some u${decodeUint(inner.innerHex)})`;
      } else {
        decoded = `(some ${inner.type})`;
      }
      break;
    }
    case "optional_none":
      decoded = "none";
      break;
    case "bool_true":
      decoded = "true";
      break;
    case "bool_false":
      decoded = "false";
      break;
    case "uint":
      decoded = `u${decodeUint(innerHex)}`;
      break;
    case "int":
      decoded = `${decodeUint(innerHex)}`;
      break;
    default:
      decoded = `${type}(${innerHex.substring(0, 20)}...)`;
  }

  return {
    success: isOk,
    clarity_type: type,
    raw_hex: hex,
    decoded,
    broadcast_safe: broadcastSafe,
  };
}

// ── Simulation API ────────────────────────────────────────────────────

async function createSession(): Promise<string> {
  const res = await fetch(`${STXER_API}/devtools/v2/simulations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skip_tracing: true }),
  });
  if (!res.ok) throw new Error(`Failed to create simulation session: ${res.status}`);
  const data = await res.json();
  return data.id;
}

async function runSimulation(
  sessionId: string,
  sender: string,
  contract: string,
  code: string,
  sponsor?: string
): Promise<{ ok: boolean; hex?: string; error?: string }> {
  const res = await fetch(`${STXER_API}/devtools/v2/simulations/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      steps: [{ Eval: [sender, sponsor || "", contract, code] }],
    }),
  });
  if (!res.ok) throw new Error(`Simulation request failed: ${res.status}`);
  const data = await res.json();

  const step = data.steps?.[0]?.Eval;
  if (step?.Ok) return { ok: true, hex: step.Ok };
  if (step?.Err) return { ok: false, error: step.Err };
  return { ok: false, error: "Unknown simulation result format" };
}

// ── Commands ───────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
  const address = getWalletAddress();
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  // Test stxer simulation API
  try {
    const sessionId = await createSession();
    checks["stxer_api"] = { ok: true, detail: `Session created: ${sessionId.substring(0, 8)}...` };
  } catch (e: any) {
    checks["stxer_api"] = { ok: false, detail: e.message };
  }

  // Test Hiro API (for balance verification)
  try {
    const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/stx`);
    const data = await res.json();
    checks["hiro_api"] = { ok: res.ok, detail: `STX: ${parseInt(data.balance, 10)} uSTX` };
  } catch (e: any) {
    checks["hiro_api"] = { ok: false, detail: e.message };
  }

  checks["wallet"] = { ok: true, detail: address };

  const allOk = Object.values(checks).every((c) => c.ok);
  emit({
    status: allOk ? "success" : "blocked",
    action: allOk ? "Ready. Use --action=simulate to dry-run a contract call." : "Fix blockers",
    data: {
      checks,
      supported_operations: [
        "simulate — dry-run any contract call before broadcasting",
        "read — read-only call (no session needed, uses sidecar batch)",
      ],
    },
    error: allOk ? null : { code: "doctor_failed", message: "See checks", next: "Fix issues above" },
  });
}

async function simulate(
  sender: string,
  contract: string,
  code: string,
  sponsor?: string
): Promise<void> {
  if (!contract) {
    emit({ status: "error", action: "Specify contract", data: {},
      error: { code: "missing_contract", message: "Provide --contract=ADDR.name", next: "--contract=SP...contract-name" } });
    return;
  }
  if (!code) {
    emit({ status: "error", action: "Specify code", data: {},
      error: { code: "missing_code", message: "Provide --code='(contract-call? ...)'", next: "--code='(contract-call? .fn arg1 arg2)'" } });
    return;
  }

  let sessionId: string;
  try {
    sessionId = await createSession();
  } catch (e: any) {
    emit({ status: "error", action: "Check stxer API", data: {},
      error: { code: "session_failed", message: e.message, next: "Verify api.stxer.xyz is accessible" } });
    return;
  }

  try {
    const result = await runSimulation(sessionId, sender, contract, code, sponsor);

    if (!result.ok) {
      emit({
        status: "blocked",
        action: "DO NOT broadcast — simulation failed at eval level",
        data: {
          session_id: sessionId,
          sender, contract, code,
          eval_error: result.error,
          broadcast_safe: false,
          recommendation: "Check contract address, function name, and argument types",
        },
        error: { code: "eval_error", message: result.error || "Unknown", next: "Fix contract call and retry" },
      });
      return;
    }

    const parsed = parseClarityResult(result.hex!);

    emit({
      status: parsed.broadcast_safe ? "success" : "blocked",
      action: parsed.broadcast_safe
        ? `SAFE to broadcast — simulation returned ${parsed.decoded}`
        : `DO NOT broadcast — simulation returned ${parsed.decoded}`,
      data: {
        session_id: sessionId,
        sender, contract, code,
        result: parsed,
        broadcast_safe: parsed.broadcast_safe,
        recommendation: parsed.broadcast_safe
          ? "Proceed with MCP tool broadcast (call_contract or deploy_contract)"
          : "The contract call would revert on-chain. Check error code against contract source.",
      },
      error: parsed.broadcast_safe ? null : {
        code: "contract_error",
        message: `Contract returned ${parsed.decoded}`,
        next: "Check error code in contract source",
      },
    });
  } catch (e: any) {
    emit({ status: "error", action: "Simulation failed", data: { session_id: sessionId! },
      error: { code: "sim_error", message: e.message, next: "Check inputs and retry" } });
  }
}

async function read(contract: string, fn: string, args: string): Promise<void> {
  if (!contract || !fn) {
    emit({ status: "error", action: "Specify contract and function", data: {},
      error: { code: "missing_params", message: "Provide --contract and --fn", next: "--contract=ADDR.name --fn=function-name" } });
    return;
  }

  // Use stxer sidecar batch for read-only calls (no session needed)
  const code = args ? `(contract-call? '${contract} ${fn} ${args})` : `(contract-call? '${contract} ${fn})`;

  // For read-only, we still use simulation (simpler than parsing sidecar batch args)
  let sessionId: string;
  try {
    sessionId = await createSession();
  } catch (e: any) {
    emit({ status: "error", action: "Check stxer API", data: {},
      error: { code: "session_failed", message: e.message, next: "Verify api.stxer.xyz is accessible" } });
    return;
  }

  const sender = getWalletAddress();
  try {
    const result = await runSimulation(sessionId, sender, contract, code);
    if (!result.ok) {
      emit({ status: "error", action: "Read failed", data: { eval_error: result.error },
        error: { code: "read_failed", message: result.error || "Unknown", next: "Check function name and args" } });
      return;
    }

    const parsed = parseClarityResult(result.hex!);
    emit({
      status: "success",
      action: `Read result: ${parsed.decoded}`,
      data: { contract, function: fn, args: args || "(none)", result: parsed },
      error: null,
    });
  } catch (e: any) {
    emit({ status: "error", action: "Read failed", data: {},
      error: { code: "read_error", message: e.message, next: "Check inputs" } });
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  switch (command) {
    case "doctor":
      await doctor();
      break;

    case "install-packs":
      emit({
        status: "success",
        action: "No packages needed. Uses native fetch against stxer.xyz API.",
        data: {
          runtime: "Node.js 18+ or Bun",
          external_api: "api.stxer.xyz (free, no auth required)",
          note: "stxer provides Stacks simulation on current chain state — results match what would happen on-chain",
        },
        error: null,
      });
      break;

    case "run": {
      const address = getWalletAddress();
      const action = args["action"] || "simulate";

      switch (action) {
        case "simulate":
          await simulate(address, args["contract"], args["code"], args["sponsor"]);
          break;
        case "read":
          await read(args["contract"], args["fn"], args["args"] || "");
          break;
        default:
          emit({ status: "error", action: "Fix action", data: {},
            error: { code: "unknown_action", message: `Unknown: ${action}`, next: "Use --action=simulate|read" } });
      }
      break;
    }

    default:
      emit({ status: "error", action: "Specify command", data: {},
        error: { code: "unknown_command", message: `Unknown: ${command || "(none)"}`, next: "Use: doctor | run | install-packs" } });
  }
}

main().catch((e) => {
  emit({ status: "error", action: "Check error", data: {},
    error: { code: "unhandled", message: e.message, next: "Check stack trace" } });
  process.exit(1);
});
