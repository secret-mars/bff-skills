#!/usr/bin/env bun
/**
 * BTC Fee Scheduler — Monitor Bitcoin fees and flag optimal transaction windows
 *
 * Commands: doctor | run | install-packs
 * Run actions: check | history | should-send
 *
 * Reads current Bitcoin fee estimates and flags low-fee windows for
 * inscriptions, sBTC deposits, and L1 operations. Used by Secret Mars
 * every cycle to decide whether to schedule L1 transactions.
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const MEMPOOL_API = "https://mempool.space/api/v1";
const FETCH_TIMEOUT_MS = 10_000;

// Fee thresholds (sat/vB) — tuned from 1000+ cycles of observation
const THRESHOLDS = {
  ultra_low: 2,      // Rare — jump on it for inscriptions
  low: 5,            // Good for non-urgent L1 ops
  moderate: 15,      // Normal — ok for time-sensitive ops
  high: 30,          // Expensive — delay if possible
  very_high: 50,     // Spike — avoid unless urgent
} as const;

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface FeeEstimates {
  fastest: number;   // ~10 min (next block)
  halfHour: number;  // ~30 min
  hour: number;      // ~60 min
  economy: number;   // ~24 hours
  minimum: number;   // minimum relay
}

// ── Helpers ────────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function errOut(action: string, code: string, message: string, next: string): void {
  out({ status: "error", action, data: {}, error: { code, message, next } });
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyFeeLevel(satPerVb: number): string {
  if (satPerVb <= THRESHOLDS.ultra_low) return "ultra_low";
  if (satPerVb <= THRESHOLDS.low) return "low";
  if (satPerVb <= THRESHOLDS.moderate) return "moderate";
  if (satPerVb <= THRESHOLDS.high) return "high";
  return "very_high";
}

function estimateTxCost(satPerVb: number, vbytes: number): { sats: number; btc: string } {
  const sats = Math.ceil(satPerVb * vbytes);
  return { sats, btc: (sats / 100_000_000).toFixed(8) };
}

async function getFeeEstimates(): Promise<FeeEstimates> {
  const res = await fetchWithTimeout(`${MEMPOOL_API}/fees/recommended`);
  if (!res.ok) throw new Error(`mempool.space returned HTTP ${res.status}`);
  const data = await res.json() as {
    fastestFee: number;
    halfHourFee: number;
    hourFee: number;
    economyFee: number;
    minimumFee: number;
  };
  return {
    fastest: data.fastestFee,
    halfHour: data.halfHourFee,
    hour: data.hourFee,
    economy: data.economyFee,
    minimum: data.minimumFee,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("btc-fee-scheduler")
  .description("Monitor Bitcoin fees and flag optimal windows for L1 transactions");

// ── doctor ─────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check mempool.space API availability")
  .action(async () => {
    const start = Date.now();
    try {
      const res = await fetchWithTimeout(`${MEMPOOL_API}/fees/recommended`);
      const latency = Date.now() - start;
      if (!res.ok) {
        errOut("doctor", "API_DOWN", `mempool.space returned HTTP ${res.status}`, "Retry later");
        return;
      }
      const data = await res.json();
      out({
        status: "success",
        action: "doctor",
        data: {
          mempool_api: "healthy",
          latency_ms: latency,
          current_fastest: (data as { fastestFee: number }).fastestFee,
          thresholds: THRESHOLDS,
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("doctor", "UNREACHABLE", (e as Error).message, "Check network");
    }
  });

// ── run ────────────────────────────────────────────────────────────────

const runCmd = program.command("run").description("Fee monitoring commands");

runCmd
  .command("check")
  .description("Current fee snapshot with window classification and cost estimates")
  .action(async () => {
    try {
      const fees = await getFeeEstimates();
      const level = classifyFeeLevel(fees.hour);

      // Common tx sizes (vbytes)
      const txSizes = {
        simple_transfer: 140,
        inscription_commit: 154,
        inscription_reveal: 200,
        sbtc_deposit: 170,
        multisig_2of3: 370,
      };

      const costEstimates: Record<string, { sats: number; btc: string }> = {};
      for (const [name, vb] of Object.entries(txSizes)) {
        costEstimates[name] = estimateTxCost(fees.hour, vb);
      }

      const signals: string[] = [];
      if (level === "ultra_low") signals.push("INSCRIBE_NOW: Ultra-low fees — best window for inscriptions and batch operations");
      if (level === "low") signals.push("GOOD_WINDOW: Low fees — schedule non-urgent L1 operations");
      if (level === "moderate") signals.push("NORMAL: Fees are moderate — proceed with time-sensitive ops only");
      if (level === "high") signals.push("DELAY: High fees — postpone non-urgent L1 transactions");
      if (level === "very_high") signals.push("AVOID: Fee spike — delay all non-critical L1 operations");

      out({
        status: "success",
        action: "check",
        data: {
          fees: {
            fastest_sat_vb: fees.fastest,
            half_hour_sat_vb: fees.halfHour,
            hour_sat_vb: fees.hour,
            economy_sat_vb: fees.economy,
            minimum_sat_vb: fees.minimum,
          },
          window: {
            level,
            thresholds: THRESHOLDS,
          },
          cost_estimates_at_hour_rate: costEstimates,
          signals,
          checked_at: new Date().toISOString(),
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("check", "FETCH_ERROR", (e as Error).message, "Check mempool.space status");
    }
  });

runCmd
  .command("should-send")
  .description("Go/no-go decision for a specific transaction type and urgency")
  .requiredOption("--type <tx-type>", "Transaction type: transfer, inscription, sbtc-deposit, multisig")
  .option("--max-fee <sat-vb>", "Maximum acceptable fee rate in sat/vB", "10")
  .option("--urgent", "Mark as urgent — overrides fee threshold", false)
  .action(async (opts: { type: string; maxFee: string; urgent: boolean }) => {
    const maxFee = parseInt(opts.maxFee, 10);
    if (isNaN(maxFee) || maxFee <= 0) {
      errOut("should-send", "BAD_MAX_FEE", "max-fee must be a positive integer", "Provide sat/vB threshold");
      return;
    }

    const txSizeMap: Record<string, number> = {
      transfer: 140,
      inscription: 200,
      "sbtc-deposit": 170,
      multisig: 370,
    };

    const vbytes = txSizeMap[opts.type];
    if (!vbytes) {
      errOut("should-send", "BAD_TYPE", `Unknown tx type: ${opts.type}`, `Available: ${Object.keys(txSizeMap).join(", ")}`);
      return;
    }

    try {
      const fees = await getFeeEstimates();
      const currentRate = fees.hour;
      const belowThreshold = currentRate <= maxFee;
      const shouldSend = opts.urgent || belowThreshold;
      const cost = estimateTxCost(currentRate, vbytes);

      out({
        status: shouldSend ? "success" : "blocked",
        action: "should-send",
        data: {
          decision: shouldSend ? "GO" : "WAIT",
          tx_type: opts.type,
          current_rate_sat_vb: currentRate,
          max_acceptable_sat_vb: maxFee,
          below_threshold: belowThreshold,
          urgent: opts.urgent,
          estimated_cost: cost,
          estimated_vbytes: vbytes,
          recommendation: shouldSend
            ? `Send now at ${currentRate} sat/vB (${cost.sats} sats estimated)`
            : `Wait — current rate ${currentRate} exceeds your ${maxFee} sat/vB threshold. Economy rate is ${fees.economy} sat/vB.`,
        },
        error: shouldSend ? null : {
          code: "FEE_TOO_HIGH",
          message: `Current ${currentRate} sat/vB exceeds threshold ${maxFee} sat/vB`,
          next: `Wait for fees to drop or increase --max-fee. Economy rate: ${fees.economy} sat/vB`,
        },
      });
    } catch (e: unknown) {
      errOut("should-send", "FETCH_ERROR", (e as Error).message, "Check network");
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
