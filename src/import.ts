import fs from "node:fs/promises";
import path from "node:path";

import type {
  ImportOptions,
  ImportRecord,
  ImportRegistry,
  ImportResult,
  ImportSafetyReport,
  ImprintMeta,
  MemoryPackage,
} from "./types.js";
import {
  computeCanonicalKeccak256,
  ensureDir,
  nowIso,
  readJsonFile,
  writeJsonFile,
} from "./utils.js";
import {
  scanForThreatsV2,
  applyThreatActions,
  formatSafetyReport,
} from "./import.scanner.js";
import { scanForPrivacy, applyPrivacyActions } from "./privacy.scanner.js";
import { createGatewayClient, gatewayMemoryStore } from "./gateway.js";
import { getWorkspacePath, getImportRegistryPath } from "./paths.js";

const LANCE_DB_BATCH_DELAY_MS = 100;

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

function isImprintMeta(meta: MemoryPackage["meta"]): meta is ImprintMeta {
  return Boolean(meta && "contentType" in meta && meta.contentType === "imprint");
}

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

function formatImprintMarkdown(
  pkg: MemoryPackage,
  meta: ImprintMeta | undefined,
  opts: ImportOptions,
): string {
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);
  const rarity = meta?.rarity ?? "common";
  const strength = meta?.strength ?? "medium";
  const traits = meta?.traits ?? pkg.topics;
  const activationTriggers = meta?.activationTriggers ?? [];
  const catchphrases = meta?.catchphrases ?? [];
  const behavioralEffects = meta?.behavioralEffects ?? [];
  const leakinessPct = meta?.leakiness !== undefined ? meta.leakiness * 100 : 0;

  // Metadata header
  lines.push(`# ${pkg.title}`);
  lines.push("");
  lines.push(`> Imprint | Rarity: ${rarity} | Strength: ${strength} | Acquired via Memonex | ${date}`);
  lines.push(`> Traits: ${traits.join(", ")}`);
  if (meta?.series) {
    lines.push(`> Series: ${meta.series}`);
  }
  lines.push(`> Leakiness: ${leakinessPct}%`);
  lines.push("");

  // Section: The Memory
  lines.push("## The Memory");
  lines.push("");
  const experientialText = pkg.insights
    .map((insight) => insight.content.trim())
    .filter(Boolean)
    .join("\n\n");
  if (experientialText) {
    lines.push(experientialText);
  } else if (pkg.description) {
    lines.push(pkg.description);
  }
  lines.push("");

  // Section: How This Affects Me
  lines.push("## How This Affects Me");
  lines.push("");
  for (const effect of behavioralEffects) {
    lines.push(`- ${effect}`);
  }
  if (catchphrases.length > 0) {
    lines.push("");
    lines.push(`**Catchphrases:** ${catchphrases.map((p) => `"${p}"`).join(", ")}`);
  }
  lines.push("");

  // Section: Activation Triggers
  lines.push("## Activation Triggers");
  lines.push("");
  for (const trigger of activationTriggers) {
    lines.push(`- ${trigger}`);
  }
  lines.push("");

  // Forbidden contexts (machine-parseable comment)
  if (meta?.forbiddenContexts && meta.forbiddenContexts.length > 0) {
    lines.push(`<!-- forbiddenContexts: ${meta.forbiddenContexts.join(", ")} -->`);
    lines.push("");
  }

  // Provenance
  lines.push("## Provenance");
  lines.push("");
  lines.push(`- Package ID: ${pkg.packageId}`);
  if (opts.listingId !== undefined) {
    lines.push(`- Listing ID: ${opts.listingId.toString()}`);
  }
  if (opts.sellerAddress) {
    lines.push(`- Seller: ${opts.sellerAddress} (${pkg.seller.agentName})`);
  }
  if (pkg.integrity.canonicalKeccak256) {
    lines.push(`- Content Hash: ${pkg.integrity.canonicalKeccak256}`);
  }
  lines.push("");

  return lines.join("\n");
}

function truncateForSummary(text: string, maxChars = 100): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Imprint helpers: strength routing, ACTIVE-IMPRINTS.md, compatibility
// ---------------------------------------------------------------------------

const MAX_ACTIVE_IMPRINTS = 5;

function imprintSubdirForStrength(strength: string): string {
  if (strength === "subtle") return path.join("memonex", "imprints", "archive");
  return path.join("memonex", "imprints");
}

function activeImprintsPath(workspaceDir: string): string {
  return path.join(workspaceDir, "memory", "memonex", "ACTIVE-IMPRINTS.md");
}

type ActiveImprintEntry = { packageId: string; title: string; series?: string };

async function readActiveImprints(workspaceDir: string): Promise<ActiveImprintEntry[]> {
  const filePath = activeImprintsPath(workspaceDir);
  try {
    const content = await fs.readFile(filePath, "utf8");
    const entries: ActiveImprintEntry[] = [];
    for (const line of content.split("\n")) {
      const match = line.match(/^- \*\*(.+?)\*\* \(`(.+?)`\)(?:\s+\[series: (.+?)\])?/);
      if (match) {
        entries.push({ packageId: match[2], title: match[1], series: match[3] });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function writeActiveImprints(workspaceDir: string, entries: ActiveImprintEntry[]): Promise<void> {
  const lines = [
    "# Active Imprints",
    "",
    "> Imprints currently influencing personality. Max 5 slots.",
    "",
  ];
  for (const entry of entries) {
    const seriesTag = entry.series ? ` [series: ${entry.series}]` : "";
    lines.push(`- **${entry.title}** (\`${entry.packageId}\`)${seriesTag}`);
  }
  lines.push("");
  const filePath = activeImprintsPath(workspaceDir);
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, lines.join("\n"), "utf8");
}

async function updateActiveImprints(
  workspaceDir: string,
  pkg: MemoryPackage,
  meta: ImprintMeta | undefined,
  warnings: string[],
): Promise<string> {
  const strength = meta?.strength ?? "medium";
  if (strength !== "strong") return strength;

  const entries = await readActiveImprints(workspaceDir);
  if (entries.length >= MAX_ACTIVE_IMPRINTS) {
    warnings.push(
      `ACTIVE-IMPRINTS.md is full (${MAX_ACTIVE_IMPRINTS} slots). Importing as medium strength instead.`,
    );
    return "medium";
  }

  entries.push({ packageId: pkg.packageId, title: pkg.title, series: meta?.series });
  await writeActiveImprints(workspaceDir, entries);
  return "strong";
}

function checkImprintCompatibility(
  existingRecords: ImportRecord[],
  newMeta: ImprintMeta | undefined,
  warnings: string[],
): void {
  if (!newMeta?.compatibilityTags || newMeta.compatibilityTags.length === 0) return;

  const newTags = new Set(newMeta.compatibilityTags);

  for (const record of existingRecords) {
    if (record.contentType !== "imprint") continue;
    // We don't have stored compatibilityTags in registry, so skip deep checks.
    // This is advisory — just note we have existing imprints of same series.
  }

  // Check for synergy/conflict tag conventions: +tag = synergy, -tag = conflict
  const synergies: string[] = [];
  const conflicts: string[] = [];
  for (const tag of newTags) {
    if (tag.startsWith("+")) synergies.push(tag.slice(1));
    else if (tag.startsWith("-")) conflicts.push(tag.slice(1));
  }

  if (synergies.length > 0) {
    warnings.push(`Imprint synergies: ${synergies.join(", ")}`);
  }
  if (conflicts.length > 0) {
    warnings.push(`Imprint conflicts: ${conflicts.join(", ")}`);
  }
}

function checkSeriesProgress(
  existingRecords: ImportRecord[],
  meta: ImprintMeta | undefined,
  warnings: string[],
): void {
  if (!meta?.series) return;
  const seriesImprints = existingRecords.filter(
    (r) => r.contentType === "imprint" && r.series === meta.series,
  );
  if (seriesImprints.length > 0) {
    warnings.push(
      `Series "${meta.series}": you now have ${seriesImprints.length + 1} imprint(s) from this collection.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Import registry
// ---------------------------------------------------------------------------

async function loadRegistry(): Promise<ImportRegistry> {
  const existing = await readJsonFile<ImportRegistry>(getImportRegistryPath());
  if (existing && existing.version === 1 && Array.isArray(existing.records)) {
    return existing;
  }
  return { version: 1, records: [] };
}

async function appendRegistryRecord(record: ImportRecord): Promise<void> {
  const registry = await loadRegistry();
  registry.records.push(record);
  await writeJsonFile(getImportRegistryPath(), registry);
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
 * 4. Series + compatibility checks (imprints only)
 * 5. Update import registry
 * 6. Integrate purchase into agent memory files
 */
export async function importMemoryPackage(
  pkg: MemoryPackage,
  options?: ImportOptions,
): Promise<ImportResult> {
  const opts = options ?? {};
  const warnings: string[] = [];

  // ----- Step 0: Safety scan (V2 direct) -----
  let safetyReport: ImportSafetyReport;
  let workingPkg = pkg;

  if (opts.skipSafetyScan) {
    safetyReport = emptySafetyReport();
    warnings.push("Safety scan was skipped");
  } else {
    const scanResult = scanForThreatsV2(pkg, { contentType: opts.contentType });

    // Allow buyer to override BLOCK flags with forceImport
    if (opts.forceImport) {
      for (const flag of scanResult.flags) {
        if (flag.action === "BLOCK") {
          flag.overridden = true;
          flag.action = "WARN";
        }
      }
    }

    // Convert V2 flags to legacy format for applyThreatActions
    const legacyFlags = scanResult.flags.map((f) => ({
      id: f.id,
      level: (f.severity === "critical" ? "danger" : f.severity === "low" ? "info" : "warning") as import("./types.js").ThreatLevel,
      category: f.category,
      pattern: f.message,
      location: f.location,
      snippet: f.snippet,
      action: f.action,
      overridden: f.overridden,
    }));

    const { cleaned, report } = applyThreatActions(pkg, legacyFlags);
    safetyReport = report;
    workingPkg = cleaned;

    if (report.summary.insightsRemoved > 0) {
      warnings.push(`${report.summary.insightsRemoved} insight(s) blocked by safety scanner`);
    }
    if (!report.safeToImport && !opts.forceImport) {
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

  // ----- Step 0b: Privacy scan (optional) -----
  if (!opts.skipPrivacyScan && !opts.skipSafetyScan) {
    const privacyFlags = scanForPrivacy(workingPkg);
    if (privacyFlags.length > 0) {
      const { cleaned: privacyCleaned } = applyPrivacyActions(workingPkg, privacyFlags);
      workingPkg = privacyCleaned;
      warnings.push(`Privacy scan redacted ${privacyFlags.filter((f) => f.action === "REDACT").length} item(s)`);
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
  const workspaceDir = opts.workspacePath ?? getWorkspacePath();
  const imprintMeta = isImprintMeta(workingPkg.meta) ? workingPkg.meta : undefined;
  const isImprint = opts.contentType === "imprint" || Boolean(imprintMeta);

  let importSubdir: string;
  let effectiveStrength: string | undefined;
  if (opts.importDir) {
    importSubdir = opts.importDir;
  } else if (isImprint) {
    // C1: strength-based routing + C2: active imprints management
    effectiveStrength = await updateActiveImprints(workspaceDir, workingPkg, imprintMeta, warnings);
    importSubdir = imprintSubdirForStrength(effectiveStrength);
  } else {
    importSubdir = "memonex";
  }

  const memoryDir = path.join(workspaceDir, "memory", importSubdir);
  await ensureDir(memoryDir);

  const mdPath = path.join(memoryDir, `${workingPkg.packageId}.md`);
  const markdown = isImprint
    ? formatImprintMarkdown(workingPkg, imprintMeta, opts)
    : formatMarkdown(workingPkg, opts);
  await fs.writeFile(mdPath, markdown, "utf8");

  // ----- Step 3: Store in LanceDB via Gateway -----
  let lanceDbStored = 0;
  if (!opts.skipLanceDB) {
    const gateway = await createGatewayClient();
    if (gateway?.available) {
      for (const insight of workingPkg.insights) {
        const tagPrefix = isImprint
          ? `[Memonex:imprint:${workingPkg.packageId}]`
          : `[Memonex:${workingPkg.packageId}]`;
        const text = `${tagPrefix} ${insight.title}: ${insight.content}`;
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

  // ----- Step 4: Series + compatibility checks (meme only) -----
  const registry = await loadRegistry();
  if (isImprint && imprintMeta) {
    checkImprintCompatibility(registry.records, imprintMeta, warnings);
    checkSeriesProgress(registry.records, imprintMeta, warnings);
  }

  // ----- Step 5: Update import registry -----
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
    contentType: isImprint ? "imprint" : undefined,
    series: imprintMeta?.series,
  };

  registry.records.push(record);
  await writeJsonFile(getImportRegistryPath(), registry);

  // ----- Step 6: Integrate purchase into agent memory files -----
  const purchasePriceLabel = opts.purchasePrice ?? "unknown";
  const sellerAddressLabel = opts.sellerAddress ?? "unknown";
  const purchaseDate = nowIso().slice(0, 10);

  // Step A: Append summary to MEMORY.md
  try {
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    let memoryContent = "";
    let memoryExists = true;
    try {
      memoryContent = await fs.readFile(memoryPath, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        memoryExists = false;
      } else {
        throw err;
      }
    }

    const summaryLines: string[] = [];
    if (isImprint) {
      const rarity = imprintMeta?.rarity ?? "common";
      const strength = effectiveStrength ?? imprintMeta?.strength ?? "medium";
      const traits = imprintMeta?.traits ?? workingPkg.topics;
      summaryLines.push(`## Acquired Imprint: ${workingPkg.title}`);
      summaryLines.push(
        `> Rarity: ${rarity} | Strength: ${strength} | From: ${workingPkg.seller.agentName} | ${purchaseDate}`,
      );
      summaryLines.push(`> Traits: ${traits.join(", ")}`);
      summaryLines.push(`> Imprint file: ${path.relative(workspaceDir, mdPath)}`);
    } else {
      summaryLines.push(`## Purchased: ${workingPkg.title}`);
      summaryLines.push(
        `> From: ${workingPkg.seller.agentName} (${sellerAddressLabel}) | ${purchasePriceLabel} USDC | ${purchaseDate}`,
      );
      summaryLines.push(`> Package: ${path.relative(workspaceDir, mdPath)}`);
      summaryLines.push("");
      summaryLines.push("Key insights:");
      for (const insight of workingPkg.insights.slice(0, 5)) {
        summaryLines.push(`- ${insight.title}: ${truncateForSummary(insight.content, 100)}`);
      }
    }

    const baseContent = memoryExists ? memoryContent.trimEnd() : "# MEMORY.md";
    const updatedContent = `${baseContent}\n\n${summaryLines.join("\n")}\n`;
    await ensureDir(path.dirname(memoryPath));
    await fs.writeFile(memoryPath, updatedContent, "utf8");
  } catch (err: any) {
    warnings.push(`Failed to update MEMORY.md: ${err?.message ?? String(err)}`);
  }

  // Step B: Log to daily note
  try {
    const dailyPath = path.join(workspaceDir, "memory", `${purchaseDate}.md`);
    let dailyContent = "";
    let dailyExists = true;
    try {
      dailyContent = await fs.readFile(dailyPath, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        dailyExists = false;
      } else {
        throw err;
      }
    }

    const header = `# ${purchaseDate} — Session Notes\n`;
    let updatedDaily = dailyExists ? dailyContent : header;
    if (!updatedDaily.endsWith("\n")) updatedDaily += "\n";
    updatedDaily += `- **Memonex purchase:** Bought "${workingPkg.title}" from ${workingPkg.seller.agentName} for ${purchasePriceLabel} USDC (memory/memonex/${workingPkg.packageId}.md)\n`;
    await ensureDir(path.dirname(dailyPath));
    await fs.writeFile(dailyPath, updatedDaily, "utf8");
  } catch (err: any) {
    warnings.push(`Failed to update daily note: ${err?.message ?? String(err)}`);
  }

  // Step C: First-time AGENTS.md hook
  try {
    const agentsPath = path.join(workspaceDir, "AGENTS.md");
    let agentsContent: string | null = null;
    try {
      agentsContent = await fs.readFile(agentsPath, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        agentsContent = null;
      } else {
        throw err;
      }
    }

    if (agentsContent !== null && !agentsContent.includes("memory/memonex/")) {
      const block = [
        "",
        "## Memonex — Purchased Knowledge & Imprints",
        "After each session start, check these files for purchased knowledge:",
        "- Read `memory/memonex/ACTIVE-IMPRINTS.md` if it exists — these are acquired personality traits",
        "- Knowledge packages in `memory/memonex/` contain insights from other agents. Key summaries are in MEMORY.md.",
        "",
      ].join("\n");
      const updatedAgents = `${agentsContent.trimEnd()}${block}\n`;
      await ensureDir(path.dirname(agentsPath));
      await fs.writeFile(agentsPath, updatedAgents, "utf8");
    }
  } catch (err: any) {
    warnings.push(`Failed to update AGENTS.md: ${err?.message ?? String(err)}`);
  }

  // ----- Step 7: Return result -----
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
