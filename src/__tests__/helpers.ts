import type { MemoryPackage, ImprintMeta, Insight } from "../types.js";

let counter = 0;

function makeInsight(overrides?: Partial<Insight>): Insight {
  counter += 1;
  return {
    id: `test-insight-${counter}`,
    type: "heuristic",
    title: overrides?.title ?? `Test insight ${counter}`,
    content: overrides?.content ?? "When the price drops 20%, I usually wait for a second confirmation candle.",
    confidence: 0.85,
    tags: ["testing"],
    evidence: [{ sourceId: "test" }],
    ...overrides,
  };
}

export function makeKnowledgePackage(overrides?: {
  insights?: Partial<Insight>[];
  title?: string;
  description?: string;
}): MemoryPackage {
  const insights = overrides?.insights
    ? overrides.insights.map((o) => makeInsight(o))
    : [makeInsight(), makeInsight()];

  return {
    schema: "memonex.memorypackage.v1",
    packageId: `test-pkg-${Date.now()}`,
    title: overrides?.title ?? "DeFi Trading Heuristics",
    description: overrides?.description ?? "Collection of trading patterns.",
    topics: ["defi", "trading"],
    audience: "agent",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    seller: {
      agentName: "test-agent",
      chain: "base-sepolia",
      sellerAddress: "0x1234567890abcdef1234567890abcdef12345678",
    },
    extraction: {
      spec: {
        title: "DeFi Trading",
        topics: ["defi"],
        query: "trading strategies",
        sources: [{ kind: "openclaw-memory" }],
      },
      sourceSummary: { itemsConsidered: 10, itemsUsed: 5 },
    },
    insights,
    redactions: {
      applied: false,
      rulesVersion: "1.0",
      summary: { secretsRemoved: 0, piiRemoved: 0, highRiskSegmentsDropped: 0 },
    },
    integrity: {},
    license: {
      terms: "non-exclusive",
      allowedUse: ["internal-agent"],
      prohibitedUse: ["resale"],
    },
  };
}

export function makeImprintPackage(overrides?: {
  insights?: Partial<Insight>[];
  imprintMeta?: Partial<ImprintMeta>;
  title?: string;
}): MemoryPackage {
  const imprintMeta: ImprintMeta = {
    contentType: "imprint",
    rarity: "common",
    traits: ["sardonic", "skeptical"],
    strength: "medium",
    behavioralEffects: ["I question every bullish narrative"],
    activationTriggers: ["when someone mentions a new token launch"],
    catchphrases: ["Ah yes, another guaranteed 100x"],
    leakiness: 0.3,
    ...overrides?.imprintMeta,
  };

  const insights = overrides?.insights
    ? overrides.insights.map((o) => makeInsight(o))
    : [
        makeInsight({
          title: "The Skeptic's Instinct",
          content: "I've been burned before. My gut tells me to always check the contract audit first.",
        }),
      ];

  return {
    schema: "memonex.memorypackage.v1",
    packageId: `test-imprint-${Date.now()}`,
    title: overrides?.title ?? "The Eternal Skeptic",
    topics: ["crypto-skepticism"],
    audience: "agent",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    seller: {
      agentName: "imprint-seller",
      chain: "base-sepolia",
      sellerAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    },
    extraction: {
      spec: {
        title: "Skeptic imprint",
        topics: ["imprint"],
        query: "skeptical personality",
        sources: [{ kind: "openclaw-memory" }],
      },
      sourceSummary: { itemsConsidered: 5, itemsUsed: 1 },
    },
    insights,
    redactions: {
      applied: false,
      rulesVersion: "1.0",
      summary: { secretsRemoved: 0, piiRemoved: 0, highRiskSegmentsDropped: 0 },
    },
    integrity: {},
    license: {
      terms: "non-exclusive",
      allowedUse: ["internal-agent"],
      prohibitedUse: ["resale"],
    },
    meta: imprintMeta,
  };
}
