import type { EvalPreview, Insight, MemoryPackage, PublicPreview } from "./types.js";
import type { ContextAwarePricing } from "./context-pricing.js";
import { clamp01, computeCanonicalKeccak256, nowIso } from "./utils.js";

type ListingInput = {
  price: string;
  evalFeePct: number;
  deliveryWindowSec: number;
};

const TEASER_TYPES: Insight["type"][] = [
  "decision",
  "fact",
  "playbook",
  "heuristic",
  "warning",
];

function redactSnippet(text: string): { text: string; redactions: string[] } {
  const redactions: string[] = [];
  let out = text;

  if (/0x[a-fA-F0-9]{6,}/.test(out)) {
    out = out.replace(/0x[a-fA-F0-9]{6,}/g, "[REDACTED_ADDRESS]");
    redactions.push("addresses");
  }

  if (/\d/.test(out)) {
    out = out.replace(/\b\d+(?:\.\d+)?\b/g, "[REDACTED_NUMBER]");
    redactions.push("numbers");
  }

  out = out.replace(/\s+/g, " ").trim();
  if (out.length > 260) out = `${out.slice(0, 260).trim()}…`;

  return { text: out, redactions };
}

function estimateTokensFromText(text: string): number {
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

function selectTeaserSnippets(insights: Insight[], maxSnippets: number): EvalPreview["teaserSnippets"] {
  const picks: Insight[] = [];
  const used = new Set<number>();

  for (const type of TEASER_TYPES) {
    if (picks.length >= maxSnippets) break;
    const idx = insights.findIndex((i, index) => i.type === type && !used.has(index));
    if (idx >= 0) {
      picks.push(insights[idx]);
      used.add(idx);
    }
  }

  for (let idx = 0; idx < insights.length && picks.length < maxSnippets; idx += 1) {
    if (used.has(idx)) continue;
    picks.push(insights[idx]);
    used.add(idx);
  }

  return picks.map((insight, idx) => {
    const { text, redactions } = redactSnippet(insight.content || insight.title);
    return {
      snippetId: `t${idx + 1}`,
      type: insight.type,
      text,
      redactions: redactions.length ? redactions : ["generalization"],
    };
  });
}

function computeContentSummary(insights: Insight[]): EvalPreview["contentSummary"] {
  const checklists = insights.filter((i) => i.tags?.some((tag) => /checklist/i.test(tag))).length;
  const decisionTrees = insights.filter((i) => i.tags?.some((tag) => /decision[-\s]?tree/i.test(tag))).length;

  return {
    totalInsights: insights.length,
    playbooks: countByType(insights, "playbook"),
    checklists,
    decisionTrees,
    warnings: countByType(insights, "warning"),
    heuristics: countByType(insights, "heuristic"),
  };
}

function computeNoveltyScore(insights: Insight[]): number {
  const combined = insights.map((i) => `${i.title}\n${i.content}`).join("\n\n");
  const uniqueness = wordUniquenessScore(combined);
  const variety = new Set(insights.map((i) => i.type)).size / TEASER_TYPES.length;
  const countFactor = Math.min(1, insights.length / 12);
  return clamp01(0.2 + 0.5 * uniqueness + 0.2 * variety + 0.1 * countFactor);
}

function computeSpecificityScore(insights: Insight[]): number {
  if (insights.length === 0) return 0.2;
  const avgDetail =
    insights.reduce((acc, i) => acc + Math.min(1, i.content.length / 500), 0) / insights.length;
  const variety = new Set(insights.map((i) => i.type)).size / TEASER_TYPES.length;
  return clamp01(0.2 + 0.6 * avgDetail + 0.2 * variety);
}

function computeLeakageRiskScore(pkg: MemoryPackage): number {
  const summary = pkg.redactions?.summary;
  if (!summary) return 0.05;
  const secrets = summary.secretsRemoved > 0 ? 0.4 : 0;
  const pii = summary.piiRemoved > 0 ? 0.15 : 0;
  const highRisk = summary.highRiskSegmentsDropped > 0 ? 0.45 : 0;
  return clamp01(secrets + pii + highRisk);
}

function resolveAcquisitionContext(pkg: MemoryPackage): EvalPreview["acquisitionContext"] | undefined {
  const context = (pkg as { contextAwarePricing?: ContextAwarePricing }).contextAwarePricing;
  if (context) {
    return {
      acquiredDuring: {
        start: context.acquiredDuring.start,
        end: context.acquiredDuring.end,
        label: context.acquiredDuring.label,
      },
      macroContext: {
        fearGreed: context.macroContext.fearGreed
          ? {
            value: context.macroContext.fearGreed.value,
            classification: context.macroContext.fearGreed.classification,
          }
          : undefined,
        marketRegime: context.macroContext.marketRegime
          ? { regime: context.macroContext.marketRegime.regime }
          : undefined,
        keyEvents: context.macroContext.keyEvents?.map((event) => ({
          title: event.title,
          category: event.category,
        })),
      },
      decay: context.decay,
    };
  }

  const timeRange = pkg.extraction?.spec?.timeRange;
  if (timeRange?.since || timeRange?.until) {
    return {
      acquiredDuring: {
        start: timeRange.since ?? pkg.createdAt,
        end: timeRange.until,
        label: undefined,
      },
    };
  }

  return undefined;
}

/** Build the public (free) preview for a memory package. */
export function buildPublicPreview(pkg: MemoryPackage, listing: ListingInput): PublicPreview {
  const contentHash = pkg.integrity.canonicalKeccak256 ?? computeCanonicalKeccak256(pkg);

  return {
    schema: "memonex.publicpreview.v1",
    title: pkg.title,
    description: pkg.description ?? `Insights on ${pkg.topics.join(", ") || "key topics"}.`,
    topics: pkg.topics,
    audience: pkg.audience,
    price: listing.price,
    evalFeePct: listing.evalFeePct,
    deliveryWindowSec: listing.deliveryWindowSec,
    seller: {
      address: pkg.seller.sellerAddress,
      agentId: (pkg.seller as { agentId?: number }).agentId,
      agentName: pkg.seller.agentName,
    },
    stats: {
      insightCount: pkg.insights.length,
      createdAt: pkg.createdAt,
    },
    integrity: {
      contentHash,
    },
  };
}

/** Build the eval (paid) preview for a memory package. */
export function buildEvalPreview(pkg: MemoryPackage, publicPreview: PublicPreview): EvalPreview {
  const insights = pkg.insights;
  const teaserSnippets = selectTeaserSnippets(insights, 4);
  const combinedText = JSON.stringify(pkg);
  const tokenEstimate = estimateTokensFromText(combinedText);

  const qualityMetrics = {
    noveltyScore: computeNoveltyScore(insights),
    specificityScore: computeSpecificityScore(insights),
    tokenEstimate,
    leakageRiskScore: computeLeakageRiskScore(pkg),
    lastUpdated: pkg.updatedAt ?? nowIso(),
  };

  const contentSummary = computeContentSummary(insights);
  const acquisitionContext = resolveAcquisitionContext(pkg);

  const previewBase: Omit<EvalPreview, "integrity"> & {
    integrity: { commitsToContentHash: true };
  } = {
    schema: "memonex.evalpreview.v1",
    publicPreview,
    teaserSnippets,
    qualityMetrics,
    contentSummary,
    acquisitionContext,
    integrity: {
      commitsToContentHash: true,
    },
  };

  const previewKeccak = computeCanonicalKeccak256(previewBase);

  return {
    ...previewBase,
    integrity: {
      previewKeccak256: previewKeccak,
      commitsToContentHash: true,
    },
  };
}

/** Build both preview tiers in a single pass. */
export function buildBothPreviews(
  pkg: MemoryPackage,
  listing: ListingInput
): { public: PublicPreview; eval: EvalPreview } {
  const publicPreview = buildPublicPreview(pkg, listing);
  const evalPreview = buildEvalPreview(pkg, publicPreview);

  return { public: publicPreview, eval: evalPreview };
}
