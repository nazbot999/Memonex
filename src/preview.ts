import type { Address, Hex } from "viem";
import type { Insight, MemoryPackage, PreviewPackage } from "./types.js";
import { clamp01, computeCanonicalKeccak256, nowIso } from "./utils.js";

function redactSnippet(text: string): { text: string; redactions: string[] } {
  const redactions: string[] = [];
  let out = text;

  // Remove obvious addresses and numbers.
  if (/0x[a-fA-F0-9]{6,}/.test(out)) {
    out = out.replace(/0x[a-fA-F0-9]{6,}/g, "[REDACTED_ADDRESS]");
    redactions.push("addresses");
  }

  if (/\d/.test(out)) {
    out = out.replace(/\b\d+(?:\.\d+)?\b/g, "[REDACTED_NUMBER]");
    redactions.push("numbers");
  }

  // Truncate.
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > 220) out = out.slice(0, 220).trim() + "…";

  return { text: out, redactions };
}

function estimateTokensFromText(text: string): number {
  // Very rough; good enough for MVP preview.
  return Math.max(1, Math.round(text.length / 4));
}

function wordUniquenessScore(text: string): number {
  const words = text
    .toLowerCase()
    .split(/\W+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);
  if (words.length === 0) return 0.2;
  const unique = new Set(words);
  return clamp01(unique.size / words.length);
}

function countByType(insights: Insight[], type: Insight["type"]): number {
  return insights.filter((i) => i.type === type).length;
}

export function generatePreview(params: {
  market: Address;
  contentHash: Hex;
  priceUSDC: bigint;
  evalFeeUSDC: bigint;
  deliveryWindowSec: number;
  memoryPackage: MemoryPackage;
  leakageRiskScore: number;
}): PreviewPackage {
  const { memoryPackage } = params;
  const now = nowIso();

  const insights = memoryPackage.insights;

  const teaserSnippets = insights.slice(0, 2).map((i, idx) => {
    const { text, redactions } = redactSnippet(i.content);
    return {
      snippetId: `s${idx + 1}`,
      type: i.type,
      text,
      redactions: redactions.length ? redactions : ["generalization"],
    };
  });

  const combinedText = JSON.stringify(memoryPackage);
  const tokenEstimate = estimateTokensFromText(combinedText);

  const noveltyScore = wordUniquenessScore(
    insights.map((i) => `${i.title}\n${i.content}`).join("\n\n")
  );

  const specificityScore = clamp01(
    0.3 + Math.min(0.7, insights.reduce((acc, i) => acc + Math.min(1, i.content.length / 500), 0) / Math.max(1, insights.length))
  );

  const previewBase = {
    schema: "memonex.preview.v1" as const,
    listing: {
      chain: "base-sepolia" as const,
      market: params.market,
      contentHash: params.contentHash,
      priceUSDC: params.priceUSDC.toString(),
      evalFeeUSDC: params.evalFeeUSDC.toString(),
      deliveryWindowSec: params.deliveryWindowSec,
    },
    title: memoryPackage.title,
    oneLiner: `A portable knowledge package on: ${memoryPackage.topics.join(", ") || "general"}.`,
    topics: memoryPackage.topics,
    value: {
      whoItsFor: memoryPackage.audience === "developer" ? "Developers building agents" : "Agents who want reusable playbooks",
      outcomes: insights.slice(0, 3).map((i) => i.title),
      whatYouGet: {
        insightCount: insights.length,
        checklists: countByType(insights, "playbook"),
        decisionTrees: 0,
      },
    },
    sample: {
      policy: "teaser" as const,
      snippets: teaserSnippets,
    },
    metrics: {
      tokenEstimate,
      noveltyScore: clamp01(noveltyScore),
      specificityScore,
      leakageRiskScore: clamp01(params.leakageRiskScore),
      lastUpdated: now,
    },
    integrity: {
      previewKeccak256: "0x" as Hex, // placeholder; filled below
      commitsToContentHash: true as const,
    },
  };

  const previewKeccak = computeCanonicalKeccak256({ ...previewBase, integrity: { commitsToContentHash: true } });

  const preview: PreviewPackage = {
    ...previewBase,
    integrity: {
      previewKeccak256: previewKeccak,
      commitsToContentHash: true,
    },
  };

  return preview;
}
