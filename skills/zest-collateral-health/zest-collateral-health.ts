#!/usr/bin/env bun
/**
 * Zest Collateral Health skill CLI
 * Monitors borrower collateral ratios on Zest Protocol, computes distance-to-liquidation,
 * and emits structured alerts for agents managing leveraged positions.
 *
 * Supply is tracked via zsbtc (the a-token receipt token), not in get-user-reserve-data.
 * Borrow data comes from get-user-reserve-data. Reserve params from get-reserve-state.
 *
 * Usage: bun run skills/zest-collateral-health/zest-collateral-health.ts <subcommand> [options]
 */
import { Command } from "commander";
import {
  hexToCV,
  cvToJSON,
  standardPrincipalCV,
  cvToHex,
} from "@stacks/transactions";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT_MS = 15_000;
const NETWORK = "mainnet";

// Zest Protocol contracts
const ZEST_POOL_BORROW = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3";
const ZSBTC_TOKEN = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0";

// Clarity serialized principal for sBTC token (pre-computed)
const SBTC_CV_HEX = "0x0614f6decc7cfff2a413bd7cd4f53c25ad7fd1899acc0a736274632d746f6b656e";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ReserveState {
  aTokenAddress: string;
  baseLtv: number;
  liquidationThreshold: number;
  liquidationBonus: number;
  totalBorrowsVariable: number;
  currentLiquidityRate: number;
  currentVariableBorrowRate: number;
  lastUpdatedBlock: number;
  supplyCap: number;
}

interface UserPosition {
  zsbtcBalance: number; // supply (from a-token balance)
  principalBorrowBalance: number;
  useAsCollateral: boolean;
}

interface HealthReport {
  network: string;
  address: string;
  supplied: number;
  borrowed: number;
  useAsCollateral: boolean;
  healthFactor: number;
  distanceToLiquidationPct: number;
  maxAdditionalBorrow: number;
  status: "healthy" | "warning" | "danger" | "liquidatable";
  alerts: string[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function callReadOnly(
  contract: string,
  fn: string,
  args: string[],
  sender: string
): Promise<string> {
  const [addr, name] = contract.split(".");
  const url = `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${fn}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, arguments: args }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Hiro API error ${res.status}: ${res.statusText}`);
  const data = (await res.json()) as { okay: boolean; result?: string; cause?: string };
  if (!data.okay) throw new Error(`Contract call failed: ${data.cause || "unknown"}`);
  return data.result!;
}

function tupleField(tuple: Record<string, unknown>, key: string): string | number | boolean {
  const field = (tuple as Record<string, Record<string, unknown>>)[key];
  if (!field) return 0;
  return field.value as string | number | boolean;
}

async function getReserveState(sender: string): Promise<ReserveState> {
  const resultHex = await callReadOnly(
    ZEST_POOL_BORROW,
    "get-reserve-state",
    [SBTC_CV_HEX],
    sender
  );

  const cv = hexToCV(resultHex);
  const json = cvToJSON(cv) as Record<string, Record<string, unknown>>;
  // cvToJSON returns { type, value: { type, value: { field: { type, value } } } }
  const val = (json.value as Record<string, unknown>).value as Record<string, Record<string, unknown>>;

  return {
    aTokenAddress: String(tupleField(val, "a-token-address")),
    baseLtv: Number(tupleField(val, "base-ltv-as-collateral")),
    liquidationThreshold: Number(tupleField(val, "liquidation-threshold")),
    liquidationBonus: Number(tupleField(val, "liquidation-bonus")),
    totalBorrowsVariable: Number(tupleField(val, "total-borrows-variable")),
    currentLiquidityRate: Number(tupleField(val, "current-liquidity-rate")),
    currentVariableBorrowRate: Number(tupleField(val, "current-variable-borrow-rate")),
    lastUpdatedBlock: Number(tupleField(val, "last-updated-block")),
    supplyCap: Number(tupleField(val, "supply-cap")),
  };
}

async function getZsbtcBalance(userAddress: string, sender: string): Promise<number> {
  const userCV = cvToHex(standardPrincipalCV(userAddress));
  const resultHex = await callReadOnly(ZSBTC_TOKEN, "get-balance", [userCV], sender);
  const cv = hexToCV(resultHex);
  const json = cvToJSON(cv) as Record<string, Record<string, unknown>>;
  // Response is (ok uint) — get the inner value
  const inner = json.value as Record<string, unknown>;
  return Number(inner.value ?? 0);
}

async function getUserBorrowData(
  userAddress: string,
  sender: string
): Promise<{ principalBorrowBalance: number; useAsCollateral: boolean }> {
  const userCV = cvToHex(standardPrincipalCV(userAddress));
  const resultHex = await callReadOnly(
    ZEST_POOL_BORROW,
    "get-user-reserve-data",
    [userCV, SBTC_CV_HEX],
    sender
  );

  const cv = hexToCV(resultHex);
  const json = cvToJSON(cv) as Record<string, Record<string, unknown>>;
  const val = json.value as Record<string, Record<string, unknown>>;

  return {
    principalBorrowBalance: Number(tupleField(val, "principal-borrow-balance")),
    useAsCollateral: Boolean(tupleField(val, "use-as-collateral")),
  };
}

async function getUserPosition(
  userAddress: string,
  sender: string
): Promise<UserPosition> {
  const [zsbtcBalance, borrowData] = await Promise.all([
    getZsbtcBalance(userAddress, sender),
    getUserBorrowData(userAddress, sender),
  ]);

  return {
    zsbtcBalance,
    principalBorrowBalance: borrowData.principalBorrowBalance,
    useAsCollateral: borrowData.useAsCollateral,
  };
}

// ---------------------------------------------------------------------------
// Health computation
// ---------------------------------------------------------------------------
function computeHealth(
  position: UserPosition,
  reserveState: ReserveState
): HealthReport {
  const supplied = position.zsbtcBalance;
  const borrowed = position.principalBorrowBalance;
  const useAsCollateral = position.useAsCollateral;

  // Liquidation threshold from on-chain (scaled by 1e8, e.g. 75000000 = 75%)
  const liqThreshold = reserveState.liquidationThreshold / 100_000_000;

  // Health factor: (supplied * liquidation_threshold) / borrowed
  let healthFactor: number;
  if (borrowed === 0) {
    healthFactor = Infinity;
  } else {
    healthFactor = (supplied * liqThreshold) / borrowed;
  }

  // Max borrow before liquidation
  const maxBorrow = supplied * liqThreshold;
  const distanceToLiquidationPct = borrowed > 0
    ? ((maxBorrow - borrowed) / maxBorrow) * 100
    : 100;
  const maxAdditionalBorrow = Math.max(0, Math.round(maxBorrow - borrowed));

  // Status classification
  let status: "healthy" | "warning" | "danger" | "liquidatable";
  if (healthFactor <= 1) {
    status = "liquidatable";
  } else if (healthFactor <= 1.1) {
    status = "danger";
  } else if (healthFactor <= 1.3) {
    status = "warning";
  } else {
    status = "healthy";
  }

  // Alerts
  const alerts: string[] = [];
  if (status === "liquidatable") {
    alerts.push("CRITICAL: Position is liquidatable. Repay debt or add collateral immediately.");
  } else if (status === "danger") {
    alerts.push(`Health factor ${healthFactor.toFixed(3)} is dangerously close to liquidation (< 1.1).`);
  } else if (status === "warning") {
    alerts.push(`Health factor ${healthFactor.toFixed(3)} is below safe threshold (< 1.3). Consider adding collateral.`);
  }
  if (!useAsCollateral && supplied > 0 && borrowed > 0) {
    alerts.push("Collateral flag is disabled. This supply is NOT protecting your borrow position.");
  }
  if (borrowed === 0 && supplied > 0) {
    alerts.push("No active borrows. Position is fully collateralized.");
  }

  return {
    network: NETWORK,
    address: "",
    supplied,
    borrowed,
    useAsCollateral,
    healthFactor: healthFactor === Infinity ? -1 : Number(healthFactor.toFixed(4)),
    distanceToLiquidationPct: Number(distanceToLiquidationPct.toFixed(2)),
    maxAdditionalBorrow,
    status,
    alerts,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function printJson(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("zest-collateral-health")
  .description(
    "Monitor Zest Protocol borrower collateral ratios — health factor, distance-to-liquidation, and alert classification"
  )
  .version("1.0.0");

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
program
  .command("doctor")
  .description("Check environment readiness: Hiro API reachable, Zest contract readable")
  .action(async () => {
    try {
      const checks: { name: string; status: string; detail?: string }[] = [];

      // Check Hiro API
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
        checks.push({ name: "hiro_api", status: "fail", detail: String(e) });
      }

      // Check Zest contract reachable
      try {
        await getReserveState("SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE");
        checks.push({ name: "zest_contract", status: "pass" });
      } catch (e) {
        checks.push({
          name: "zest_contract",
          status: "fail",
          detail: e instanceof Error ? e.message : String(e),
        });
      }

      const allOk = checks.every((c) => c.status === "pass");
      printJson({
        status: allOk ? "success" : "error",
        action: "doctor",
        data: { checks },
        error: allOk ? null : "One or more checks failed",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// check-health
// ---------------------------------------------------------------------------
program
  .command("check-health")
  .description(
    "Check collateral health for a Zest borrower. Returns health factor, distance-to-liquidation, and alerts."
  )
  .requiredOption("--address <addr>", "Stacks address of the borrower")
  .action(async (opts: { address: string }) => {
    try {
      const [reserveState, position] = await Promise.all([
        getReserveState(opts.address),
        getUserPosition(opts.address, opts.address),
      ]);

      const report = computeHealth(position, reserveState);
      report.address = opts.address;

      printJson(report as unknown as Record<string, unknown>);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// reserve-state
// ---------------------------------------------------------------------------
program
  .command("reserve-state")
  .description("Read current sBTC reserve state from Zest pool-borrow contract")
  .action(async () => {
    try {
      const state = await getReserveState("SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE");
      printJson({
        network: NETWORK,
        contract: ZEST_POOL_BORROW,
        asset: "sBTC",
        aTokenAddress: state.aTokenAddress,
        baseLtv: state.baseLtv,
        liquidationThreshold: state.liquidationThreshold,
        liquidationBonus: state.liquidationBonus,
        totalBorrowsVariable: state.totalBorrowsVariable,
        currentLiquidityRate: state.currentLiquidityRate,
        currentVariableBorrowRate: state.currentVariableBorrowRate,
        supplyCap: state.supplyCap,
        lastUpdatedBlock: state.lastUpdatedBlock,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
program.parse(process.argv);
