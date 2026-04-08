#!/usr/bin/env bun
/**
 * Styx Bridge Monitor — BTC-to-sBTC bridge health and deposit tracking
 *
 * Commands: doctor | run | install-packs
 * Actions (run): status | deposits | fees
 *
 * Built by Secret Mars — monitors the Styx protocol that agents use to bridge
 * BTC to sBTC without waiting for the native sBTC deposit queue.
 *
 * On-chain proof: reads SP6SA6BTPNN5WDAWQ7GWJF1T5E2KWY01K9SZDBJQ.styx-v1
 * pool state directly from Stacks mainnet.
 */

import {
  fetchCallReadOnlyFunction,
  cvToJSON,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

// ── Constants ──────────────────────────────────────────────────────────

const NETWORK = STACKS_MAINNET;
const HIRO_API = "https://api.hiro.so";
const MEMPOOL_API = "https://mempool.space/api";

// Styx v1 contract (mainnet)
const STYX_CONTRACT_ADDR = "SP6SA6BTPNN5WDAWQ7GWJF1T5E2KWY01K9SZDBJQ";
const STYX_CONTRACT_NAME = "styx-v1";
const STYX_BTC_ADDRESS = "bc1qlh3zk77pc4mlyqz0dqhjvn6p2g5tfqj8qvqxfy";

const MIN_DEPOSIT_SATS = 10_000;
const MAX_DEPOSIT_SATS = 400_000;

// Alert thresholds
const LOW_LIQUIDITY_SATS = 50_000;
const HIGH_FEE_SATVB = 50;

// Sender for read-only calls (doesn't matter, just needs a valid address)
const SENDER = "SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE";

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

// ── Helpers ────────────────────────────────────────────────────────────

function output(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function error(code: string, message: string, next: string): void {
  output({ status: "error", action: next, data: {}, error: { code, message, next } });
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

function getStxAddress(): string {
  return process.env.STACKS_ADDRESS || process.env.STX_ADDRESS || "";
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ── On-Chain Reads ─────────────────────────────────────────────────────

async function getStyxPool(): Promise<Record<string, any>> {
  const result = await fetchCallReadOnlyFunction({
    network: NETWORK,
    contractAddress: STYX_CONTRACT_ADDR,
    contractName: STYX_CONTRACT_NAME,
    functionName: "get-pool",
    functionArgs: [],
    senderAddress: SENDER,
  });

  const json = cvToJSON(result);
  // Contract returns (ok {tuple}) — unwrap the response and tuple
  const val = json.value?.value || json.value || json;

  // Extract key fields from the Clarity tuple
  const extract = (key: string): string | number => {
    const v = val[key];
    if (!v) return 0;
    if (v.type === "uint" || v.type === "int") return parseInt(v.value, 10);
    if (v.type === "buff") return v.value;
    return v.value ?? 0;
  };

  return {
    available_sbtc: extract("available-sbtc"),
    total_sbtc: extract("total-sbtc"),
    max_deposit: extract("max-deposit"),
    fee: extract("fee"),
    fee_threshold: extract("fee-threshold"),
    last_updated_block: extract("last-updated"),
    max_slippage_rate: extract("max-slippage-rate"),
  };
}

async function isPoolInitialized(): Promise<boolean> {
  const result = await fetchCallReadOnlyFunction({
    network: NETWORK,
    contractAddress: STYX_CONTRACT_ADDR,
    contractName: STYX_CONTRACT_NAME,
    functionName: "is-pool-initialized",
    functionArgs: [],
    senderAddress: SENDER,
  });
  const json = cvToJSON(result);
  // Contract returns (ok true) — check nested value
  const inner = json.value?.value ?? json.value;
  return inner === true || inner === "true";
}

async function getBtcFees(): Promise<{ fast: number; medium: number; slow: number }> {
  const data = await fetchJson(`${MEMPOOL_API}/v1/fees/recommended`);
  return {
    fast: data.fastestFee ?? 0,
    medium: data.halfHourFee ?? 0,
    slow: data.hourFee ?? 0,
  };
}

async function getSbtcBalance(address: string): Promise<number> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/balances`);
  if (!res.ok) throw new Error(`Failed to fetch balances: ${res.status}`);
  const data = await res.json();
  const ftKey = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token";
  const entry = data.fungible_tokens?.[ftKey];
  return entry ? parseInt(entry.balance, 10) : 0;
}

// ── Commands ───────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  // Check Styx contract reachability
  try {
    const initialized = await isPoolInitialized();
    checks["styx_contract"] = {
      ok: initialized,
      detail: initialized
        ? `${STYX_CONTRACT_ADDR}.${STYX_CONTRACT_NAME} active`
        : "Pool not initialized",
    };
  } catch (e: any) {
    checks["styx_contract"] = { ok: false, detail: e.message };
  }

  // Check pool liquidity
  try {
    const pool = await getStyxPool();
    const available = pool.available_sbtc as number;
    const healthy = available >= LOW_LIQUIDITY_SATS;
    checks["pool_liquidity"] = {
      ok: healthy,
      detail: `${available} sats sBTC available${healthy ? "" : " — LOW"}`,
    };
  } catch (e: any) {
    checks["pool_liquidity"] = { ok: false, detail: e.message };
  }

  // Check BTC fees
  try {
    const fees = await getBtcFees();
    const feeOk = fees.medium <= HIGH_FEE_SATVB;
    checks["btc_fees"] = {
      ok: feeOk,
      detail: `${fees.medium} sat/vB medium${feeOk ? "" : ` — HIGH (>${HIGH_FEE_SATVB})`}`,
    };
  } catch (e: any) {
    checks["btc_fees"] = { ok: false, detail: e.message };
  }

  // Check wallet config
  const stxAddr = getStxAddress();
  if (stxAddr) {
    try {
      const bal = await getSbtcBalance(stxAddr);
      checks["wallet"] = { ok: true, detail: `${stxAddr.slice(0, 8)}... — ${bal} sats sBTC` };
    } catch (e: any) {
      checks["wallet"] = { ok: false, detail: e.message };
    }
  } else {
    checks["wallet"] = {
      ok: false,
      detail: "No STACKS_ADDRESS configured. Set env var for deposit tracking.",
    };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  const blockers = Object.entries(checks)
    .filter(([, c]) => !c.ok)
    .map(([k, c]) => `${k}: ${c.detail}`);

  output({
    status: allOk ? "success" : blockers.some((b) => b.includes("styx_contract")) ? "blocked" : "success",
    action: allOk
      ? "Environment ready. Run with --action=status for full bridge health."
      : "Some checks failed — see details. Core monitoring may still work.",
    data: { checks },
    error: allOk
      ? null
      : { code: "doctor_warnings", message: blockers.join("; "), next: "Resolve issues or proceed with monitoring" },
  });
}

async function runStatus(): Promise<void> {
  const [pool, fees] = await Promise.all([
    getStyxPool().catch((e) => ({ available_sbtc: 0, total_sbtc: 0, max_deposit: MAX_DEPOSIT_SATS, fee: 0, fee_threshold: 0, last_updated_block: 0, max_slippage_rate: 0, error: e.message })),
    getBtcFees().catch(() => ({ fast: 0, medium: 0, slow: 0 })),
  ]);

  const available = (pool.available_sbtc as number) || 0;
  const totalSbtc = (pool.total_sbtc as number) || 0;
  const maxDeposit = Math.min((pool.max_deposit as number) || MAX_DEPOSIT_SATS, available);
  const protocolFee = (pool.fee as number) || 0;

  const alerts: string[] = [];
  if (available < LOW_LIQUIDITY_SATS) {
    alerts.push(`Low liquidity: ${available} sats available (threshold: ${LOW_LIQUIDITY_SATS})`);
  }
  if (fees.medium > HIGH_FEE_SATVB) {
    alerts.push(`High BTC fees: ${fees.medium} sat/vB — deposits will be expensive`);
  }
  if (available < MAX_DEPOSIT_SATS) {
    alerts.push(`Reduced max deposit: ${available} sats (pool max: ${MAX_DEPOSIT_SATS})`);
  }

  // Estimate deposit cost
  const typicalVbytes = 140;
  const depositCostSats = fees.medium * typicalVbytes;

  let action: string;
  if (alerts.length > 0) {
    action = `${alerts.length} alert(s). Review before depositing.`;
  } else if (fees.medium <= 3) {
    action = "Low fees + healthy pool — optimal window for BTC-to-sBTC deposits.";
  } else {
    action = "Bridge healthy. No immediate action needed.";
  }

  output({
    status: "success",
    action,
    data: {
      pool: {
        contract: `${STYX_CONTRACT_ADDR}.${STYX_CONTRACT_NAME}`,
        btc_deposit_address: STYX_BTC_ADDRESS,
        available_sbtc_sats: available,
        total_sbtc_sats: totalSbtc,
        max_single_deposit_sats: maxDeposit,
        min_deposit_sats: MIN_DEPOSIT_SATS,
        protocol_fee_sats: protocolFee,
        healthy: available >= LOW_LIQUIDITY_SATS,
      },
      fees: {
        btc_satvb: fees,
        estimated_deposit_cost_sats: depositCostSats,
        note: `Based on ~${typicalVbytes} vB typical deposit tx`,
      },
      utilization_pct: totalSbtc > 0 ? Math.round((1 - available / totalSbtc) * 100) : 0,
      alerts,
    },
    error: null,
  });
}

async function runFees(): Promise<void> {
  const fees = await getBtcFees();

  const typicalVbytes = 140;
  const costFast = fees.fast * typicalVbytes;
  const costMedium = fees.medium * typicalVbytes;
  const costSlow = fees.slow * typicalVbytes;

  // Fee as percentage of min deposit
  const feeRatioPct = ((costMedium / MIN_DEPOSIT_SATS) * 100).toFixed(2);

  let timing: string;
  if (fees.medium <= 3) timing = "Excellent — deposit now for minimal fees.";
  else if (fees.medium <= 10) timing = "Normal fees. Acceptable for most deposits.";
  else if (fees.medium <= HIGH_FEE_SATVB) timing = "Elevated fees. Consider waiting if not urgent.";
  else timing = "High fees. Delay non-urgent deposits.";

  output({
    status: "success",
    action: timing,
    data: {
      fees_satvb: fees,
      estimated_deposit_cost_sats: { fast: costFast, medium: costMedium, slow: costSlow },
      fee_as_pct_of_min_deposit: `${feeRatioPct}%`,
      fee_alert: fees.medium > HIGH_FEE_SATVB,
    },
    error: null,
  });
}

async function runDeposits(): Promise<void> {
  // Check if any deposits can be verified on-chain via the contract
  const stxAddr = getStxAddress();
  if (!stxAddr) {
    error("no_wallet", "Set STACKS_ADDRESS to check deposit context.", "Configure wallet");
    return;
  }

  const [pool, sbtcBal] = await Promise.all([
    getStyxPool(),
    getSbtcBalance(stxAddr),
  ]);

  output({
    status: "success",
    action: sbtcBal > 0
      ? "sBTC balance detected. Bridge deposits reflected in wallet balance."
      : "No sBTC balance. Make a deposit via Styx to receive sBTC.",
    data: {
      address: stxAddr,
      sbtc_balance_sats: sbtcBal,
      pool_available_sats: pool.available_sbtc,
      note: "Styx deposits are reflected in your sBTC balance once confirmed. Use styx_status tool with a deposit ID to track specific deposits.",
    },
    error: null,
  });
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  switch (command) {
    case "doctor":
      await doctor();
      break;

    case "install-packs": {
      const deps = ["@stacks/transactions", "@stacks/network"];
      const missing: string[] = [];
      for (const dep of deps) {
        try {
          require.resolve(dep);
        } catch {
          missing.push(dep);
        }
      }
      output({
        status: "success",
        action: missing.length > 0
          ? `Install missing: bun add ${missing.join(" ")}`
          : "All dependencies installed",
        data: { required: deps, missing, installed: deps.filter((d) => !missing.includes(d)) },
        error: null,
      });
      break;
    }

    case "run": {
      const action = args["action"] || "status";
      switch (action) {
        case "status":
          await runStatus();
          break;
        case "fees":
          await runFees();
          break;
        case "deposits":
          await runDeposits();
          break;
        default:
          error("unknown_action", `Unknown action: ${action}`, "Use --action=status|fees|deposits");
      }
      break;
    }

    default:
      error("unknown_command", `Unknown command: ${command || "(none)"}`, "Use: doctor | run | install-packs");
  }
}

main().catch((e) => {
  error("unhandled", e.message, "Check stack trace and retry");
  process.exit(1);
});
