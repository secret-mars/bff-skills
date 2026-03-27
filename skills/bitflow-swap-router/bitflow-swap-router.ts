#!/usr/bin/env bun
/**
 * Bitflow Swap Router — Smart swap routing on Bitflow DEX
 *
 * Commands: doctor | run | install-packs
 * Actions (run): quote | swap | tokens
 *
 * Built by Secret Mars — tested on mainnet with real sBTC/STX swaps.
 * On-chain proof: SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE
 *
 * This skill works in two modes:
 * 1. Direct API mode: calls Bitflow REST API (requires api.bitflow.finance access)
 * 2. MCP mode: outputs validated parameters for AIBTC MCP tools (bitflow_get_quote, etc.)
 *
 * The skill auto-detects which mode is available and falls back gracefully.
 */

// ── Constants ──────────────────────────────────────────────────────────

const BITFLOW_API = "https://api.bitflow.finance/api/v1";
const HIRO_API = "https://api.hiro.so";

// Safety defaults
const DEFAULT_MAX_AMOUNT_SATS = 500_000;
const DEFAULT_SLIPPAGE_PCT = 1.0;
const MIN_GAS_USTX = 100_000;
const PRICE_IMPACT_WARN = 2.0;
const PRICE_IMPACT_BLOCK = 10.0;

// Common DeFi tokens — pre-indexed for quick lookup
const DEFI_TOKENS: Record<string, { name: string; symbol: string; decimals: number }> = {
  "token-stx": { name: "Stacks", symbol: "STX", decimals: 6 },
  "token-sbtc": { name: "sBTC", symbol: "sBTC", decimals: 8 },
  "token-aeusdc": { name: "USDC via Allbridge", symbol: "aeUSDC", decimals: 6 },
  "token-susdt": { name: "Bridged USDT", symbol: "sUSDT", decimals: 8 },
  "token-usda": { name: "Arkadiko USD", symbol: "USDA", decimals: 6 },
  "token-usdh": { name: "Hermetica USDh", symbol: "USDh", decimals: 8 },
  "token-welsh": { name: "Corgi Coin", symbol: "WELSH", decimals: 6 },
  "token-charisma": { name: "CHA", symbol: "CHA", decimals: 6 },
  "token-alex": { name: "ALEX Token", symbol: "ALEX", decimals: 8 },
  "token-velar": { name: "Velar", symbol: "VELAR", decimals: 6 },
  "token-xbtc": { name: "Wrapped Bitcoin", symbol: "xBTC", decimals: 8 },
  "token-abtc": { name: "Bridged BTC", symbol: "aBTC", decimals: 8 },
  "token-liabtc": { name: "LiaBTC", symbol: "LiaBTC", decimals: 8 },
  "token-ststx": { name: "Stacked STX", symbol: "stSTX", decimals: 6 },
  "token-listx": { name: "LISA LiSTX", symbol: "LiSTX", decimals: 6 },
  "token-diko": { name: "Arkadiko", symbol: "DIKO", decimals: 6 },
  "token-dog": { name: "DOG GO TO THE MOON", symbol: "DOG", decimals: 5 },
  "token-pbtc": { name: "Pontis Bitcoin", symbol: "pBTC", decimals: 8 },
};

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

function blocked(code: string, message: string, next: string): void {
  output({ status: "blocked", action: "blocked", data: {}, error: { code, message, next } });
}

function fail(code: string, message: string, next: string): void {
  output({ status: "error", action: "error", data: {}, error: { code, message, next } });
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, ...rest] = arg.slice(2).split("=");
      args[key] = rest.join("=") || "true";
    }
  }
  return args;
}

async function checkBitflowApi(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${BITFLOW_API}/tickers`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/stx`);
  if (!res.ok) throw new Error(`Hiro API: ${res.status}`);
  const data = (await res.json()) as { balance: string };
  return parseInt(data.balance, 10);
}

// ── Bitflow API (direct mode) ──────────────────────────────────────────

async function fetchTokensDirect(): Promise<Array<{ id: string; name: string; symbol: string; decimals: number }>> {
  const res = await fetch(`${BITFLOW_API}/tokens`);
  if (!res.ok) throw new Error(`Bitflow tokens: ${res.status}`);
  return (await res.json()) as Array<{ id: string; name: string; symbol: string; decimals: number }>;
}

async function fetchRoutesDirect(tokenX: string, tokenY: string): Promise<string[][]> {
  const params = new URLSearchParams({ tokenX, tokenY });
  const res = await fetch(`${BITFLOW_API}/routes?${params}`);
  if (!res.ok) throw new Error(`Bitflow routes: ${res.status}`);
  return (await res.json()) as string[][];
}

async function fetchQuoteDirect(
  tokenX: string,
  tokenY: string,
  amountIn: string,
  unit: "human" | "base"
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ tokenX, tokenY, amountIn, amountUnit: unit });
  const res = await fetch(`${BITFLOW_API}/quote?${params}`);
  if (!res.ok) throw new Error(`Bitflow quote: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

// ── Commands ───────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
  const checks: Record<string, string> = {};
  let allGood = true;

  // Check wallet env
  const address = process.env.AGENT_STX_ADDRESS || process.env.STX_ADDRESS;
  if (!address) {
    checks.wallet = "MISSING — set AGENT_STX_ADDRESS or STX_ADDRESS";
    allGood = false;
  } else {
    checks.wallet = `${address.slice(0, 8)}...${address.slice(-4)}`;
  }

  // Check STX gas balance
  if (address) {
    try {
      const balance = await getStxBalance(address);
      checks.stx_gas = `${balance} uSTX (${(balance / 1_000_000).toFixed(2)} STX)`;
      if (balance < MIN_GAS_USTX) {
        checks.stx_gas += " — LOW, need >= 100k uSTX";
        allGood = false;
      }
    } catch (e) {
      checks.stx_gas = `ERROR: ${(e as Error).message}`;
      allGood = false;
    }
  }

  // Check Bitflow API accessibility
  const apiReachable = await checkBitflowApi();
  if (apiReachable) {
    checks.bitflow_api = "reachable (direct mode)";
    checks.mode = "direct — will call Bitflow REST API";
  } else {
    checks.bitflow_api = "unreachable (MCP mode)";
    checks.mode = "mcp — use bitflow_get_quote, bitflow_get_routes, bitflow_swap MCP tools";
    // MCP mode is fine — not a blocker
  }

  // Check known DeFi tokens
  checks.token_index = `${Object.keys(DEFI_TOKENS).length} DeFi tokens pre-indexed`;

  if (!allGood) {
    output({
      status: "blocked",
      action: "doctor",
      data: { checks, ready: false },
      error: { code: "preflight-failed", message: "One or more checks failed", next: "Fix issues above, then retry" },
    });
    return;
  }

  output({
    status: "success",
    action: "doctor",
    data: { checks, ready: true },
    error: null,
  });
}

async function actionTokens(): Promise<void> {
  const apiReachable = await checkBitflowApi();

  if (apiReachable) {
    try {
      const tokens = await fetchTokensDirect();
      const defi = tokens.filter((t) => t.id in DEFI_TOKENS);
      output({
        status: "success",
        action: "tokens",
        data: {
          mode: "direct",
          total: tokens.length,
          defi_tokens: defi,
          all_ids: tokens.map((t) => t.id),
        },
        error: null,
      });
      return;
    } catch (e) {
      // Fall through to MCP mode
    }
  }

  // MCP fallback — return pre-indexed tokens + instruction
  output({
    status: "success",
    action: "tokens",
    data: {
      mode: "mcp",
      defi_tokens: Object.entries(DEFI_TOKENS).map(([id, t]) => ({ id, ...t })),
      total_indexed: Object.keys(DEFI_TOKENS).length,
      instruction: "For the full list of 200+ tokens, call the bitflow_get_tokens MCP tool.",
      mcp_call: { tool: "bitflow_get_tokens", params: {} },
    },
    error: null,
  });
}

async function actionQuote(args: Record<string, string>): Promise<void> {
  const from = args.from;
  const to = args.to;
  const amount = args.amount;
  const unit = (args.unit || "base") as "human" | "base";

  if (!from || !to || !amount) {
    fail("missing-args", "Required: --from, --to, --amount", "Example: --from=token-sbtc --to=token-stx --amount=10000 --unit=base");
    return;
  }

  // Validate token IDs
  const fromKnown = from in DEFI_TOKENS;
  const toKnown = to in DEFI_TOKENS;

  const apiReachable = await checkBitflowApi();

  if (apiReachable) {
    try {
      const [routes, quote] = await Promise.all([
        fetchRoutesDirect(from, to),
        fetchQuoteDirect(from, to, amount, unit),
      ]);

      const quoteData = quote as Record<string, unknown>;
      const priceImpact = quoteData.priceImpact as Record<string, unknown> | undefined;
      const impactPct = priceImpact
        ? parseFloat(String(priceImpact.combinedImpactPct || "0"))
        : 0;

      const swapAdvice = getSwapAdvice(impactPct);

      output({
        status: "success",
        action: "quote",
        data: {
          mode: "direct",
          from,
          to,
          amountIn: amount,
          unit,
          expectedOut: quoteData.expectedAmountOut,
          route: quoteData.route,
          routeCount: routes.length,
          allRoutes: routes,
          priceImpact: {
            percent: impactPct,
            severity: priceImpact?.severity || "unknown",
            feeBps: priceImpact?.totalFeeBps || 0,
          },
          swapAdvice,
        },
        error: null,
      });
      return;
    } catch (e) {
      // Fall through to MCP mode
    }
  }

  // MCP mode — output instructions for agent to call MCP tools
  output({
    status: "success",
    action: "quote",
    data: {
      mode: "mcp",
      from,
      to,
      fromToken: fromKnown ? DEFI_TOKENS[from] : null,
      toToken: toKnown ? DEFI_TOKENS[to] : null,
      amountIn: amount,
      unit,
      instruction: "Call these MCP tools in sequence to get the best route:",
      steps: [
        {
          step: 1,
          description: "Get all available routes",
          mcp_call: { tool: "bitflow_get_routes", params: { tokenX: from, tokenY: to } },
        },
        {
          step: 2,
          description: "Get quote with price impact analysis",
          mcp_call: {
            tool: "bitflow_get_quote",
            params: { tokenX: from, tokenY: to, amountIn: amount, amountUnit: unit },
          },
        },
      ],
      safety: {
        maxSlippagePct: DEFAULT_SLIPPAGE_PCT,
        priceImpactWarnThreshold: `${PRICE_IMPACT_WARN}%`,
        priceImpactBlockThreshold: `${PRICE_IMPACT_BLOCK}%`,
        maxAmountSats: DEFAULT_MAX_AMOUNT_SATS,
      },
    },
    error: null,
  });
}

function getSwapAdvice(impactPct: number): string {
  if (impactPct > PRICE_IMPACT_BLOCK) {
    return `BLOCKED — price impact ${impactPct.toFixed(2)}% exceeds ${PRICE_IMPACT_BLOCK}% limit. Reduce trade size.`;
  }
  if (impactPct > PRICE_IMPACT_WARN) {
    return `WARNING — price impact ${impactPct.toFixed(2)}%. Consider splitting into smaller trades.`;
  }
  if (impactPct > 0.5) {
    return `CAUTION — price impact ${impactPct.toFixed(2)}%. Acceptable but monitor.`;
  }
  return `OK — price impact ${impactPct.toFixed(2)}%. Safe to swap.`;
}

async function actionSwap(args: Record<string, string>): Promise<void> {
  const from = args.from;
  const to = args.to;
  const amount = args.amount;
  const unit = (args.unit || "base") as "human" | "base";
  const slippage = parseFloat(args.slippage || String(DEFAULT_SLIPPAGE_PCT));
  const confirm = args.confirm === "true";
  const dryRun = args["dry-run"] === "true";
  const maxAmount = parseInt(args["max-amount"] || String(DEFAULT_MAX_AMOUNT_SATS), 10);

  if (!from || !to || !amount) {
    fail("missing-args", "Required: --from, --to, --amount", "Example: --from=token-sbtc --to=token-stx --amount=10000 --unit=base --confirm");
    return;
  }

  if (!confirm && !dryRun) {
    fail(
      "confirmation-required",
      "Swap requires --confirm flag (or --dry-run to simulate). Run --action=quote first.",
      "Add --confirm to execute or --dry-run to simulate"
    );
    return;
  }

  // Amount limit check
  const amountNum = parseInt(amount, 10);
  if (unit === "base" && amountNum > maxAmount) {
    blocked(
      "amount-exceeds-limit",
      `Amount ${amountNum} exceeds max ${maxAmount}. Use --max-amount to override.`,
      "Reduce amount or increase --max-amount"
    );
    return;
  }

  // Slippage sanity
  if (slippage > 5) {
    blocked(
      "slippage-too-high",
      `Slippage ${slippage}% is dangerously high. Max recommended: 5%.`,
      "Reduce --slippage to 5 or less"
    );
    return;
  }

  if (dryRun) {
    output({
      status: "success",
      action: "swap-dry-run",
      data: {
        from,
        to,
        amountIn: amount,
        unit,
        slippagePct: slippage,
        maxAmount,
        wouldExecute: true,
        instruction: "Dry run complete. Add --confirm (remove --dry-run) to execute.",
      },
      error: null,
    });
    return;
  }

  // Build validated swap parameters
  output({
    status: "success",
    action: "swap",
    data: {
      validated: true,
      from,
      to,
      amountIn: amount,
      unit,
      slippagePct: slippage,
      instruction: "Parameters validated. Execute the swap with the MCP tool below.",
      mcp_call: {
        tool: "bitflow_swap",
        params: {
          tokenX: from,
          tokenY: to,
          amountIn: amount,
          amountUnit: unit,
          slippage,
        },
      },
      safety_checks_passed: {
        amount_within_limit: `${amountNum} <= ${maxAmount}`,
        slippage_reasonable: `${slippage}% <= 5%`,
        confirmation_received: true,
      },
    },
    error: null,
  });
}

// ── Install Packs ──────────────────────────────────────────────────────

async function installPacks(): Promise<void> {
  output({
    status: "success",
    action: "install-packs",
    data: {
      installed: [],
      note: "This skill uses native fetch API (built into Node 18+ and Bun). No additional packages required. For on-chain reads, @stacks/transactions is optional.",
      optional: ["@stacks/transactions", "@stacks/network"],
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
    case "run": {
      const action = args.action;
      switch (action) {
        case "quote":
          await actionQuote(args);
          break;
        case "swap":
          await actionSwap(args);
          break;
        case "tokens":
          await actionTokens();
          break;
        default:
          fail("unknown-action", `Unknown action: ${action}`, "Use: quote | swap | tokens");
      }
      break;
    }
    case "install-packs":
      await installPacks();
      break;
    default:
      fail("unknown-command", `Unknown command: ${command}`, "Use: doctor | run | install-packs");
  }
}

main().catch((e) => {
  fail("fatal", (e as Error).message, "Check logs and retry");
});
