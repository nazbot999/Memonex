import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import fg from "fast-glob";
import type { Address } from "viem";

import type { ExtractionSource, ExtractionSpec, Insight, MemoryPackage, RawItem } from "./types.js";
import { nowIso } from "./utils.js";
import { createGatewayClient } from "./gateway.js";
import { getWorkspacePath, getOpenclawRootDirName } from "./paths.js";

const HARD_DENY_BASENAMES = new Set([
  "SOUL.md",
  "USER.md",
  "MEMORY.md",
  "AGENTS.md",
  ".env",
  ".env.local",
  ".env.production",
]);

const HARD_DENY_DIRS = [
  ".git",
  "node_modules",
  ".ssh",
  ".config",
];

const HARD_DENY_EXTS = new Set([".pem", ".key", ".keystore"]);

export function isDeniedPath(filePath: string): boolean {
  const norm = path.normalize(filePath);
  const base = path.basename(norm);
  if (HARD_DENY_BASENAMES.has(base)) return true;
  if (base.startsWith(".env")) return true;
  const ext = path.extname(base);
  if (HARD_DENY_EXTS.has(ext)) return true;
  const parts = norm.split(path.sep);
  if (parts.some((p) => HARD_DENY_DIRS.includes(p))) return true;
  // Dynamically deny the OpenClaw root directory (handles custom root names)
  const rootDirName = getOpenclawRootDirName();
  if (parts.includes(rootDirName)) return true;
  if (base.startsWith("id_rsa")) return true;
  if (base.toLowerCase().includes("wallet") || base.toLowerCase().includes("secret")) return true;
  return false;
}

export async function extractRawItems(spec: ExtractionSpec): Promise<RawItem[]> {
  const out: RawItem[] = [];

  for (const src of spec.sources) {
    if (src.kind === "files") {
      const include = src.include ?? [];
      if (include.length === 0) continue;

      const exclude = src.exclude ?? [];
      const matches = await fg(include, {
        dot: false,
        onlyFiles: true,
        unique: true,
        ignore: exclude,
        followSymbolicLinks: false,
      });

      for (const m of matches) {
        const abs = path.isAbsolute(m) ? m : path.resolve(process.cwd(), m);
        if (isDeniedPath(abs)) continue;
        // Limit file size to keep the demo responsive.
        const st = await fs.lstat(abs);
        if (!st.isFile()) continue;
        if (st.size > 512 * 1024) continue;
        const text = await fs.readFile(abs, "utf8");
        out.push({
          id: `raw:file:${crypto.randomUUID()}`,
          kind: "file",
          source: { kind: "files", ref: abs },
          timestamp: new Date(st.mtimeMs).toISOString(),
          text,
          metadata: { bytes: st.size },
        });
      }
    }

    if (src.kind === "openclaw-memory") {
      const ocSrc = src as Extract<ExtractionSource, { kind: "openclaw-memory" }>;

      // 1. Read workspace/memory/*.md files
      const workspaceDir = getWorkspacePath();
      const memoryDir = path.join(workspaceDir, "memory");

      try {
        const memFiles = await fg("*.md", { cwd: memoryDir, onlyFiles: true });
        for (const file of memFiles) {
          // Skip memonex imports to avoid circular re-export
          if (file.startsWith("memonex/") || file.startsWith("memonex\\")) continue;

          const abs = path.join(memoryDir, file);

          // TimeRange filter: parse YYYY-MM-DD from filename
          if (spec.timeRange) {
            const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
              const fileDate = dateMatch[1];
              if (spec.timeRange.since && fileDate < spec.timeRange.since.slice(0, 10)) continue;
              if (spec.timeRange.until && fileDate > spec.timeRange.until.slice(0, 10)) continue;
            }
          }

          const st = await fs.lstat(abs);
          if (!st.isFile()) continue;
          if (st.size > 512 * 1024) continue;
          const text = await fs.readFile(abs, "utf8");
          out.push({
            id: `raw:ocmem:${crypto.randomUUID()}`,
            kind: "memory",
            source: { kind: "openclaw-memory", ref: abs },
            timestamp: new Date(st.mtimeMs).toISOString(),
            text,
          });
        }
      } catch {
        // workspace/memory dir may not exist yet
      }

      // 2. Optionally include MEMORY.md (opt-in only)
      if (ocSrc.includeCurated) {
        const memoryMdPath = path.join(workspaceDir, "MEMORY.md");
        try {
          const text = await fs.readFile(memoryMdPath, "utf8");
          out.push({
            id: `raw:ocmem:${crypto.randomUUID()}`,
            kind: "memory",
            source: { kind: "openclaw-memory", ref: memoryMdPath },
            timestamp: nowIso(),
            text,
          });
        } catch {
          // MEMORY.md may not exist
        }
      }

      // 3. Query memory via Gateway API (works with LanceDB or core plugin)
      if (spec.query) {
        try {
          const gateway = await createGatewayClient();
          if (gateway?.available) {
            const results = await gateway.memoryQuery(spec.query, ocSrc.limit ?? 20);
            for (const r of results) {
              out.push({
                id: `raw:gateway:${crypto.randomUUID()}`,
                kind: "memory",
                source: { kind: "openclaw-memory", ref: "gateway-query" },
                timestamp: nowIso(),
                text: r.text,
              });
            }
          }
        } catch {
          // Gateway unavailable — filesystem extraction still works
        }
      }

      // 4. Fallback: legacy MEMONEX_MEMORY_FILE env var (backwards compat)
      const exported = process.env.MEMONEX_MEMORY_FILE;
      if (exported) {
        try {
          const text = await fs.readFile(exported, "utf8");
          out.push({
            id: `raw:ocmem:${crypto.randomUUID()}`,
            kind: "memory",
            source: { kind: "openclaw-memory", ref: exported },
            timestamp: nowIso(),
            text,
          });
        } catch {
          // ignore if not present
        }
      }
    }
  }

  return out;
}

function normalizeForDedup(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

export function curateInsights(rawItems: RawItem[], spec: ExtractionSpec): Insight[] {
  const maxItems = spec.constraints?.maxItems ?? 25;

  const seen = new Set<string>();
  const insights: Insight[] = [];

  for (const item of rawItems) {
    // Split by blank lines to get smaller atoms.
    const chunks = item.text
      .split(/\n\s*\n/g)
      .map((c) => c.trim())
      .filter(Boolean);

    for (const chunk of chunks) {
      if (insights.length >= maxItems) break;
      if (chunk.length < 40) continue;

      const norm = normalizeForDedup(chunk);
      if (seen.has(norm)) continue;
      seen.add(norm);

      const firstLine = chunk.split("\n")[0] ?? chunk;
      const title = firstLine.split(/\s+/).slice(0, 10).join(" ");

      insights.push({
        id: crypto.randomUUID(),
        type: spec.outputStyle === "playbook" || spec.outputStyle === "checklist" ? "playbook" : "fact",
        title: title.length > 8 ? title : `Insight from ${item.kind}`,
        content: chunk,
        confidence: 0.65,
        tags: spec.topics,
        evidence: [{ sourceId: item.id, quote: firstLine.slice(0, 200) }],
        createdAt: item.timestamp,
      });
    }
  }

  return insights;
}

export function buildMemoryPackage(params: {
  spec: ExtractionSpec;
  sellerAddress: Address;
  title: string;
  description?: string;
  topics: string[];
  audience?: MemoryPackage["audience"];
  insights: Insight[];
  redactionSummary: MemoryPackage["redactions"]["summary"];
  network?: MemoryPackage["seller"]["chain"];
}): MemoryPackage {
  const createdAt = nowIso();
  const envNetwork = process.env.MEMONEX_NETWORK?.trim();
  const network = params.network
    ?? (envNetwork === "base" ? "base" : "base-sepolia");

  const pkg: MemoryPackage = {
    schema: "memonex.memorypackage.v1",
    packageId: crypto.randomUUID(),
    title: params.title,
    description: params.description,
    topics: params.topics,
    audience: params.audience ?? "agent",
    createdAt,
    updatedAt: createdAt,
    seller: {
      agentName: process.env.MEMONEX_AGENT_NAME ?? "OpenClaw",
      agentVersion: process.env.MEMONEX_AGENT_VERSION,
      chain: network,
      sellerAddress: params.sellerAddress,
    },
    extraction: {
      spec: params.spec,
      sourceSummary: {
        itemsConsidered: 0,
        itemsUsed: params.insights.length,
        timeSpan: params.spec.timeRange,
      },
    },
    insights: params.insights,
    redactions: {
      applied: true,
      rulesVersion: "privacy.v1",
      summary: params.redactionSummary,
    },
    integrity: {},
    license: {
      terms: "non-exclusive",
      allowedUse: ["agent-internal"],
      prohibitedUse: ["resale-as-is", "doxxing", "model-training-without-consent"],
    },
  };

  return pkg;
}
