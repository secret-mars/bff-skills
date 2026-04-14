#!/usr/bin/env bun

// ─── Configuration ────────────────────────────────────────────────────────────

const SKILL_NAME = "whale-tracker";
const REQUEST_TIMEOUT = 10_000; // 10 seconds
const TENERO_BASE = "https://api.tenero.io";

const ENDPOINTS = {
  whaleTrades: (limit: number) =>
    `${TENERO_BASE}/v1/stacks/market/whale_trades?limit=${limit}`,
  topGainers: (limit: number) =>
    `${TENERO_BASE}/v1/stacks/market/top_gainers?limit=${limit}`,
  topLosers: (limit: number) =>
    `${TENERO_BASE}/v1/stacks/market/top_losers?limit=${limit}`,
};

type TokenMover = TokenGainer;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "ok" | "error";
  action: string;
  data: unknown;
  error?: string;
}

interface WhaleTrade {
  tx_id: string;
  pool_platform: string;
  event_type: "buy" | "sell";
  maker: string;
  base_token: { symbol: string; name: string };
  quote_token: { symbol: string };
  base_token_amount: string | number;
  quote_token_amount: string | number;
  amount_usd: number;
  price_usd: number;
  block_height: number;
  block_time: number; // Tenero returns milliseconds, but this code auto-detects seconds vs ms (see timeAgo).
}

interface WhaleTrades {
  rows: WhaleTrade[];
  next: string | null;
}

interface TokenGainer {
  symbol: string;
  name: string;
  price_usd: number;
  holder_count: number;
  total_liquidity_usd: number;
  metrics: {
    volume_1d_usd: number;
    swaps_1d: number;
    buys_1d: number;
    sells_1d: number;
  };
  price: {
    price_change_1d_pct: number | null;
    price_change_7d_pct: number | null;
  };
}

interface FormattedTrade {
  txId: string;
  platform: string;
  direction: "buy" | "sell";
  pair: string;
  makerShort: string;
  amountUsd: string;
  priceUsd: string;
  timeAgo: string;
  blockHeight: number;
}

interface FormattedGainer {
  symbol: string;
  name: string;
  priceUsd: string;
  change24hPct: string;
  change7dPct: string;
  volume24hUsd: string;
  swaps24h: number;
  buys24h: number;
  sells24h: number;
  liquidityUsd: string;
  holders: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(blockTime: number): string {
  // Tenero historically returns milliseconds, but some Stacks endpoints use Unix seconds.
  // Values < 1e12 are treated as seconds and upconverted.
  const blockTimeMs = blockTime < 1e12 ? blockTime * 1000 : blockTime;
  const nowMs = Date.now();
  const diffSec = Math.floor((nowMs - blockTimeMs) / 1000);

  if (diffSec < 0) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function shortenAddress(addr: string): string {
  if (!addr || addr.length <= 14) return addr ?? "";
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}

function fmtUsd(value: number): string {
  if (!isFinite(value)) return "$0.00";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

async function fetchTenero<T>(url: string): Promise<T> {
  // Tenero API wraps all responses in { data: T } — unwrap and return the inner value.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const json = (await res.json()) as { data: T };
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
  const url = ENDPOINTS.whaleTrades(1);
  const start = Date.now();

  try {
    const data = await fetchTenero<WhaleTrades>(url);
    const latencyMs = Date.now() - start;
    const tradeCount = data?.rows?.length ?? 0;

    out({
      status: "ok",
      action: "doctor",
      data: {
        endpoint: url,
        latencyMs,
        tradesSampled: tradeCount,
        message: "Tenero API is reachable",
      },
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    out({
      status: "error",
      action: "doctor",
      data: { endpoint: url, latencyMs: Date.now() - start },
      error: isTimeout
        ? `Tenero API timed out after ${REQUEST_TIMEOUT}ms`
        : `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function scan(limit: number): Promise<void> {
  const clampedLimit = Math.max(1, Math.min(25, limit));
  const url = ENDPOINTS.whaleTrades(clampedLimit);

  try {
    const data = await fetchTenero<WhaleTrades>(url);
    const rows = Array.isArray(data?.rows) ? data.rows : [];

    const trades: FormattedTrade[] = rows.map((t) => ({
      txId: t.tx_id ? `${t.tx_id.slice(0, 12)}...` : "unknown",
      platform: t.pool_platform ?? "unknown",
      direction: t.event_type,
      pair: `${t.base_token?.symbol ?? "?"}/${t.quote_token?.symbol ?? "?"}`,
      makerShort: shortenAddress(t.maker ?? ""),
      amountUsd: fmtUsd(t.amount_usd ?? 0),
      priceUsd: fmtUsd(t.price_usd ?? 0),
      timeAgo: t.block_time ? timeAgo(t.block_time) : "unknown",
      blockHeight: t.block_height ?? 0,
    }));

    out({
      status: "ok",
      action: "scan",
      data: {
        trades,
        count: trades.length,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    out({
      status: "error",
      action: "scan",
      data: {},
      error: isTimeout
        ? `Tenero API timed out after ${REQUEST_TIMEOUT}ms`
        : `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function formatMover(t: TokenMover): FormattedGainer {
  return {
    symbol: t.symbol ?? "?",
    name: t.name ?? "?",
    priceUsd: `$${(t.price_usd ?? 0).toFixed(6)}`,
    change24hPct: fmtPct(t.price?.price_change_1d_pct),
    change7dPct: fmtPct(t.price?.price_change_7d_pct),
    volume24hUsd: fmtUsd(t.metrics?.volume_1d_usd ?? 0),
    swaps24h: t.metrics?.swaps_1d ?? 0,
    buys24h: t.metrics?.buys_1d ?? 0,
    sells24h: t.metrics?.sells_1d ?? 0,
    liquidityUsd: fmtUsd(t.total_liquidity_usd ?? 0),
    holders: t.holder_count ?? 0,
  };
}

async function movers(action: "gainers" | "losers", limit: number): Promise<void> {
  const clampedLimit = Math.max(1, Math.min(25, limit));
  const url = action === "gainers"
    ? ENDPOINTS.topGainers(clampedLimit)
    : ENDPOINTS.topLosers(clampedLimit);

  try {
    const rows = await fetchTenero<TokenMover[]>(url);
    const items = Array.isArray(rows) ? rows : [];
    const formatted = items.map(formatMover);

    out({
      status: "ok",
      action,
      data: {
        [action]: formatted,
        count: formatted.length,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    out({
      status: "error",
      action,
      data: {},
      error: isTimeout
        ? `Tenero API timed out after ${REQUEST_TIMEOUT}ms`
        : `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ─── CLI Entry ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // Parse --limit flag
  let limit = 10;
  const limitIdx = args.indexOf("--limit");
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    const parsed = parseInt(args[limitIdx + 1], 10);
    if (!isNaN(parsed)) limit = parsed;
  }

  switch (command) {
    case "doctor":
      await doctor();
      break;
    case "scan":
      await scan(limit);
      break;
    case "gainers":
      await movers("gainers", limit);
      break;
    case "losers":
      await movers("losers", limit);
      break;
    default:
      out({
        status: "error",
        action: command ?? "unknown",
        data: { availableCommands: ["doctor", "scan", "gainers", "losers"] },
        error: `Unknown command: "${command ?? ""}". Use: doctor | scan [--limit N] | gainers [--limit N] | losers [--limit N]`,
      });
      process.exit(1);
  }
}

main().catch((err) => {
  out({
    status: "error",
    action: "main",
    data: {},
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
