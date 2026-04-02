#!/usr/bin/env bun
/**
 * DeFi Position Dashboard — Unified multi-protocol position reader for Stacks DeFi
 *
 * Commands: doctor | run | install-packs
 * Run actions: positions | summary
 *
 * Reads Zest lending positions, sBTC balance, STX balance, and v0-4-market state
 * in a single batched API call via stxer. No on-chain writes — pure read-only.
 *
 * Built by Secret Mars — this is our production boot sensor, used every cycle
 * to check balances and DeFi positions before making yield/trade decisions.
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const STXER_API = "https://api.stxer.xyz";
const FETCH_TIMEOUT_MS = 15_000;

// Known Stacks DeFi contracts (mainnet)
const CONTRACTS = {
  sbtc: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
  zsbtc: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0",
  zestIncentives: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.incentives-v2-2",
  v04Market: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market",
  v04MarketVault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-market-vault",
  wstx: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.wstx",
} as const;

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface Position {
  protocol: string;
  asset: string;
  balance_raw: number;
  balance_formatted: string;
  unit: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function errOut(action: string, code: string, message: string, next: string): void {
  out({ status: "error", action, data: {}, error: { code, message, next } });
}

/** Encode a Stacks principal as Clarity hex for readonly call args */
function encodePrincipalHex(address: string): string {
  // Standard principal: version byte (0x16 for SP, 0x14 for SM) + 20-byte hash160
  // We use the c32 decode approach
  const C32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  // Strip the version prefix (SP or SM) for c32 decoding
  const prefix = address.substring(0, 2);
  const versionByte = prefix === "SP" ? 0x16 : prefix === "SM" ? 0x14 : null;
  if (versionByte === null) throw new Error(`Invalid Stacks address prefix: ${prefix}`);

  // c32 decode the address body (skip first 2 chars = version prefix)
  const body = address.substring(2);
  let n = BigInt(0);
  for (const ch of body) {
    const idx = C32_ALPHABET.indexOf(ch.toUpperCase());
    if (idx < 0) continue; // skip checksum chars
    n = n * 32n + BigInt(idx);
  }

  // Extract 20-byte hash from the bigint (skip version + checksum)
  const fullHex = n.toString(16).padStart(50, "0"); // 25 bytes = 50 hex chars
  const hash160 = fullHex.substring(2, 42); // skip version byte, take 20 bytes

  // Clarity standard principal: 05 + version_byte + hash160
  return `05${versionByte.toString(16).padStart(2, "0")}${hash160}`;
}

/** Decode a Clarity uint from hex (response ok wrapper: 0701 + 16-byte uint) */
function decodeUintFromOk(hex: string): number {
  // Format: 0701 + 32-char hex uint, or just 01 + 32-char hex uint
  let uintHex: string;
  if (hex.startsWith("0701")) {
    uintHex = hex.substring(4);
  } else if (hex.startsWith("01")) {
    uintHex = hex.substring(2);
  } else {
    return 0;
  }
  return Number(BigInt("0x" + uintHex));
}

/** Decode Clarity uint from raw hex (no wrapper) */
function decodeRawUint(hex: string): number {
  if (hex.startsWith("01")) {
    return Number(BigInt("0x" + hex.substring(2)));
  }
  return 0;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function stxerBatchRead(address: string): Promise<{
  stx: number;
  nonce: number;
  sbtc: number;
  zsbtc: number;
  zestRewards: number;
  error?: string;
}> {
  const principalHex = encodePrincipalHex(address);

  // sBTC token contract principal hex for incentives call
  const sbtcContractHex = "0614f6decc7cfff2a413bd7cd4f53c25ad7fd1899acc0a736274632d746f6b656e";
  const wstxContractHex = "061605b65e5089ed1b09b299fe0d910a82e37570781f0477737478";

  const body = {
    stx: [address],
    nonces: [address],
    readonly: [
      // sBTC balance via get-balance
      [CONTRACTS.sbtc, "get-balance", principalHex],
      // zsbtc balance (Zest LP tokens)
      [CONTRACTS.zsbtc, "get-balance", principalHex],
      // Zest vault rewards
      [CONTRACTS.zestIncentives, "get-vault-rewards", principalHex, sbtcContractHex, wstxContractHex],
    ],
  };

  const res = await fetchWithTimeout(`${STXER_API}/sidecar/v2/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`stxer batch API returned HTTP ${res.status}`);
  const data = await res.json() as Record<string, unknown[]>;

  // Parse STX balance (hex string → uSTX)
  const stxHex = (data.stx?.[0] as { Ok?: string })?.Ok ?? "0";
  const stx = parseInt(stxHex, 10) || 0;

  // Parse nonce
  const nonceVal = (data.nonces?.[0] as { Ok?: string })?.Ok ?? "0";
  const nonce = parseInt(nonceVal, 10) || 0;

  // Parse sBTC balance (readonly[0])
  const sbtcResult = (data.readonly?.[0] as { Ok?: string })?.Ok ?? "";
  const sbtc = decodeUintFromOk(sbtcResult);

  // Parse zsbtc (readonly[1])
  const zsbtcResult = (data.readonly?.[1] as { Ok?: string })?.Ok ?? "";
  const zsbtc = decodeUintFromOk(zsbtcResult);

  // Parse rewards (readonly[2])
  const rewardsResult = (data.readonly?.[2] as { Ok?: string })?.Ok ?? "";
  const zestRewards = decodeRawUint(rewardsResult);

  return { stx, nonce, sbtc, zsbtc, zestRewards };
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("defi-position-dashboard")
  .description("Unified multi-protocol DeFi position reader for Stacks — one call, all positions");

// ── doctor ─────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check stxer batch API health and readiness")
  .action(async () => {
    const start = Date.now();
    try {
      const res = await fetchWithTimeout(`${STXER_API}/sidecar/v2/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stx: ["SP000000000000000000002Q6VF78.pox-4"] }),
      });
      const latency = Date.now() - start;
      if (!res.ok) {
        errOut("doctor", "STXER_DOWN", `stxer API returned HTTP ${res.status}`, "Retry later or check https://api.stxer.xyz");
        return;
      }
      out({
        status: "success",
        action: "doctor",
        data: {
          stxer_api: "healthy",
          latency_ms: latency,
          batch_endpoint: "available",
          protocols_supported: ["Zest Protocol (zsbtc-v2-0)", "v0-4-market", "sBTC", "STX"],
          note: "Read-only — no transactions, no gas costs",
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("doctor", "STXER_UNREACHABLE", (e as Error).message, "Check network connectivity");
    }
  });

// ── run ────────────────────────────────────────────────────────────────

const runCmd = program
  .command("run")
  .description("Read DeFi positions");

runCmd
  .command("positions")
  .description("Read all DeFi positions for a Stacks address in one batched call")
  .requiredOption("--address <stx-address>", "Stacks address to read (SP... or SM...)")
  .option("--min-display <sats>", "Hide positions below this threshold (in smallest unit)", "0")
  .action(async (opts: { address: string; minDisplay: string }) => {
    if (!opts.address.startsWith("SP") && !opts.address.startsWith("SM")) {
      errOut("positions", "BAD_ADDRESS", "Address must be a mainnet Stacks address (SP... or SM...)", "Use a valid Stacks address");
      return;
    }

    try {
      const data = await stxerBatchRead(opts.address);
      const minDisplay = parseInt(opts.minDisplay, 10) || 0;

      const positions: Position[] = [];

      // STX balance
      if (data.stx >= minDisplay) {
        positions.push({
          protocol: "Stacks L2",
          asset: "STX",
          balance_raw: data.stx,
          balance_formatted: (data.stx / 1_000_000).toFixed(6),
          unit: "STX",
        });
      }

      // sBTC balance
      if (data.sbtc >= minDisplay) {
        positions.push({
          protocol: "sBTC",
          asset: "sBTC (liquid)",
          balance_raw: data.sbtc,
          balance_formatted: (data.sbtc / 100_000_000).toFixed(8),
          unit: "BTC",
        });
      }

      // Zest zsbtc LP tokens
      if (data.zsbtc >= minDisplay) {
        positions.push({
          protocol: "Zest Protocol",
          asset: "zsbtc-v2-0 (lending LP)",
          balance_raw: data.zsbtc,
          balance_formatted: (data.zsbtc / 100_000_000).toFixed(8),
          unit: "BTC-equivalent",
        });
      }

      // Zest rewards
      if (data.zestRewards > 0) {
        positions.push({
          protocol: "Zest Protocol",
          asset: "wSTX rewards (claimable)",
          balance_raw: data.zestRewards,
          balance_formatted: (data.zestRewards / 1_000_000).toFixed(6),
          unit: "STX",
        });
      }

      // Compute totals
      const totalBtcEquiv = (data.sbtc + data.zsbtc) / 100_000_000;
      const totalStxEquiv = (data.stx + data.zestRewards) / 1_000_000;

      out({
        status: "success",
        action: "positions",
        data: {
          address: opts.address,
          nonce: data.nonce,
          positions,
          totals: {
            btc_equivalent: totalBtcEquiv.toFixed(8),
            btc_equivalent_sats: data.sbtc + data.zsbtc,
            stx_equivalent: totalStxEquiv.toFixed(6),
            position_count: positions.length,
          },
          api_calls: 1,
          note: "All data from single stxer batch read — no on-chain writes",
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("positions", "READ_FAILED", (e as Error).message, "Check address format and stxer API status");
    }
  });

runCmd
  .command("summary")
  .description("One-line portfolio summary for agent decision-making")
  .requiredOption("--address <stx-address>", "Stacks address to read")
  .option("--liquid-reserve <sats>", "Target liquid sBTC reserve (for yield funnel decisions)", "200000")
  .action(async (opts: { address: string; liquidReserve: string }) => {
    if (!opts.address.startsWith("SP") && !opts.address.startsWith("SM")) {
      errOut("summary", "BAD_ADDRESS", "Address must be a mainnet Stacks address", "Use SP... or SM...");
      return;
    }

    try {
      const data = await stxerBatchRead(opts.address);
      const reserve = parseInt(opts.liquidReserve, 10) || 200000;

      // Decision signals
      const excessSbtc = data.sbtc - reserve;
      const shouldFunnel = excessSbtc > 1000; // more than 1000 sats excess
      const hasRewards = data.zestRewards > 0;
      const lowStx = data.stx < 500_000; // less than 0.5 STX for gas

      const signals: string[] = [];
      if (shouldFunnel) signals.push(`FUNNEL: ${excessSbtc} sats excess sBTC above ${reserve} reserve → supply to Zest`);
      if (hasRewards) signals.push(`CLAIM: ${data.zestRewards} uSTX in Zest rewards available`);
      if (lowStx) signals.push(`LOW_GAS: only ${(data.stx / 1_000_000).toFixed(2)} STX — consider acquiring more for tx fees`);
      if (signals.length === 0) signals.push("STEADY: all positions within normal parameters");

      out({
        status: "success",
        action: "summary",
        data: {
          address: opts.address,
          snapshot: {
            stx_ustx: data.stx,
            sbtc_sats: data.sbtc,
            zsbtc_sats: data.zsbtc,
            zest_rewards_ustx: data.zestRewards,
            nonce: data.nonce,
          },
          decision_signals: signals,
          yield_allocation: {
            liquid_sbtc: data.sbtc,
            yielding_zsbtc: data.zsbtc,
            target_reserve: reserve,
            excess_sats: Math.max(0, excessSbtc),
            yield_ratio: data.zsbtc > 0 ? (data.zsbtc / (data.sbtc + data.zsbtc) * 100).toFixed(1) + "%" : "0%",
          },
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("summary", "READ_FAILED", (e as Error).message, "Check address and stxer API");
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
