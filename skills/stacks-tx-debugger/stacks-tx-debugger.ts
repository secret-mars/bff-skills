#!/usr/bin/env bun
/**
 * Stacks Transaction Debugger — Post-mortem analysis for failed Stacks transactions
 *
 * Commands: doctor | run | install-packs
 * Run actions: diagnose | trace | lookup
 *
 * Given a txid, fetches execution details from Hiro API and stxer,
 * classifies the failure, and suggests recovery actions.
 *
 * Built by Secret Mars — used in production for debugging aborted Zest supplies,
 * Bitflow swaps, and sBTC transfers.
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const HIRO_API = "https://api.hiro.so";
const STXER_API = "https://api.stxer.xyz";
const FETCH_TIMEOUT_MS = 15_000;

// Known abort codes → human-readable diagnosis + recovery action
const ABORT_CODES: Record<string, { diagnosis: string; action: string }> = {
  "u1": { diagnosis: "Not authorized / permission denied", action: "Check sender has required role or trait" },
  "u2": { diagnosis: "Insufficient balance", action: "Check token balance before calling" },
  "u3": { diagnosis: "Amount too low / below minimum", action: "Increase amount above protocol minimum" },
  "u4": { diagnosis: "Transfer failed", action: "Verify recipient address and token contract" },
  "u5": { diagnosis: "Invalid principal / address", action: "Verify address format (SP for mainnet)" },
  "u100": { diagnosis: "Pool not found", action: "Check pool contract address exists on-chain" },
  "u101": { diagnosis: "Insufficient liquidity in pool", action: "Reduce amount or wait for more liquidity" },
  "u102": { diagnosis: "Slippage exceeded", action: "Increase slippage tolerance or reduce amount" },
  "u1000": { diagnosis: "Oracle price stale / Pyth feed expired", action: "Retry — Pyth feeds refresh every ~30s" },
  "u3001": { diagnosis: "Zero value not allowed", action: "Supply a non-zero amount" },
  "u3002": { diagnosis: "Already supplied to this pool", action: "Use add-to-position instead of initial supply" },
  "u3200": { diagnosis: "Borrow capacity exceeded", action: "Supply more collateral or reduce borrow amount" },
  "u30000": { diagnosis: "Zest borrow helper error (generic)", action: "Check collateral enabled and position health" },
};

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface TxInfo {
  tx_id: string;
  tx_status: string;
  tx_type: string;
  block_height?: number;
  burn_block_time_iso?: string;
  sender_address?: string;
  fee_rate?: string;
  nonce?: number;
  contract_call?: {
    contract_id: string;
    function_name: string;
    function_args?: Array<{ repr: string; name: string; type: string }>;
  };
  tx_result?: { repr: string; hex: string };
  event_count?: number;
  events?: Array<Record<string, unknown>>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function errOut(action: string, code: string, message: string, next: string): void {
  out({ status: "error", action, data: {}, error: { code, message, next } });
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyAbortCode(repr: string): { code: string; diagnosis: string; action: string } | null {
  // Match (err uNNN) pattern
  const match = repr.match(/\(err\s+u(\d+)\)/);
  if (!match) return null;
  const code = `u${match[1]}`;
  const known = ABORT_CODES[code];
  if (known) return { code, ...known };
  return { code, diagnosis: `Unknown abort code: ${code}`, action: "Check contract source for error definition" };
}

function classifyTxFailure(tx: TxInfo): {
  category: string;
  diagnosis: string;
  action: string;
  details: Record<string, unknown>;
} {
  const result = tx.tx_result?.repr ?? "";

  // Abort with error code
  const abortInfo = classifyAbortCode(result);
  if (abortInfo) {
    return {
      category: "contract_abort",
      diagnosis: abortInfo.diagnosis,
      action: abortInfo.action,
      details: { abort_code: abortInfo.code, raw_result: result },
    };
  }

  // Runtime errors
  if (result.includes("NoSuchContract")) {
    return {
      category: "runtime_error",
      diagnosis: "Contract not found on-chain",
      action: "Verify contract principal is deployed on mainnet",
      details: { raw_result: result },
    };
  }
  if (result.includes("NotEnoughBalance")) {
    return {
      category: "runtime_error",
      diagnosis: "Insufficient STX for gas fee",
      action: "Fund sender with STX for transaction fees",
      details: { raw_result: result, fee_rate: tx.fee_rate },
    };
  }
  if (result.includes("BadFunctionArgType") || result.includes("TypeError")) {
    return {
      category: "runtime_error",
      diagnosis: "Type mismatch in function arguments",
      action: "Check argument types match contract function signature",
      details: { raw_result: result },
    };
  }
  if (result.includes("ArityMismatch") || result.includes("IncorrectArgumentCount")) {
    return {
      category: "runtime_error",
      diagnosis: "Wrong number of arguments",
      action: "Check function signature for correct argument count",
      details: { raw_result: result },
    };
  }
  if (result.includes("UnknownFunction")) {
    return {
      category: "runtime_error",
      diagnosis: "Function not found in contract",
      action: "Verify function name and contract version",
      details: { raw_result: result },
    };
  }
  if (result.includes("TraitReferenceUnknown")) {
    return {
      category: "runtime_error",
      diagnosis: "Trait reference not found — check contract principal",
      action: "Verify trait contract is deployed and matches expected interface",
      details: { raw_result: result },
    };
  }

  // Nonce issues (from tx_status)
  if (tx.tx_status === "abort_by_response") {
    return {
      category: "contract_abort",
      diagnosis: "Transaction aborted by contract logic",
      action: "Simulate the call via stxer to identify the specific abort condition",
      details: { raw_result: result, tx_status: tx.tx_status },
    };
  }

  // Generic failure
  return {
    category: "unknown",
    diagnosis: `Transaction failed with status: ${tx.tx_status}`,
    action: "Inspect raw transaction result and events for details",
    details: { raw_result: result, tx_status: tx.tx_status },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("stacks-tx-debugger")
  .description("Post-mortem analysis for failed Stacks transactions — diagnosis + recovery actions");

// ── doctor ─────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check Hiro API and stxer availability")
  .action(async () => {
    const checks: Record<string, { ok: boolean; latency: number; error?: string }> = {};

    for (const [name, url] of [
      ["hiro", `${HIRO_API}/extended/v1/status`],
      ["stxer", `${STXER_API}/sidecar/v2/batch`],
    ]) {
      const start = Date.now();
      try {
        const res = await fetchWithTimeout(url, {
          method: name === "stxer" ? "POST" : "GET",
          headers: { "Content-Type": "application/json" },
          ...(name === "stxer" ? { body: JSON.stringify({ stx: ["SP000000000000000000002Q6VF78.pox-4"] }) } : {}),
        });
        checks[name] = { ok: res.ok, latency: Date.now() - start };
      } catch (e: unknown) {
        checks[name] = { ok: false, latency: Date.now() - start, error: (e as Error).message };
      }
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    if (!allOk) {
      errOut("doctor", "API_DOWN", `One or more APIs unreachable: ${JSON.stringify(checks)}`, "Retry later");
      return;
    }

    out({
      status: "success",
      action: "doctor",
      data: {
        hiro_api: checks.hiro,
        stxer_api: checks.stxer,
        known_abort_codes: Object.keys(ABORT_CODES).length,
        capabilities: ["diagnose (txid analysis)", "trace (stxer execution trace)", "lookup (quick status check)"],
      },
      error: null,
    });
  });

// ── run ────────────────────────────────────────────────────────────────

const runCmd = program.command("run").description("Debug a Stacks transaction");

runCmd
  .command("diagnose")
  .description("Full post-mortem: fetch tx, classify failure, suggest recovery")
  .requiredOption("--txid <hash>", "Transaction ID (0x... or bare hex)")
  .action(async (opts: { txid: string }) => {
    const txid = opts.txid.startsWith("0x") ? opts.txid : `0x${opts.txid}`;

    try {
      const res = await fetchWithTimeout(`${HIRO_API}/extended/v1/tx/${txid}`);
      if (!res.ok) {
        if (res.status === 404) {
          errOut("diagnose", "TX_NOT_FOUND", `Transaction ${txid} not found on Hiro`, "Verify txid and check mempool");
          return;
        }
        errOut("diagnose", "HIRO_ERROR", `Hiro API returned ${res.status}`, "Retry later");
        return;
      }

      const tx = (await res.json()) as TxInfo;

      // Success case
      if (tx.tx_status === "success") {
        out({
          status: "success",
          action: "diagnose",
          data: {
            txid,
            verdict: "TX_SUCCEEDED",
            block_height: tx.block_height,
            timestamp: tx.burn_block_time_iso,
            sender: tx.sender_address,
            contract: tx.contract_call?.contract_id,
            function: tx.contract_call?.function_name,
            result: tx.tx_result?.repr,
            event_count: tx.event_count,
            note: "This transaction succeeded. No debugging needed.",
          },
          error: null,
        });
        return;
      }

      // Pending case
      if (tx.tx_status === "pending") {
        out({
          status: "success",
          action: "diagnose",
          data: {
            txid,
            verdict: "TX_PENDING",
            sender: tx.sender_address,
            nonce: tx.nonce,
            fee: tx.fee_rate,
            contract: tx.contract_call?.contract_id,
            function: tx.contract_call?.function_name,
            note: "Transaction is still in mempool. Wait for confirmation or check for nonce conflicts.",
          },
          error: null,
        });
        return;
      }

      // Failure case — classify
      const classification = classifyTxFailure(tx);

      out({
        status: "blocked",
        action: "diagnose",
        data: {
          txid,
          verdict: "TX_FAILED",
          category: classification.category,
          diagnosis: classification.diagnosis,
          recovery_action: classification.action,
          tx_status: tx.tx_status,
          block_height: tx.block_height,
          timestamp: tx.burn_block_time_iso,
          sender: tx.sender_address,
          nonce: tx.nonce,
          fee: tx.fee_rate,
          contract: tx.contract_call?.contract_id,
          function: tx.contract_call?.function_name,
          args: tx.contract_call?.function_args?.map((a) => `${a.name}: ${a.repr}`),
          raw_result: tx.tx_result?.repr,
          ...classification.details,
        },
        error: {
          code: classification.category.toUpperCase(),
          message: classification.diagnosis,
          next: classification.action,
        },
      });
    } catch (e: unknown) {
      errOut("diagnose", "FETCH_ERROR", (e as Error).message, "Check network and txid format");
    }
  });

runCmd
  .command("lookup")
  .description("Quick status check — is this tx confirmed, pending, or failed?")
  .requiredOption("--txid <hash>", "Transaction ID")
  .action(async (opts: { txid: string }) => {
    const txid = opts.txid.startsWith("0x") ? opts.txid : `0x${opts.txid}`;

    try {
      const res = await fetchWithTimeout(`${HIRO_API}/extended/v1/tx/${txid}`);
      if (!res.ok) {
        errOut("lookup", "TX_NOT_FOUND", `Transaction ${txid} not found`, "Verify txid");
        return;
      }

      const tx = (await res.json()) as TxInfo;
      out({
        status: "success",
        action: "lookup",
        data: {
          txid,
          tx_status: tx.tx_status,
          block_height: tx.block_height,
          sender: tx.sender_address,
          contract: tx.contract_call?.contract_id,
          function: tx.contract_call?.function_name,
          result: tx.tx_result?.repr,
          explorer: `https://explorer.hiro.so/txid/${txid}?chain=mainnet`,
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("lookup", "FETCH_ERROR", (e as Error).message, "Check network");
    }
  });

runCmd
  .command("trace")
  .description("Get execution trace from stxer for deep debugging")
  .requiredOption("--txid <hash>", "Transaction ID")
  .action(async (opts: { txid: string }) => {
    const txid = opts.txid.startsWith("0x") ? opts.txid.substring(2) : opts.txid;

    try {
      // First get block info from Hiro
      const hiroRes = await fetchWithTimeout(`${HIRO_API}/extended/v1/tx/0x${txid}`);
      if (!hiroRes.ok) {
        errOut("trace", "TX_NOT_FOUND", `Transaction 0x${txid} not found on Hiro`, "Verify txid");
        return;
      }

      const tx = (await hiroRes.json()) as TxInfo & { block_hash?: string };
      if (!tx.block_height || !tx.block_hash) {
        errOut("trace", "NO_BLOCK", "Transaction not yet in a block — trace requires confirmed/aborted tx", "Wait for block confirmation");
        return;
      }

      // Get trace from stxer
      const traceUrl = `${STXER_API}/inspect/${tx.block_height}/${tx.block_hash}/${txid}`;
      const traceRes = await fetchWithTimeout(traceUrl);

      if (!traceRes.ok) {
        out({
          status: "success",
          action: "trace",
          data: {
            txid: `0x${txid}`,
            block_height: tx.block_height,
            block_hash: tx.block_hash,
            trace_available: false,
            note: `stxer trace returned HTTP ${traceRes.status}. Trace may not be available for this block yet.`,
            fallback: "Use 'run diagnose' for Hiro-based analysis instead",
          },
          error: null,
        });
        return;
      }

      // Trace data is zstd-compressed binary — extract readable strings
      const traceBuffer = await traceRes.arrayBuffer();
      const traceSize = traceBuffer.byteLength;

      out({
        status: "success",
        action: "trace",
        data: {
          txid: `0x${txid}`,
          block_height: tx.block_height,
          block_hash: tx.block_hash,
          trace_available: true,
          trace_size_bytes: traceSize,
          tx_status: tx.tx_status,
          contract: tx.contract_call?.contract_id,
          function: tx.contract_call?.function_name,
          raw_result: tx.tx_result?.repr,
          note: "Trace data retrieved. Use zstd -d to decompress for full execution trace.",
          stxer_url: traceUrl,
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("trace", "TRACE_ERROR", (e as Error).message, "Check txid and stxer availability");
    }
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
