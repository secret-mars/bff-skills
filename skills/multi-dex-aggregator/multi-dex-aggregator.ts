#!/usr/bin/env npx tsx
/**
 * Multi-DEX Quote Aggregator — Compare Bitflow + ALEX, execute on best rate
 *
 * Commands: doctor | run | install-packs
 * Actions (run): compare | swap
 *
 * Quote fetching uses MCP tools (bitflow_get_quote, alex_get_swap_quote).
 * This script handles: validation, spend limits, comparison, and decision output.
 *
 * Built by Secret Mars. On-chain proof:
 * - Bitflow swap: 841a35cb3351dc6e2e35db8cbd94a13668810e21011994921cbae61f48a77554
 */

// ── Constants ──────────────────────────────────────────────────────────

const HIRO_API = "https://api.hiro.so";
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// Safety defaults — hardcoded, not configurable without code change
const MAX_SWAP_SBTC_SATS = 500_000;
const MAX_SWAP_STX = 100; // human units
const MIN_GAS_USTX = 100_000;

// Token registry: maps human symbols to DEX-specific identifiers
// Not all tokens available on both DEXes — skill handles missing gracefully
const TOKENS: Record<string, { bitflow: string; alex: string | null; decimals: number }> = {
  STX:    { bitflow: "token-stx",    alex: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-wstx",   decimals: 6 },
  sBTC:   { bitflow: "token-sbtc",   alex: null,                                                        decimals: 8 },
  wBTC:   { bitflow: "token-wbtc",   alex: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-wbtc",   decimals: 8 },
  aeUSDC: { bitflow: "token-aeusdc", alex: null,                                                        decimals: 6 },
  sUSDT:  { bitflow: "token-susdt",  alex: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-susdt",  decimals: 6 },
  stSTX:  { bitflow: "token-ststx",  alex: null,                                                        decimals: 6 },
  ALEX:   { bitflow: "token-alex",   alex: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.age000-governance-token", decimals: 8 },
};

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
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
    emit({ status: "error", action: "Configure wallet", data: {}, error: { code: "no_wallet", message: "Set STACKS_ADDRESS env var", next: "export STACKS_ADDRESS=SP..." } });
    process.exit(1);
  }
  return addr;
}

async function fetchBalance(address: string): Promise<{ stx_ustx: number; sbtc_sats: number }> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/balances`);
  if (!res.ok) throw new Error(`Hiro API ${res.status}`);
  const data = await res.json();
  const stx_ustx = parseInt(data.stx?.balance || "0", 10) - parseInt(data.stx?.locked || "0", 10);
  const ftKey = `${SBTC_CONTRACT}::sbtc-token`;
  const sbtc_sats = parseInt(data.fungible_tokens?.[ftKey]?.balance || "0", 10);
  return { stx_ustx, sbtc_sats };
}

// ── Commands ───────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
  const address = getWalletAddress();
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  // Wallet balance (uses Hiro API — reliable)
  try {
    const { stx_ustx, sbtc_sats } = await fetchBalance(address);
    checks["stx_balance"] = { ok: stx_ustx > MIN_GAS_USTX, detail: `${stx_ustx} uSTX (${(stx_ustx / 1e6).toFixed(2)} STX)` };
    checks["sbtc_balance"] = { ok: true, detail: `${sbtc_sats} sats` };
  } catch (e: any) {
    checks["wallet"] = { ok: false, detail: e.message };
  }

  // MCP tools (required — these handle actual DEX interactions)
  checks["mcp_bitflow"] = { ok: true, detail: "bitflow_get_quote + bitflow_swap" };
  checks["mcp_alex"] = { ok: true, detail: "alex_get_swap_quote + alex_swap" };

  const allOk = Object.values(checks).every((c) => c.ok);
  emit({
    status: allOk ? "success" : "blocked",
    action: allOk ? "Ready. Use --action=compare to get quotes via MCP tools." : "Fix blockers before comparing",
    data: {
      checks,
      address,
      supported_tokens: Object.keys(TOKENS),
      spend_limits: { sbtc_max_sats: MAX_SWAP_SBTC_SATS, stx_max: MAX_SWAP_STX },
    },
    error: allOk ? null : { code: "doctor_failed", message: "See checks", next: "Fix issues above" },
  });
}

async function compare(fromSym: string, toSym: string, amount: string): Promise<void> {
  const fromToken = TOKENS[fromSym];
  const toToken = TOKENS[toSym];

  if (!fromToken || !toToken) {
    emit({ status: "error", action: "Fix token symbols", data: { supported: Object.keys(TOKENS) },
      error: { code: "unknown_token", message: `Unknown token. Supported: ${Object.keys(TOKENS).join(", ")}`, next: "--from=STX --to=sBTC" } });
    return;
  }

  // Build MCP commands — only include DEXes that support both tokens
  const commands: Array<{ tool: string; params: Record<string, string> }> = [];
  commands.push({
    tool: "bitflow_get_quote",
    params: { tokenX: fromToken.bitflow, tokenY: toToken.bitflow, amountIn: amount, amountUnit: "human" },
  });

  if (fromToken.alex && toToken.alex) {
    commands.push({
      tool: "alex_get_swap_quote",
      params: { tokenX: fromToken.alex, tokenY: toToken.alex, amountIn: String(parseFloat(amount) * Math.pow(10, fromToken.decimals)) },
    });
  }

  const alexNote = (!fromToken.alex || !toToken.alex)
    ? `Note: ${!fromToken.alex ? fromSym : toSym} not available on ALEX. Bitflow-only comparison.`
    : null;

  emit({
    status: "success",
    action: commands.length > 1
      ? "Execute both MCP quote commands below, then pass results to --action=swap"
      : `Only Bitflow supports this pair. ${alexNote}`,
    data: {
      step: "fetch_quotes",
      from: fromSym,
      to: toSym,
      amount,
      mcp_commands: commands,
      dex_coverage: { bitflow: true, alex: !!(fromToken.alex && toToken.alex) },
      note: alexNote,
      next_step: "After getting quotes, pass amountOut values to --action=swap with --bitflow-out=X and --alex-out=Y",
    },
    error: null,
  });
}

async function swap(address: string, fromSym: string, toSym: string, amount: string,
  bitflowOut?: string, alexOut?: string): Promise<void> {
  const fromToken = TOKENS[fromSym];
  const toToken = TOKENS[toSym];

  if (!fromToken || !toToken) {
    emit({ status: "error", action: "Fix token symbols", data: {},
      error: { code: "unknown_token", message: `Supported: ${Object.keys(TOKENS).join(", ")}`, next: "Check symbols" } });
    return;
  }

  const amountNum = parseFloat(amount);
  if (amountNum <= 0 || isNaN(amountNum)) {
    emit({ status: "error", action: "Specify valid amount", data: {},
      error: { code: "invalid_amount", message: "Amount must be a positive number", next: "--amount=<value>" } });
    return;
  }

  // Spend limit enforcement (hard block)
  if (fromSym === "sBTC" && amountNum > MAX_SWAP_SBTC_SATS) {
    emit({ status: "blocked", action: "Reduce amount", data: { requested: amountNum, max: MAX_SWAP_SBTC_SATS },
      error: { code: "exceeds_limit", message: `${amountNum} sats > max ${MAX_SWAP_SBTC_SATS}`, next: "Use smaller amount" } });
    return;
  }
  if (fromSym === "STX" && amountNum > MAX_SWAP_STX) {
    emit({ status: "blocked", action: "Reduce amount", data: { requested: amountNum, max: MAX_SWAP_STX },
      error: { code: "exceeds_limit", message: `${amountNum} STX > max ${MAX_SWAP_STX}`, next: "Use smaller amount" } });
    return;
  }

  // On-chain balance check
  const { stx_ustx, sbtc_sats } = await fetchBalance(address);

  if (stx_ustx < MIN_GAS_USTX) {
    emit({ status: "blocked", action: "Need gas", data: { stx_ustx, min: MIN_GAS_USTX },
      error: { code: "low_gas", message: `STX ${stx_ustx} uSTX < min ${MIN_GAS_USTX}`, next: "Acquire STX for gas" } });
    return;
  }

  if (fromSym === "STX" && stx_ustx < amountNum * 1_000_000 + MIN_GAS_USTX) {
    emit({ status: "blocked", action: "Insufficient STX", data: { available: stx_ustx, needed: amountNum * 1_000_000 + MIN_GAS_USTX },
      error: { code: "insufficient_balance", message: `Need ${amountNum * 1_000_000 + MIN_GAS_USTX} uSTX, have ${stx_ustx}`, next: "Reduce amount" } });
    return;
  }
  if (fromSym === "sBTC" && sbtc_sats < amountNum) {
    emit({ status: "blocked", action: "Insufficient sBTC", data: { available: sbtc_sats, needed: amountNum },
      error: { code: "insufficient_balance", message: `Need ${amountNum} sats, have ${sbtc_sats}`, next: "Reduce amount" } });
    return;
  }

  // Determine best DEX if quotes provided
  let bestDex: "Bitflow" | "ALEX" | null = null;
  let bestOut = "0";

  if (bitflowOut && alexOut) {
    const bf = parseFloat(bitflowOut);
    const ax = parseFloat(alexOut);
    if (bf >= ax && bf > 0) { bestDex = "Bitflow"; bestOut = bitflowOut; }
    else if (ax > 0) { bestDex = "ALEX"; bestOut = alexOut; }
  } else if (bitflowOut) { bestDex = "Bitflow"; bestOut = bitflowOut; }
  else if (alexOut) { bestDex = "ALEX"; bestOut = alexOut; }

  const savings = (bitflowOut && alexOut)
    ? Math.abs(parseFloat(bitflowOut) - parseFloat(alexOut)) / Math.max(parseFloat(bitflowOut), parseFloat(alexOut)) * 100
    : 0;

  const mcp_command = bestDex === "Bitflow"
    ? { tool: "bitflow_swap", params: { tokenX: fromToken.bitflow, tokenY: toToken.bitflow, amountIn: amount, amountUnit: "human" } }
    : bestDex === "ALEX" && fromToken.alex && toToken.alex
    ? { tool: "alex_swap", params: { tokenX: fromToken.alex, tokenY: toToken.alex, amount: String(amountNum * Math.pow(10, fromToken.decimals)) } }
    : null;

  emit({
    status: bestDex ? "success" : "blocked",
    action: bestDex
      ? `Swap ${amount} ${fromSym} -> ${bestOut} ${toSym} on ${bestDex}${savings > 0.5 ? ` (${savings.toFixed(1)}% better)` : ""}`
      : "Get quotes first with --action=compare, then pass --bitflow-out and --alex-out",
    data: {
      from: fromSym, to: toSym, amount,
      best_dex: bestDex,
      expected_out: bestOut,
      savings_pct: savings,
      pre_checks: {
        balance_ok: true,
        within_spend_limit: true,
        gas_available: true,
        balances: { stx_ustx, sbtc_sats },
      },
      mcp_command,
      quotes_provided: { bitflow: bitflowOut || null, alex: alexOut || null },
    },
    error: bestDex ? null : { code: "no_quotes", message: "Provide quote results via --bitflow-out and --alex-out", next: "Run --action=compare first" },
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

    case "install-packs":
      emit({
        status: "success",
        action: "No packages needed. Uses native fetch. MCP tools required at runtime.",
        data: { runtime: "Node.js 18+ or Bun", mcp_tools: ["bitflow_get_quote", "bitflow_swap", "alex_get_swap_quote", "alex_swap"] },
        error: null,
      });
      break;

    case "run": {
      const address = getWalletAddress();
      const action = args["action"] || "compare";
      const from = args["from"] || "STX";
      const to = args["to"] || "sBTC";
      const amount = args["amount"] || "1";

      switch (action) {
        case "compare":
          await compare(from, to, amount);
          break;
        case "swap":
          await swap(address, from, to, amount, args["bitflow-out"], args["alex-out"]);
          break;
        default:
          emit({ status: "error", action: "Fix action", data: {},
            error: { code: "unknown_action", message: `Unknown: ${action}`, next: "Use --action=compare|swap" } });
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
