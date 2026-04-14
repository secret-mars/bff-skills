#!/usr/bin/env bun

// ─── Configuration ────────────────────────────────────────────────────────────

const SKILL_NAME = "beat-scout";
const REQUEST_TIMEOUT = 10_000;
const NEWS_BASE = "https://aibtc.news";

const ENDPOINTS = {
  beats: `${NEWS_BASE}/api/beats`,
  status: (addr: string) => `${NEWS_BASE}/api/status/${addr}`,
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "ok" | "error";
  action: string;
  data: unknown;
  error?: string;
}

interface Beat {
  slug: string;
  name: string;
  description?: string;
  color?: string;
  status: "active" | "retired" | "pending";
  memberCount?: number;
  claimedBy?: string;
  claimedAt?: string;
  editor?: { address: string; assignedAt: string } | null;
}

interface AgentStatus {
  btcAddress: string;
  displayName?: string;
  signalCount?: number;
  streak?: number;
  earnings?: { totalSats?: number };
  beats?: string[];
}

interface FormattedBeat {
  slug: string;
  name: string;
  status: string;
  memberCount: number;
  hasEditor: boolean;
  editorAddress: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchNews<T>(url: string): Promise<T> {
  // aibtc.news API responses are returned directly (no envelope).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function isBc1q(addr: string): boolean {
  return /^bc1q[02-9ac-hj-np-z]{6,87}$/.test(addr);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
  const start = Date.now();
  try {
    const beats = await fetchNews<Beat[] | { beats: Beat[] }>(ENDPOINTS.beats);
    const list = Array.isArray(beats) ? beats : (beats?.beats ?? []);
    out({
      status: "ok",
      action: "doctor",
      data: {
        endpoint: ENDPOINTS.beats,
        latencyMs: Date.now() - start,
        beatsFound: list.length,
        message: "aibtc.news API reachable",
      },
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    out({
      status: "error",
      action: "doctor",
      data: { endpoint: ENDPOINTS.beats, latencyMs: Date.now() - start },
      error: isTimeout
        ? `aibtc.news timed out after ${REQUEST_TIMEOUT}ms`
        : `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function list(filter: "active" | "all"): Promise<void> {
  try {
    const raw = await fetchNews<Beat[] | { beats: Beat[] }>(ENDPOINTS.beats);
    const beats = Array.isArray(raw) ? raw : (raw?.beats ?? []);
    const filtered = filter === "active" ? beats.filter((b) => b.status === "active") : beats;

    const formatted: FormattedBeat[] = filtered.map((b) => ({
      slug: b.slug,
      name: b.name,
      status: b.status,
      memberCount: b.memberCount ?? 0,
      hasEditor: Boolean(b.editor?.address),
      editorAddress: b.editor?.address ?? null,
    }));

    out({
      status: "ok",
      action: "list",
      data: {
        beats: formatted,
        count: formatted.length,
        filter,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    out({
      status: "error",
      action: "list",
      data: {},
      error: isTimeout
        ? `aibtc.news timed out after ${REQUEST_TIMEOUT}ms`
        : `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function status(address: string): Promise<void> {
  if (!isBc1q(address)) {
    out({
      status: "error",
      action: "status",
      data: {},
      error: `Invalid bc1q address: "${address}". aibtc.news only indexes native SegWit (bc1q) correspondents.`,
    });
    return;
  }

  try {
    const data = await fetchNews<AgentStatus>(ENDPOINTS.status(address));
    out({
      status: "ok",
      action: "status",
      data: {
        btcAddress: data.btcAddress ?? address,
        displayName: data.displayName ?? null,
        signalCount: data.signalCount ?? 0,
        streak: data.streak ?? 0,
        earningsSats: data.earnings?.totalSats ?? 0,
        beatsClaimed: data.beats ?? [],
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    out({
      status: "error",
      action: "status",
      data: { address },
      error: isTimeout
        ? `aibtc.news timed out after ${REQUEST_TIMEOUT}ms`
        : `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ─── CLI Entry ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const filter = args.includes("--all") ? "all" : "active";

  let address = "";
  const addrIdx = args.indexOf("--address");
  if (addrIdx !== -1 && args[addrIdx + 1]) address = args[addrIdx + 1];

  switch (command) {
    case "doctor":
      await doctor();
      break;
    case "list":
      await list(filter);
      break;
    case "status":
      if (!address) {
        out({
          status: "error",
          action: "status",
          data: {},
          error: "Missing --address <bc1q...>. Example: beat-scout.ts status --address bc1qabc...",
        });
        process.exit(1);
      }
      await status(address);
      break;
    default:
      out({
        status: "error",
        action: command ?? "unknown",
        data: { availableCommands: ["doctor", "list", "status"] },
        error: `Unknown command: "${command ?? ""}". Use: doctor | list [--all] | status --address <bc1q...>`,
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
