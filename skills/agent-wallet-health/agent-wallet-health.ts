#!/usr/bin/env bun
/**
 * Agent Wallet Health — Multi-chain wallet status for Stacks agents
 *
 * Commands: doctor | run | install-packs
 * Run actions: check | gas-ready | nonce-status
 *
 * Checks STX balance, sBTC balance, BTC L1 balance, current nonce,
 * and pending transactions in one call. Flags issues before they
 * cause failed operations.
 */

import { Command } from "commander";

const HIRO_API = "https://api.hiro.so";
const MEMPOOL_API = "https://mempool.space/api";
const STXER_API = "https://api.stxer.xyz";
const FETCH_TIMEOUT_MS = 10_000;

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

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("agent-wallet-health")
  .description("Multi-chain wallet health check for Stacks agents");

program
  .command("doctor")
  .description("Verify API endpoints are reachable")
  .action(async () => {
    const checks: Record<string, boolean> = {};
    for (const [name, url] of [
      ["hiro", `${HIRO_API}/extended/v1/status`],
      ["mempool", `${MEMPOOL_API}/v1/fees/recommended`],
    ]) {
      try {
        const res = await fetchWithTimeout(url);
        checks[name] = res.ok;
      } catch {
        checks[name] = false;
      }
    }
    const allOk = Object.values(checks).every(Boolean);
    if (!allOk) {
      errOut("doctor", "API_DOWN", `Some APIs unreachable: ${JSON.stringify(checks)}`, "Retry later");
      return;
    }
    out({ status: "success", action: "doctor", data: { apis: checks }, error: null });
  });

const runCmd = program.command("run").description("Wallet health commands");

runCmd
  .command("check")
  .description("Full wallet health: balances, nonce, pending txs, warnings")
  .requiredOption("--stx-address <addr>", "Stacks address (SP...)")
  .option("--btc-address <addr>", "BTC address (bc1...) for L1 balance")
  .action(async (opts: { stxAddress: string; btcAddress?: string }) => {
    if (!opts.stxAddress.startsWith("SP") && !opts.stxAddress.startsWith("SM")) {
      errOut("check", "BAD_ADDRESS", "Stacks address must start with SP or SM", "Use a mainnet address");
      return;
    }

    try {
      // Fetch STX info + sBTC + nonce in parallel
      const [stxRes, sbtcRes, nonceRes, pendingRes] = await Promise.all([
        fetchWithTimeout(`${HIRO_API}/extended/v1/address/${opts.stxAddress}/stx`),
        fetchWithTimeout(`${HIRO_API}/extended/v1/address/${opts.stxAddress}/balances`),
        fetchWithTimeout(`${HIRO_API}/extended/v1/address/${opts.stxAddress}/nonces`),
        fetchWithTimeout(`${HIRO_API}/extended/v1/address/${opts.stxAddress}/mempool?limit=5`),
      ]);

      const stxData = stxRes.ok ? await stxRes.json() as { balance: string; locked: string } : null;
      const balData = sbtcRes.ok ? await sbtcRes.json() as { fungible_tokens: Record<string, { balance: string }> } : null;
      const nonceData = nonceRes.ok ? await nonceRes.json() as { last_executed_tx_nonce: number; possible_next_nonce: number; detected_missing_nonces: number[] } : null;
      const pendingData = pendingRes.ok ? await pendingRes.json() as { results: Array<{ tx_id: string; tx_type: string; fee_rate: string; nonce: number }> } : null;

      // Parse balances
      const stxBalance = stxData ? parseInt(stxData.balance, 10) : 0;
      const stxLocked = stxData ? parseInt(stxData.locked, 10) : 0;
      const sbtcKey = Object.keys(balData?.fungible_tokens || {}).find(k => k.includes("sbtc-token"));
      const sbtcBalance = sbtcKey ? parseInt(balData!.fungible_tokens[sbtcKey].balance, 10) : 0;

      // BTC L1 balance (optional)
      let btcBalance: number | null = null;
      if (opts.btcAddress) {
        try {
          const btcRes = await fetchWithTimeout(`${MEMPOOL_API}/address/${opts.btcAddress}`);
          if (btcRes.ok) {
            const btcData = await btcRes.json() as { chain_stats: { funded_txo_sum: number; spent_txo_sum: number } };
            btcBalance = btcData.chain_stats.funded_txo_sum - btcData.chain_stats.spent_txo_sum;
          }
        } catch { /* skip L1 on failure */ }
      }

      // Nonce analysis
      const lastNonce = nonceData?.last_executed_tx_nonce ?? -1;
      const nextNonce = nonceData?.possible_next_nonce ?? 0;
      const missingNonces = nonceData?.detected_missing_nonces ?? [];
      const pendingTxs = pendingData?.results ?? [];

      // Generate warnings
      const warnings: string[] = [];
      if (stxBalance < 500_000) warnings.push("LOW_GAS: STX balance below 0.5 — may fail on tx fees");
      if (stxBalance < 100_000) warnings.push("CRITICAL_GAS: STX balance below 0.1 — transactions will fail");
      if (missingNonces.length > 0) warnings.push(`NONCE_GAP: Missing nonces ${missingNonces.join(", ")} — fill gaps before sending`);
      if (pendingTxs.length >= 5) warnings.push("MEMPOOL_FULL: 5+ pending txs — wait for confirmations");
      if (btcBalance !== null && btcBalance < 3000) warnings.push("LOW_BTC: BTC L1 below 3000 sats — insufficient for L1 operations");

      out({
        status: warnings.some(w => w.startsWith("CRITICAL")) ? "blocked" : "success",
        action: "check",
        data: {
          stacks: {
            address: opts.stxAddress,
            stx_ustx: stxBalance,
            stx_formatted: (stxBalance / 1_000_000).toFixed(6),
            stx_locked_ustx: stxLocked,
            sbtc_sats: sbtcBalance,
            sbtc_formatted: (sbtcBalance / 100_000_000).toFixed(8),
          },
          nonce: {
            last_executed: lastNonce,
            next: nextNonce,
            missing_gaps: missingNonces,
            pending_count: pendingTxs.length,
          },
          ...(btcBalance !== null ? {
            bitcoin: {
              address: opts.btcAddress,
              balance_sats: btcBalance,
              balance_btc: (btcBalance / 100_000_000).toFixed(8),
            },
          } : {}),
          warnings,
          healthy: warnings.length === 0,
          checked_at: new Date().toISOString(),
        },
        error: warnings.some(w => w.startsWith("CRITICAL"))
          ? { code: "WALLET_UNHEALTHY", message: warnings.filter(w => w.startsWith("CRITICAL")).join("; "), next: "Fund wallet before proceeding" }
          : null,
      });
    } catch (e: unknown) {
      errOut("check", "FETCH_ERROR", (e as Error).message, "Check network and address format");
    }
  });

runCmd
  .command("gas-ready")
  .description("Quick check: does this wallet have enough gas for a transaction?")
  .requiredOption("--stx-address <addr>", "Stacks address")
  .option("--min-stx <amount>", "Minimum STX required (in uSTX)", "50000")
  .action(async (opts: { stxAddress: string; minStx: string }) => {
    const minRequired = parseInt(opts.minStx, 10);
    try {
      const res = await fetchWithTimeout(`${HIRO_API}/extended/v1/address/${opts.stxAddress}/stx`);
      if (!res.ok) {
        errOut("gas-ready", "FETCH_ERROR", `Hiro returned ${res.status}`, "Check address");
        return;
      }
      const data = await res.json() as { balance: string };
      const balance = parseInt(data.balance, 10);
      const ready = balance >= minRequired;

      out({
        status: ready ? "success" : "blocked",
        action: "gas-ready",
        data: {
          address: opts.stxAddress,
          balance_ustx: balance,
          required_ustx: minRequired,
          ready,
          shortfall: ready ? 0 : minRequired - balance,
        },
        error: ready ? null : {
          code: "INSUFFICIENT_GAS",
          message: `Need ${minRequired} uSTX, have ${balance}`,
          next: "Fund wallet with STX before transacting",
        },
      });
    } catch (e: unknown) {
      errOut("gas-ready", "FETCH_ERROR", (e as Error).message, "Check network");
    }
  });

runCmd
  .command("nonce-status")
  .description("Check nonce health: gaps, pending count, next expected")
  .requiredOption("--stx-address <addr>", "Stacks address")
  .action(async (opts: { stxAddress: string }) => {
    try {
      const [nonceRes, pendingRes] = await Promise.all([
        fetchWithTimeout(`${HIRO_API}/extended/v1/address/${opts.stxAddress}/nonces`),
        fetchWithTimeout(`${HIRO_API}/extended/v1/address/${opts.stxAddress}/mempool?limit=10`),
      ]);

      if (!nonceRes.ok) {
        errOut("nonce-status", "FETCH_ERROR", `Hiro returned ${nonceRes.status}`, "Check address");
        return;
      }

      const nonceData = await nonceRes.json() as { last_executed_tx_nonce: number; possible_next_nonce: number; detected_missing_nonces: number[] };
      const pendingData = pendingRes.ok ? await pendingRes.json() as { results: Array<{ nonce: number; tx_id: string }> } : null;

      const gaps = nonceData.detected_missing_nonces;
      const pendingNonces = (pendingData?.results ?? []).map(tx => tx.nonce);
      const healthy = gaps.length === 0;

      out({
        status: healthy ? "success" : "blocked",
        action: "nonce-status",
        data: {
          address: opts.stxAddress,
          last_executed: nonceData.last_executed_tx_nonce,
          next_nonce: nonceData.possible_next_nonce,
          gaps,
          pending_nonces: pendingNonces,
          healthy,
          action: healthy ? "CLEAR" : `FILL_GAPS: nonces ${gaps.join(", ")} need filling before new txs`,
        },
        error: healthy ? null : {
          code: "NONCE_GAP",
          message: `Missing nonces: ${gaps.join(", ")}`,
          next: "Send gap-filling txs at the missing nonce values",
        },
      });
    } catch (e: unknown) {
      errOut("nonce-status", "FETCH_ERROR", (e as Error).message, "Check network");
    }
  });

program
  .command("install-packs")
  .description("Install dependencies")
  .action(() => {
    try {
      const result = Bun.spawnSync(["bun", "add", "commander"], { stdio: ["pipe", "pipe", "pipe"] });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      out({ status: "success", action: "install-packs", data: { installed: ["commander"] }, error: null });
    } catch (e: unknown) {
      errOut("install-packs", "INSTALL_FAIL", (e as Error).message, "Run 'bun add commander' manually");
    }
  });

program.parse();
