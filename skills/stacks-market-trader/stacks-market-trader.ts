#!/usr/bin/env bun
/**
 * Stacks Market Trader — read-only prediction market monitor
 *
 * Combines the public REST API at https://api.stacksmarket.app/api/polls with
 * on-chain Hiro reads against SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA.market-factory-v20-bias
 * so agents can list markets, fetch quotes from the LMSR AMM, and inspect positions
 * without signing any transactions.
 *
 * v1 is intentionally read-only. Buy/sell/redeem will ship in a separate v2 skill
 * after the read path is validated in production.
 *
 * Usage: bun run skills/stacks-market-trader/stacks-market-trader.ts <subcommand> [options]
 */
import { Command } from "commander";
import {
  hexToCV,
  cvToJSON,
  uintCV,
  standardPrincipalCV,
  cvToHex,
} from "@stacks/transactions";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STACKS_MARKET_API = "https://api.stacksmarket.app/api";
const HIRO_API = "https://api.hiro.so";
const FACTORY_CONTRACT =
  "SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA.market-factory-v20-bias";
const READ_SENDER = "SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE"; // any mainnet address works for read-only
const FETCH_TIMEOUT_MS = 15_000;
const NETWORK = "mainnet";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface MarketOption {
  text: string;
  percentage: number;
  impliedProbability: number;
  totalVolume: number;
  totalTrades: number;
  _id: string;
}

interface Market {
  _id: string;
  marketId: string;
  title: string;
  description: string;
  category: string;
  subCategory: string;
  image: string;
  options: MarketOption[];
  endDate: string;
  isActive: boolean;
  isResolved: boolean;
  winningOption: unknown;
  totalVolume: number;
  totalTrades: number;
  uniqueTraders: number;
  featured: boolean;
  trending: boolean;
  rules: string;
  createdAt: string;
  updatedAt: string;
}

interface PollsResponse {
  polls: Market[];
  pagination: {
    currentPage: number;
    totalPages: number;
    total: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

type SkillResponse = {
  status: "success" | "error";
  action: string;
  data: Record<string, unknown> | null;
  error: string | null;
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Stacks Market API error ${res.status} ${res.statusText}: ${body.slice(0, 200)}`
    );
  }
  return (await res.json()) as T;
}

async function callReadOnly(fn: string, args: string[]): Promise<string> {
  const [addr, name] = FACTORY_CONTRACT.split(".");
  const url = `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${fn}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: READ_SENDER, arguments: args }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Hiro API error ${res.status}: ${res.statusText}`);
  }
  const data = (await res.json()) as {
    okay: boolean;
    result?: string;
    cause?: string;
  };
  if (!data.okay) {
    throw new Error(`Contract call failed (${fn}): ${data.cause || "unknown"}`);
  }
  return data.result!;
}

// ---------------------------------------------------------------------------
// Market filtering
// ---------------------------------------------------------------------------
type StatusFilter = "open" | "closed" | "resolved" | "all";

function applyStatusFilter(markets: Market[], status: StatusFilter): Market[] {
  const now = Date.now();
  return markets.filter((m) => {
    const endMs = new Date(m.endDate).getTime();
    switch (status) {
      case "open":
        return m.isActive && !m.isResolved && endMs > now;
      case "closed":
        return !m.isActive || (endMs <= now && !m.isResolved);
      case "resolved":
        return m.isResolved;
      case "all":
        return true;
    }
  });
}

function summarizeMarket(m: Market): Record<string, unknown> {
  return {
    marketId: m.marketId,
    id: m._id,
    title: m.title,
    category: m.category,
    subCategory: m.subCategory,
    endDate: m.endDate,
    isActive: m.isActive,
    isResolved: m.isResolved,
    featured: m.featured,
    trending: m.trending,
    totalVolume: m.totalVolume,
    totalTrades: m.totalTrades,
    uniqueTraders: m.uniqueTraders,
    options: m.options.map((o) => ({
      text: o.text,
      impliedProbability: o.impliedProbability,
      totalVolume: o.totalVolume,
      totalTrades: o.totalTrades,
    })),
  };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function printSuccess(
  action: string,
  data: Record<string, unknown>
): void {
  const response: SkillResponse = {
    status: "success",
    action,
    data,
    error: null,
  };
  console.log(JSON.stringify(response, null, 2));
}

function printError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const response: SkillResponse = {
    status: "error",
    action,
    data: null,
    error: message,
  };
  console.log(JSON.stringify(response, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Clarity decoding helpers
// ---------------------------------------------------------------------------
type ClarityValue = { type?: string; value?: unknown; success?: boolean };

function decodeTuple(resultHex: string): Record<string, string> {
  const cv = hexToCV(resultHex);
  const json = cvToJSON(cv) as ClarityValue;
  // Expect (ok (tuple ...))
  const inner = (json.value as ClarityValue).value as Record<
    string,
    ClarityValue
  >;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inner)) {
    out[k] = String(v.value);
  }
  return out;
}

function decodeUint(resultHex: string): number {
  const cv = hexToCV(resultHex);
  const json = cvToJSON(cv) as ClarityValue;
  // Handles (ok uint) and bare uint
  const raw =
    typeof (json.value as ClarityValue)?.value !== "undefined"
      ? (json.value as ClarityValue).value
      : json.value;
  return Number(raw ?? 0);
}

function decodeBareTuple(resultHex: string): Record<string, unknown> {
  const cv = hexToCV(resultHex);
  const json = cvToJSON(cv) as ClarityValue;
  const inner = json.value as Record<string, ClarityValue>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inner)) {
    if (v.type === "bool") out[k] = v.value;
    else out[k] = String(v.value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("stacks-market-trader")
  .description(
    "Read-only monitoring and analysis for stacksmarket.app prediction markets — list, get, quote, and position"
  )
  .version("1.0.0");

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
program
  .command("doctor")
  .description(
    "Check environment readiness: Stacks Market API reachable, Hiro API reachable, factory contract readable"
  )
  .action(async () => {
    const action = "doctor";
    const checks: { name: string; status: string; detail: string }[] = [];

    // Stacks Market API
    try {
      const data = await fetchJson<PollsResponse>(
        `${STACKS_MARKET_API}/polls?limit=1`
      );
      checks.push({
        name: "stacks_market_api",
        status: "pass",
        detail: `200 OK, ${data.pagination.total} markets total`,
      });
    } catch (e) {
      checks.push({
        name: "stacks_market_api",
        status: "fail",
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    // Hiro API
    try {
      const res = await fetch(`${HIRO_API}/v2/info`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      checks.push({
        name: "hiro_api",
        status: res.ok ? "pass" : "fail",
        detail: res.ok ? `${res.status} OK` : `${res.status} ${res.statusText}`,
      });
    } catch (e) {
      checks.push({
        name: "hiro_api",
        status: "fail",
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    // Factory contract reachable
    try {
      const resultHex = await callReadOnly("get-admin", []);
      const cv = hexToCV(resultHex);
      const json = cvToJSON(cv) as ClarityValue;
      const admin = (json.value as ClarityValue).value ?? json.value;
      checks.push({
        name: "factory_contract",
        status: "pass",
        detail: `get-admin readable (${String(admin).slice(0, 60)})`,
      });
    } catch (e) {
      checks.push({
        name: "factory_contract",
        status: "fail",
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    const allOk = checks.every((c) => c.status === "pass");
    const response: SkillResponse = {
      status: allOk ? "success" : "error",
      action,
      data: { checks, contract: FACTORY_CONTRACT, network: NETWORK },
      error: allOk ? null : "One or more checks failed",
    };
    console.log(JSON.stringify(response, null, 2));
    if (!allOk) process.exit(1);
  });

// ---------------------------------------------------------------------------
// list-markets
// ---------------------------------------------------------------------------
program
  .command("list-markets")
  .description("List prediction markets with optional filters")
  .option(
    "--status <status>",
    "Filter by status: open | closed | resolved | all",
    "open"
  )
  .option("--category <category>", "Filter by category (e.g. Sports, Crypto)")
  .option("--featured", "Only featured markets", false)
  .option("--limit <n>", "Max markets to return after filtering", "20")
  .action(
    async (opts: {
      status: string;
      category?: string;
      featured: boolean;
      limit: string;
    }) => {
      const action = "list-markets";
      try {
        const status = opts.status as StatusFilter;
        if (!["open", "closed", "resolved", "all"].includes(status)) {
          throw new Error(
            `Invalid --status '${opts.status}'. Expected open|closed|resolved|all`
          );
        }
        const limit = Number(opts.limit);
        if (!Number.isFinite(limit) || limit < 1) {
          throw new Error(`Invalid --limit '${opts.limit}'`);
        }

        // Fetch a generous page from the API, filter client-side for `status`.
        // The upstream ignores the `status` query param, so we overfetch and trim.
        const params = new URLSearchParams();
        params.set("limit", "100");
        if (opts.category) params.set("category", opts.category);
        if (opts.featured) params.set("featured", "true");

        const page = await fetchJson<PollsResponse>(
          `${STACKS_MARKET_API}/polls?${params.toString()}`
        );
        const filtered = applyStatusFilter(page.polls, status).slice(0, limit);

        printSuccess(action, {
          network: NETWORK,
          filters: {
            status,
            category: opts.category ?? null,
            featured: opts.featured,
            limit,
          },
          count: filtered.length,
          totalAvailable: page.pagination.total,
          markets: filtered.map(summarizeMarket),
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        printError(action, e);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-market
// ---------------------------------------------------------------------------
program
  .command("get-market")
  .description("Get full details for a single market by marketId")
  .requiredOption("--market-id <id>", "Numeric marketId (epoch ms string)")
  .action(async (opts: { marketId: string }) => {
    const action = "get-market";
    try {
      if (!/^\d+$/.test(opts.marketId)) {
        throw new Error(
          `Invalid --market-id '${opts.marketId}'. Expected numeric epoch-ms string`
        );
      }
      // The /api/polls/{id} route expects the Mongo _id, not the marketId.
      // We therefore look up by marketId via the list endpoint, which serves
      // it fast even without a dedicated filter (the dataset is small).
      const page = await fetchJson<PollsResponse>(
        `${STACKS_MARKET_API}/polls?limit=500`
      );
      const match = page.polls.find((m) => m.marketId === opts.marketId);
      if (!match) {
        throw new Error(`market not found: ${opts.marketId}`);
      }
      const endMs = new Date(match.endDate).getTime();
      const isOpen = match.isActive && !match.isResolved && endMs > Date.now();

      printSuccess(action, {
        network: NETWORK,
        market: match,
        isOpen,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      printError(action, e);
    }
  });

// ---------------------------------------------------------------------------
// quote
// ---------------------------------------------------------------------------
program
  .command("quote")
  .description(
    "Get a buy or sell quote from the LMSR factory contract (read-only)"
  )
  .requiredOption("--market-id <id>", "Numeric marketId")
  .requiredOption("--option <yes|no>", "Which side to trade")
  .requiredOption("--action <buy|sell>", "Quote direction")
  .requiredOption("--amount <units>", "Integer share amount (smallest unit)")
  .action(
    async (opts: {
      marketId: string;
      option: string;
      action: string;
      amount: string;
    }) => {
      const action = "quote";
      try {
        if (!/^\d+$/.test(opts.marketId)) {
          throw new Error(`Invalid --market-id '${opts.marketId}'`);
        }
        if (!["yes", "no"].includes(opts.option)) {
          throw new Error(`Invalid --option '${opts.option}'. Expected yes|no`);
        }
        if (!["buy", "sell"].includes(opts.action)) {
          throw new Error(
            `Invalid --action '${opts.action}'. Expected buy|sell`
          );
        }
        if (!/^\d+$/.test(opts.amount)) {
          throw new Error(
            `Invalid --amount '${opts.amount}'. Expected positive integer`
          );
        }

        const fn = `quote-${opts.action}-${opts.option}`; // e.g. quote-buy-yes
        const marketArg = cvToHex(uintCV(BigInt(opts.marketId)));
        const amountArg = cvToHex(uintCV(BigInt(opts.amount)));
        const resultHex = await callReadOnly(fn, [marketArg, amountArg]);

        const cv = hexToCV(resultHex);
        const repr = cvToJSON(cv);
        const decoded = decodeTuple(resultHex);

        printSuccess(action, {
          network: NETWORK,
          marketId: opts.marketId,
          option: opts.option,
          action: opts.action,
          amount: Number(opts.amount),
          contract: FACTORY_CONTRACT,
          function: fn,
          raw: repr,
          decoded,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        printError(action, e);
      }
    }
  );

// ---------------------------------------------------------------------------
// position
// ---------------------------------------------------------------------------
program
  .command("position")
  .description(
    "Check YES and NO share balances for a Stacks address on a market"
  )
  .requiredOption("--market-id <id>", "Numeric marketId")
  .requiredOption("--address <stx>", "Stacks mainnet address (SP...)")
  .action(async (opts: { marketId: string; address: string }) => {
    const action = "position";
    try {
      if (!/^\d+$/.test(opts.marketId)) {
        throw new Error(`Invalid --market-id '${opts.marketId}'`);
      }
      if (!/^SP[0-9A-Z]{37,39}$/.test(opts.address)) {
        throw new Error(
          `Invalid --address '${opts.address}'. Expected mainnet SP... address`
        );
      }
      const marketArg = cvToHex(uintCV(BigInt(opts.marketId)));
      const userArg = cvToHex(standardPrincipalCV(opts.address));

      const [yesHex, noHex, spentHex, claimHex] = await Promise.all([
        callReadOnly("get-yes-balance", [marketArg, userArg]),
        callReadOnly("get-no-balance", [marketArg, userArg]),
        callReadOnly("get-spent", [marketArg, userArg]),
        callReadOnly("get-user-claimable", [marketArg, userArg]),
      ]);

      const claim = decodeBareTuple(claimHex);

      printSuccess(action, {
        network: NETWORK,
        contract: FACTORY_CONTRACT,
        marketId: opts.marketId,
        address: opts.address,
        yesShares: decodeUint(yesHex),
        noShares: decodeUint(noHex),
        spentMicroStx: decodeUint(spentHex),
        claim: {
          canRedeem: claim.canRedeem,
          claimableMicroStx: Number(claim.claimable ?? 0),
          status: claim.status,
          outcome: claim.outcome,
          winningShares: Number(claim.winningShares ?? 0),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      printError(action, e);
    }
  });

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------
program
  .command("search")
  .description("Search markets by keyword across title and description")
  .requiredOption("--query <string>", "Search keyword")
  .option("--limit <n>", "Max results", "20")
  .action(async (opts: { query: string; limit: string }) => {
    const action = "search";
    try {
      if (!opts.query || !opts.query.trim()) {
        throw new Error("Empty --query");
      }
      const limit = Number(opts.limit);
      if (!Number.isFinite(limit) || limit < 1) {
        throw new Error(`Invalid --limit '${opts.limit}'`);
      }
      const params = new URLSearchParams({
        search: opts.query,
        limit: String(Math.max(limit, 50)),
      });
      const page = await fetchJson<PollsResponse>(
        `${STACKS_MARKET_API}/polls?${params.toString()}`
      );
      const trimmed = page.polls.slice(0, limit);

      printSuccess(action, {
        network: NETWORK,
        query: opts.query,
        count: trimmed.length,
        totalAvailable: page.pagination.total,
        markets: trimmed.map(summarizeMarket),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      printError(action, e);
    }
  });

program.parse(process.argv);
