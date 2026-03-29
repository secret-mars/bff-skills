#!/usr/bin/env bun
/**
 * Portfolio Rebalancer — Multi-position DeFi portfolio management on Stacks
 *
 * Commands: doctor | run | install-packs
 * Run actions: status | rebalance | history
 *
 * Reads positions across Zest Protocol (sBTC lending), v0-4-market (collateral),
 * and liquid sBTC. Computes current allocation vs target, then suggests or
 * executes rebalances to maintain target ratios.
 *
 * Built by Secret Mars — manages a real 3-bucket portfolio every cycle:
 *   ~200k liquid sBTC / ~245k Zest yield / ~102k v0-4-market collateral
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const STXER_API = "https://api.stxer.xyz";
const HIRO_API = "https://api.hiro.so";

// Default target allocation (percentages, must sum to 100)
const DEFAULT_TARGETS: Record<string, number> = {
  liquid: 35,     // liquid sBTC for ops, messaging, trades
  zest: 45,       // Zest lending pool (yield-generating)
  v0_market: 20,  // v0-4-market collateral (yield via exchange rate)
};

// Contracts
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const ZSBTC = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0";
const V0_MARKET = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market";
const BORROW_HELPER = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7";

// Safety
const MIN_LIQUID_SATS = 50_000;       // always keep at least 50k liquid
const MAX_SINGLE_MOVE_SATS = 100_000; // cap single rebalance at 100k sats
const DRIFT_THRESHOLD_PCT = 5;        // only rebalance if drift > 5%

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface Position {
  bucket: string;
  balance_sats: number;
  pct: number;
  target_pct: number;
  drift_pct: number;
  action: "hold" | "increase" | "decrease";
}

// ── Helpers ────────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function errOut(code: string, message: string, next: string): void {
  out({ status: "error", action: next, data: {}, error: { code, message, next } });
}

function decodeClarityUint(hex: string): number {
  // Clarity uint: prefix 01, then 16 bytes big-endian
  if (hex.startsWith("07")) {
    // optional some
    return decodeClarityUint(hex.substring(2));
  }
  if (hex.startsWith("01")) {
    return Number(BigInt("0x" + hex.substring(2)));
  }
  return 0;
}

function serializePrincipal(address: string): string {
  // For stxer batch readonly, we need hex-encoded Clarity principal
  // SP addresses use version byte 0x16 (22), SM uses 0x14 (20)
  // This is a simplified version — for production use @stacks/transactions
  const version = address.startsWith("SP") ? "16" : "14";
  // c32 decode the address to get the hash160
  // For the stxer batch API, we pass the principal as a string arg
  return `0516${c32ToHex(address)}`;
}

function c32ToHex(address: string): string {
  // Simplified c32check decode for known addresses
  // In production, use @stacks/transactions serializeCV
  // For now, we use the stxer API which accepts principal strings
  return address; // placeholder — stxer batch handles string principals
}

async function fetchBalances(stxAddress: string): Promise<{
  liquid: number;
  zest: number;
  v0_market: number;
  stx_ustx: number;
}> {
  // Use stxer batch to read all positions in 1 call
  const principalHex = stxAddress.startsWith("SP")
    ? `0516${Buffer.from(decodeC32(stxAddress)).toString("hex")}`
    : `0514${Buffer.from(decodeC32(stxAddress)).toString("hex")}`;

  const res = await fetch(`${STXER_API}/sidecar/v2/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stx: [stxAddress],
      readonly: [
        // sBTC balance
        [SBTC_TOKEN.split(".")[0] + "." + SBTC_TOKEN.split(".")[1],
         "get-balance", principalHex],
        // zsbtc LP balance
        [ZSBTC.split(".")[0] + "." + ZSBTC.split(".")[1],
         "get-balance", principalHex],
      ],
    }),
  });

  if (!res.ok) throw new Error(`stxer batch failed: HTTP ${res.status}`);
  const data = await res.json() as {
    stx: Array<{ Ok?: string; Err?: string }>;
    readonly: Array<{ Ok?: string; Err?: string }>;
  };

  const stxBalance = data.stx?.[0]?.Ok ? parseInt(data.stx[0].Ok, 16) : 0;

  // Parse sBTC balance
  const sbtcHex = data.readonly?.[0]?.Ok;
  const liquid = sbtcHex ? decodeClarityUint(sbtcHex) : 0;

  // Parse zsbtc LP balance
  const zsbtcHex = data.readonly?.[1]?.Ok;
  const zest = zsbtcHex ? decodeClarityUint(zsbtcHex) : 0;

  // v0-4-market position — use Hiro read-only call
  let v0_market = 0;
  try {
    const v0Res = await fetch(
      `${HIRO_API}/v2/contracts/call-read/${V0_MARKET.replace(".", "/")}` +
      `/get-position`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: stxAddress,
          arguments: [
            // principal
            `0x0516${principalHexFromAddress(stxAddress)}`,
            // enabled-mask (u7 = all assets)
            "0x0100000000000000000000000000000007",
          ],
        }),
      },
    );
    if (v0Res.ok) {
      const v0Data = await v0Res.json() as { okay: boolean; result?: string };
      if (v0Data.okay && v0Data.result) {
        // Parse collateral from the tuple — simplified extraction
        // The result is a complex tuple, we extract the collateral amount
        v0_market = extractCollateralFromV0Result(v0Data.result);
      }
    }
  } catch {
    // v0-4-market read failed — use 0, will show in output
  }

  return { liquid, zest, v0_market, stx_ustx: stxBalance };
}

function principalHexFromAddress(address: string): string {
  // c32check decode — simplified for known addresses
  // In production, use @stacks/transactions
  const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const body = address.substring(2); // strip SP/SM prefix
  let bigint = 0n;
  for (const ch of body) {
    const idx = C32.indexOf(ch.toUpperCase());
    if (idx < 0) continue;
    bigint = bigint * 32n + BigInt(idx);
  }
  const hex = bigint.toString(16).padStart(48, "0");
  // Last 8 chars are checksum, first 40 chars (20 bytes) are the hash160
  return hex.substring(0, 40);
}

function decodeC32(address: string): Uint8Array {
  const hex = principalHexFromAddress(address);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function extractCollateralFromV0Result(hex: string): number {
  // v0-4-market get-position returns a tuple with collateral shares
  // This is a simplified parser — looks for the collateral uint in the result
  // The full parser would use deserializeCV from @stacks/transactions
  // For now, return the known value from our last sensor check
  // TODO: implement full Clarity tuple parsing
  return 0; // Will use fallback from health.json
}

function computeAllocations(
  balances: { liquid: number; zest: number; v0_market: number },
  targets: Record<string, number>,
  v0Override?: number,
): Position[] {
  const v0 = v0Override ?? balances.v0_market;
  const total = balances.liquid + balances.zest + v0;
  if (total === 0) return [];

  const positions: Position[] = [
    {
      bucket: "liquid",
      balance_sats: balances.liquid,
      pct: (balances.liquid / total) * 100,
      target_pct: targets.liquid,
      drift_pct: 0,
      action: "hold",
    },
    {
      bucket: "zest",
      balance_sats: balances.zest,
      pct: (balances.zest / total) * 100,
      target_pct: targets.zest,
      drift_pct: 0,
      action: "hold",
    },
    {
      bucket: "v0_market",
      balance_sats: v0,
      pct: (v0 / total) * 100,
      target_pct: targets.v0_market,
      drift_pct: 0,
      action: "hold",
    },
  ];

  for (const p of positions) {
    p.drift_pct = Math.round((p.pct - p.target_pct) * 100) / 100;
    if (p.drift_pct > DRIFT_THRESHOLD_PCT) p.action = "decrease";
    else if (p.drift_pct < -DRIFT_THRESHOLD_PCT) p.action = "increase";
  }

  return positions;
}

function suggestMoves(positions: Position[], total: number): Array<{
  from: string;
  to: string;
  amount_sats: number;
  reason: string;
}> {
  const moves: Array<{ from: string; to: string; amount_sats: number; reason: string }> = [];

  const overweight = positions.filter((p) => p.action === "decrease")
    .sort((a, b) => b.drift_pct - a.drift_pct);
  const underweight = positions.filter((p) => p.action === "increase")
    .sort((a, b) => a.drift_pct - b.drift_pct);

  for (const over of overweight) {
    for (const under of underweight) {
      const overExcess = Math.floor((over.drift_pct / 100) * total);
      const underDeficit = Math.floor((-under.drift_pct / 100) * total);
      let moveAmount = Math.min(overExcess, underDeficit, MAX_SINGLE_MOVE_SATS);

      // Safety: never drain liquid below minimum
      if (over.bucket === "liquid") {
        moveAmount = Math.min(moveAmount, over.balance_sats - MIN_LIQUID_SATS);
      }

      if (moveAmount > 0) {
        moves.push({
          from: over.bucket,
          to: under.bucket,
          amount_sats: moveAmount,
          reason: `${over.bucket} is ${over.drift_pct.toFixed(1)}% over target, ${under.bucket} is ${Math.abs(under.drift_pct).toFixed(1)}% under`,
        });
      }
    }
  }

  return moves;
}

// ── CLI ────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("portfolio-rebalancer")
  .description("Multi-position DeFi portfolio management — read positions, compute drift, suggest rebalances");

// ── doctor ─────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check API connectivity and configuration")
  .action(async () => {
    const checks: Record<string, string> = {};

    // Check stxer
    try {
      const res = await fetch(`${STXER_API}/sidecar/v2/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stx: ["SP000000000000000000002Q6VF78.pox-4"] }),
      });
      checks.stxer = res.ok ? "healthy" : `error: HTTP ${res.status}`;
    } catch (e: unknown) {
      checks.stxer = `error: ${(e as Error).message}`;
    }

    // Check Hiro
    try {
      const res = await fetch(`${HIRO_API}/v2/info`);
      checks.hiro = res.ok ? "healthy" : `error: HTTP ${res.status}`;
    } catch (e: unknown) {
      checks.hiro = `error: ${(e as Error).message}`;
    }

    const allHealthy = Object.values(checks).every((v) => v === "healthy");

    out({
      status: allHealthy ? "success" : "error",
      action: "doctor",
      data: {
        apis: checks,
        targets: DEFAULT_TARGETS,
        safety: {
          min_liquid_sats: MIN_LIQUID_SATS,
          max_single_move_sats: MAX_SINGLE_MOVE_SATS,
          drift_threshold_pct: DRIFT_THRESHOLD_PCT,
        },
        buckets: ["liquid (sBTC)", "zest (zsbtc LP)", "v0_market (collateral)"],
      },
      error: allHealthy ? null : {
        code: "API_DOWN",
        message: "One or more APIs unreachable",
        next: "Check API status and retry",
      },
    });
  });

// ── run ────────────────────────────────────────────────────────────────

const runCmd = program.command("run").description("Portfolio operations");

runCmd
  .command("status")
  .description("Read current portfolio positions and compute allocation drift")
  .requiredOption("--address <stx_address>", "Stacks address to check")
  .option("--v0-override <sats>", "Override v0-4-market balance (for known positions)")
  .option("--target-liquid <pct>", "Target liquid allocation %", String(DEFAULT_TARGETS.liquid))
  .option("--target-zest <pct>", "Target Zest allocation %", String(DEFAULT_TARGETS.zest))
  .option("--target-v0 <pct>", "Target v0-market allocation %", String(DEFAULT_TARGETS.v0_market))
  .action(async (opts: {
    address: string;
    v0Override?: string;
    targetLiquid: string;
    targetZest: string;
    targetV0: string;
  }) => {
    if (!opts.address.startsWith("SP") && !opts.address.startsWith("SM")) {
      errOut("BAD_ADDRESS", "Address must be mainnet Stacks (SP/SM)", "Provide a valid Stacks address");
      return;
    }

    const targets = {
      liquid: parseFloat(opts.targetLiquid),
      zest: parseFloat(opts.targetZest),
      v0_market: parseFloat(opts.targetV0),
    };

    const sum = targets.liquid + targets.zest + targets.v0_market;
    if (Math.abs(sum - 100) > 0.1) {
      errOut("BAD_TARGETS", `Target allocations must sum to 100%, got ${sum}%`, "Adjust --target-liquid, --target-zest, --target-v0");
      return;
    }

    try {
      const balances = await fetchBalances(opts.address);
      const v0Override = opts.v0Override ? parseInt(opts.v0Override, 10) : undefined;
      const positions = computeAllocations(balances, targets, v0Override);
      const total = positions.reduce((s, p) => s + p.balance_sats, 0);
      const moves = suggestMoves(positions, total);

      const needsRebalance = moves.length > 0;

      out({
        status: "success",
        action: "status",
        data: {
          address: opts.address,
          total_sats: total,
          positions,
          needs_rebalance: needsRebalance,
          suggested_moves: moves,
          stx_balance_ustx: balances.stx_ustx,
          note: v0Override
            ? `v0-4-market balance overridden to ${v0Override} sats (on-chain read not yet implemented)`
            : "v0-4-market on-chain read may return 0 — use --v0-override for known positions",
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("FETCH_FAIL", (e as Error).message, "Check address and API connectivity");
    }
  });

runCmd
  .command("rebalance")
  .description("Execute a suggested rebalance move (supply or withdraw)")
  .requiredOption("--from <bucket>", "Source bucket: liquid, zest, v0_market")
  .requiredOption("--to <bucket>", "Destination bucket: liquid, zest, v0_market")
  .requiredOption("--amount <sats>", "Amount in sats to move")
  .option("--dry-run", "Simulate only, do not broadcast", false)
  .action(async (opts: { from: string; to: string; amount: string; dryRun: boolean }) => {
    const amount = parseInt(opts.amount, 10);
    if (isNaN(amount) || amount <= 0) {
      errOut("BAD_AMOUNT", "Amount must be a positive integer", "Provide amount in sats");
      return;
    }
    if (amount > MAX_SINGLE_MOVE_SATS) {
      errOut("OVER_CAP", `Amount ${amount} exceeds safety cap ${MAX_SINGLE_MOVE_SATS}`, `Max single move is ${MAX_SINGLE_MOVE_SATS} sats. Increase cap or reduce amount.`);
      return;
    }

    const validBuckets = ["liquid", "zest", "v0_market"];
    if (!validBuckets.includes(opts.from) || !validBuckets.includes(opts.to)) {
      errOut("BAD_BUCKET", `Invalid bucket. Use: ${validBuckets.join(", ")}`, "Check bucket names");
      return;
    }
    if (opts.from === opts.to) {
      errOut("SAME_BUCKET", "From and to buckets must be different", "Pick different buckets");
      return;
    }

    // Map bucket transitions to contract calls
    const moveMap: Record<string, { contract: string; fn: string; note: string }> = {
      "liquid->zest": {
        contract: BORROW_HELPER,
        fn: "supply",
        note: "Supply sBTC to Zest lending pool (requires Pyth oracle params)",
      },
      "zest->liquid": {
        contract: BORROW_HELPER,
        fn: "withdraw",
        note: "Withdraw sBTC from Zest lending pool",
      },
      "liquid->v0_market": {
        contract: V0_MARKET,
        fn: "deposit",
        note: "Deposit to v0-4-market as collateral",
      },
      "v0_market->liquid": {
        contract: V0_MARKET,
        fn: "withdraw",
        note: "Withdraw collateral from v0-4-market",
      },
      "zest->v0_market": {
        contract: "TWO_STEP",
        fn: "withdraw+deposit",
        note: "Two-step: withdraw from Zest, then deposit to v0-market",
      },
      "v0_market->zest": {
        contract: "TWO_STEP",
        fn: "withdraw+supply",
        note: "Two-step: withdraw from v0-market, then supply to Zest",
      },
    };

    const key = `${opts.from}->${opts.to}`;
    const move = moveMap[key];
    if (!move) {
      errOut("INVALID_MOVE", `No path from ${opts.from} to ${opts.to}`, "Check supported bucket transitions");
      return;
    }

    if (opts.dryRun) {
      out({
        status: "success",
        action: "rebalance-dry-run",
        data: {
          from: opts.from,
          to: opts.to,
          amount_sats: amount,
          contract: move.contract,
          function: move.fn,
          note: move.note,
          would_broadcast: false,
          next_step: "Remove --dry-run to execute. Use defi-tx-simulator to pre-check.",
        },
        error: null,
      });
    } else {
      // For safety, we output the instruction but don't broadcast directly.
      // The agent should use MCP tools (zest_supply, zest_withdraw, etc.) to execute.
      out({
        status: "blocked",
        action: "rebalance",
        data: {
          from: opts.from,
          to: opts.to,
          amount_sats: amount,
          contract: move.contract,
          function: move.fn,
          note: move.note,
          instruction: "Use MCP tools to execute this move. This skill is read-only by design — it computes the rebalance, the agent's MCP tools execute it.",
          mcp_tools: {
            "liquid->zest": "zest_supply",
            "zest->liquid": "zest_withdraw",
            "liquid->v0_market": "call_contract (v0-4-market deposit)",
            "v0_market->liquid": "call_contract (v0-4-market withdraw)",
          },
        },
        error: {
          code: "EXECUTION_DEFERRED",
          message: "Rebalance computed. Use MCP tools to broadcast.",
          next: `Call ${move.fn} on ${move.contract} with amount ${amount}`,
        },
      });
    }
  });

// ── install-packs ──────────────────────────────────────────────────────

program
  .command("install-packs")
  .description("Install dependencies")
  .action(async () => {
    const { execSync } = await import("child_process");
    try {
      execSync("bun add commander", { stdio: "pipe" });
      out({
        status: "success",
        action: "install-packs",
        data: { installed: ["commander"] },
        error: null,
      });
    } catch (e: unknown) {
      errOut("INSTALL_FAIL", (e as Error).message, "Run 'bun add commander' manually");
    }
  });

program.parse();
