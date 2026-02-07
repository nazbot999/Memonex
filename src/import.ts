import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type {
  ImportOptions,
  ImportRecord,
  ImportRegistry,
  ImportResult,
  ImportSafetyReport,
  MemoryPackage,
} from "./types.js";
import {
  computeCanonicalKeccak256,
  ensureDir,
  nowIso,
  readJsonFile,
  writeJsonFile,
} from "./utils.js";
import { scanForThreats, applyThreatActions, formatSafetyReport } from "./import.scanner.js";
import { createGatewayClient, gatewayMemoryStore } from "./gateway.js";

const LANCE_DB_BATCH_DELAY_MS = 100;

function defaultWorkspacePath(): string {
  return process.env.OPENCLAW_WORKSPACE
    ?? path.join(os.homedir(), ".openclaw", "workspace");
}

function registryPath(): string {
  return path.join(os.homedir(), ".openclaw", "memonex", "import-registry.json");
}

function emptySafetyReport(): ImportSafetyReport {
  return {
    flags: [],
    summary: { totalFlagged: 0, blocked: 0, warned: 0, passed: 0, overridden: 0, insightsRemoved: 0 },
    threatScore: 0,
    safeToImport: true,
    reviewedBy: "auto",
    reviewedAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function formatMarkdown(pkg: MemoryPackage, opts: ImportOptions): string {
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);

  lines.push(`# ${pkg.title}`);
  lines.push("");
  lines.push(
    `> Acquired via Memonex marketplace | Seller: ${pkg.seller.agentName} | ${date}`,
  );
  lines.push(
    `> Topics: ${pkg.topics.join(", ")} | Audience: ${pkg.audience} | Insights: ${pkg.insights.length}`,
  );
  lines.push("");

  if (pkg.description) {
    lines.push(pkg.description);
    lines.push("");
  }

  lines.push("## Insights");
  lines.push("");

  for (const insight of pkg.insights) {
    lines.push(`### ${insight.title}`);
    lines.push(
      `**Type:** ${insight.type} | **Confidence:** ${insight.confidence.toFixed(2)} | **Tags:** ${insight.tags.join(", ")}`,
    );
    lines.push("");
    lines.push(insight.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push("## Provenance");
  lines.push("");
  lines.push(`- Package ID: ${pkg.packageId}`);
  if (opts.listingId !== undefined) {
    lines.push(`- Listing ID: ${opts.listingId.toString()}`);
  }
  if (opts.sellerAddress) {
    lines.push(`- Seller: ${opts.sellerAddress} (${pkg.seller.agentName})`);
  }
  if (opts.purchasePrice) {
    lines.push(`- Purchased: ${date} for ${opts.purchasePrice} USDC`);
  }
  if (pkg.integrity.canonicalKeccak256) {
    lines.push(`- Content Hash: ${pkg.integrity.canonicalKeccak256}`);
  }
  lines.push(
    `- License: ${pkg.license.terms} — Allowed: ${pkg.license.allowedUse.join(", ")} | Prohibited: ${pkg.license.prohibitedUse.join(", ")}`,
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Import registry
// ---------------------------------------------------------------------------

async function loadRegistry(): Promise<ImportRegistry> {
  const existing = await readJsonFile<ImportRegistry>(registryPath());
  if (existing && existing.version === 1 && Array.isArray(existing.records)) {
    return existing;
  }
  return { version: 1, records: [] };
}

async function appendRegistryRecord(record: ImportRecord): Promise<void> {
  const registry = await loadRegistry();
  registry.records.push(record);
  await writeJsonFile(registryPath(), registry);
}

// ---------------------------------------------------------------------------
// Main import function
// ---------------------------------------------------------------------------

/**
 * Import a purchased MemoryPackage into the buyer's OpenClaw system.
 *
 * Steps:
 * 0. Safety scan (before any writes)
 * 1. Verify integrity
 * 2. Write markdown to workspace
 * 3. Store in LanceDB via Gateway API
 * 4. Update import registry
 */
export async function importMemoryPackage(
  pkg: MemoryPackage,
  options?: ImportOptions,
): Promise<ImportResult> {
  const opts = options ?? {};
  const warnings: string[] = [];

  // ----- Step 0: Safety scan -----
  let safetyReport: ImportSafetyReport;
  let workingPkg = pkg;

  if (opts.skipSafetyScan) {
    safetyReport = emptySafetyReport();
    warnings.push("Safety scan was skipped");
  } else {
    const flags = scanForThreats(pkg);

    // Allow buyer to override BLOCK flags with forceImport
    if (opts.forceImport) {
      for (const flag of flags) {
        if (flag.action === "BLOCK") {
          flag.overridden = true;
          flag.action = "WARN";
        }
      }
    }

    const { cleaned, report } = applyThreatActions(pkg, flags);
    safetyReport = report;
    workingPkg = cleaned;

    if (report.summary.insightsRemoved > 0) {
      warnings.push(`${report.summary.insightsRemoved} insight(s) blocked by safety scanner`);
    }
    if (!report.safeToImport && !opts.forceImport) {
      // If all insights were blocked, abort
      if (workingPkg.insights.length === 0) {
        return {
          success: false,
          packageId: pkg.packageId,
          markdownPath: "",
          insightsImported: 0,
          insightsBlocked: report.summary.insightsRemoved,
          lanceDbStored: 0,
          integrityVerified: false,
          safetyReport,
          warnings: [...warnings, "All insights blocked — import aborted"],
        };
      }
    }

    if (report.flags.length > 0) {
      console.log(formatSafetyReport(report));
    }
  }

  // ----- Step 1: Verify integrity -----
  let integrityVerified = false;
  if (!opts.skipIntegrityCheck && pkg.integrity.canonicalKeccak256) {
    const recomputed = computeCanonicalKeccak256({ ...pkg, integrity: {} });
    if (recomputed === pkg.integrity.canonicalKeccak256) {
      integrityVerified = true;
    } else {
      warnings.push(
        `Integrity mismatch: expected ${pkg.integrity.canonicalKeccak256}, got ${recomputed}`,
      );
    }
  } else if (opts.skipIntegrityCheck) {
    warnings.push("Integrity check was skipped");
  } else {
    warnings.push("No content hash in package — integrity not verified");
  }

  // ----- Step 2: Write markdown to workspace -----
  const workspaceDir = opts.workspacePath ?? defaultWorkspacePath();
  const importSubdir = opts.importDir ?? "memonex";
  const memoryDir = path.join(workspaceDir, "memory", importSubdir);
  await ensureDir(memoryDir);

  const mdPath = path.join(memoryDir, `${workingPkg.packageId}.md`);
  const markdown = formatMarkdown(workingPkg, opts);
  await fs.writeFile(mdPath, markdown, "utf8");

  // ----- Step 3: Store in LanceDB via Gateway -----
  let lanceDbStored = 0;
  if (!opts.skipLanceDB) {
    const gateway = await createGatewayClient();
    if (gateway?.available) {
      for (const insight of workingPkg.insights) {
        const text = `[Memonex:${workingPkg.packageId}] ${insight.title}: ${insight.content}`;
        const stored = await gateway.memoryStore(text);
        if (stored) lanceDbStored += 1;
        // Small delay to avoid overwhelming the API
        if (workingPkg.insights.length > 1) {
          await new Promise((r) => setTimeout(r, LANCE_DB_BATCH_DELAY_MS));
        }
      }
    } else {
      warnings.push("Gateway unavailable — skipped LanceDB storage (markdown still works)");
    }
  }

  // ----- Step 4: Update import registry -----
  const record: ImportRecord = {
    packageId: workingPkg.packageId,
    listingId: opts.listingId?.toString(),
    title: workingPkg.title,
    topics: workingPkg.topics,
    sellerAddress: opts.sellerAddress,
    sellerAgentName: workingPkg.seller.agentName,
    purchasePrice: opts.purchasePrice,
    insightCount: workingPkg.insights.length,
    importedAt: nowIso(),
    markdownPath: mdPath,
    lanceDbStored,
    contentHash: pkg.integrity.canonicalKeccak256,
    integrityVerified,
    license: {
      terms: workingPkg.license.terms,
      allowedUse: workingPkg.license.allowedUse,
      prohibitedUse: workingPkg.license.prohibitedUse,
    },
  };

  await appendRegistryRecord(record);

  // ----- Step 5: Return result -----
  return {
    success: true,
    packageId: workingPkg.packageId,
    markdownPath: mdPath,
    insightsImported: workingPkg.insights.length,
    insightsBlocked: safetyReport.summary.insightsRemoved,
    lanceDbStored,
    integrityVerified,
    safetyReport,
    warnings,
  };
}
