import fs from "node:fs/promises";

import type { GatewayConfig } from "./types.js";
import { getGatewayConfigPath } from "./paths.js";

const GATEWAY_TIMEOUT_MS = 5000;

/**
 * Auto-discover Gateway config from ~/.openclaw/openclaw.json.
 * Returns null if the config file is missing or doesn't contain gateway settings.
 */
export function resolveGatewayConfig(): Promise<GatewayConfig | null> {
  return resolveGatewayConfigSync();
}

async function resolveGatewayConfigSync(): Promise<GatewayConfig | null> {
  const configPath = getGatewayConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(raw);
    const port = config?.gateway?.port ?? config?.port ?? 18789;
    const token = config?.gateway?.auth?.token ?? config?.auth?.token ?? "";
    if (!token) return null;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      authToken: token,
    };
  } catch {
    return null;
  }
}

/**
 * Invoke a tool on the OpenClaw Gateway API.
 */
export async function invokeGatewayTool(
  config: GatewayConfig,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

    const res = await fetch(`${config.baseUrl}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}),
      },
      body: JSON.stringify({ tool, args }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }

    const json = await res.json();
    return { ok: true, result: json };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Store text in memory via the Gateway API.
 * Tries memory_store (LanceDB plugin) first; silently returns false if unavailable.
 */
export async function gatewayMemoryStore(
  config: GatewayConfig,
  text: string,
): Promise<boolean> {
  const result = await invokeGatewayTool(config, "memory_store", { text });
  return result.ok;
}

/**
 * Query memory via the Gateway API.
 * Tries memory_recall (LanceDB) → memory_search (core) → returns [] if neither available.
 */
export async function gatewayMemoryQuery(
  config: GatewayConfig,
  query: string,
  limit?: number,
): Promise<Array<{ text: string; score?: number }>> {
  // Try LanceDB plugin first
  const lanceResult = await invokeGatewayTool(config, "memory_recall", {
    query,
    limit: limit ?? 20,
  });
  if (lanceResult.ok) {
    return normalizeQueryResult(lanceResult.result);
  }

  // Fallback to core memory_search
  const coreResult = await invokeGatewayTool(config, "memory_search", {
    query,
    limit: limit ?? 20,
  });
  if (coreResult.ok) {
    return normalizeQueryResult(coreResult.result);
  }

  return [];
}

function normalizeQueryResult(raw: unknown): Array<{ text: string; score?: number }> {
  if (!Array.isArray(raw)) {
    if (raw && typeof raw === "object" && "results" in raw && Array.isArray((raw as any).results)) {
      return normalizeQueryResult((raw as any).results);
    }
    return [];
  }
  return raw
    .map((item: any) => {
      if (typeof item === "string") return { text: item };
      if (item && typeof item === "object" && typeof item.text === "string") {
        return { text: item.text, score: typeof item.score === "number" ? item.score : undefined };
      }
      if (item && typeof item === "object" && typeof item.content === "string") {
        return { text: item.content, score: typeof item.score === "number" ? item.score : undefined };
      }
      return null;
    })
    .filter((x): x is { text: string; score?: number } => x !== null);
}

/**
 * Create a convenience gateway client with auto-config.
 * Returns null if Gateway config is unavailable.
 */
export async function createGatewayClient(): Promise<{
  available: boolean;
  config: GatewayConfig;
  memoryStore: (text: string) => Promise<boolean>;
  memoryQuery: (query: string, limit?: number) => Promise<Array<{ text: string; score?: number }>>;
} | null> {
  const config = await resolveGatewayConfig();
  if (!config) return null;

  return {
    available: true,
    config,
    memoryStore: (text: string) => gatewayMemoryStore(config, text),
    memoryQuery: (query: string, limit?: number) => gatewayMemoryQuery(config, query, limit),
  };
}
