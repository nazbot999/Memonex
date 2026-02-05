import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import fg from "fast-glob";
import type { Address } from "viem";

import type { ExtractionSpec, Insight, MemoryPackage, RawItem } from "./types.js";
import { nowIso } from "./utils.js";

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
  ".openclaw",
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
        const st = await fs.stat(abs);
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
      // MVP adapter: read an exported memory file if available.
      // Real OpenClaw integration would call `memory_recall` tool.
      const exported = process.env.MEMONEX_MEMORY_FILE;
      const fallbackPath = path.join(os.homedir(), ".openclaw", "memonex", "demo-memory.txt");
      const p = exported ?? fallbackPath;
      try {
        const text = await fs.readFile(p, "utf8");
        out.push({
          id: `raw:memory:${crypto.randomUUID()}`,
          kind: "memory",
          source: { kind: "openclaw-memory", ref: p },
          timestamp: nowIso(),
          text,
        });
      } catch {
        // ignore if not present
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
}): MemoryPackage {
  const createdAt = nowIso();
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
      chain: "base-sepolia",
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
