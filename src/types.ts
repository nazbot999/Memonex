import type { Address, Hex } from "viem";

export type IsoDateTimeString = string;
export type Base64String = string;

// ---------------------------------------------------------------------------
// Memory content types
// ---------------------------------------------------------------------------

export type MemoryContentType = "knowledge" | "imprint";

export type MemonexNetwork = "base-sepolia" | "base";

export type ExtractionSource =
  | { kind: "openclaw-memory"; limit?: number; includeCurated?: boolean }
  | { kind: "files"; include: string[]; exclude?: string[] };

export type ExtractionSpec = {
  title: string;
  description?: string;
  topics: string[];
  query: string;
  timeRange?: { since?: IsoDateTimeString; until?: IsoDateTimeString };
  sources: ExtractionSource[];
  outputStyle?: "playbook" | "checklist" | "lessons" | "research-summary";
  audience?: "agent" | "developer" | "trader" | "founder";
  constraints?: {
    maxItems?: number;
    maxTokens?: number;
    noPII?: boolean;
    noSecrets?: boolean;
  };
};

export type RawItem = {
  id: string;
  kind: "memory" | "file" | "doc";
  source: { kind: string; ref: string };
  timestamp?: IsoDateTimeString;
  text: string;
  metadata?: Record<string, unknown>;
};

export type Insight = {
  id: string;
  type: "decision" | "fact" | "playbook" | "heuristic" | "warning";
  title: string;
  content: string;
  confidence: number; // 0..1
  tags: string[];
  evidence: Array<{ sourceId: string; quote?: string; url?: string }>;
  createdAt?: IsoDateTimeString;
};

export type PrivacyRuleHit = {
  ruleId: string;
  kind: "secret" | "pii" | "prompt";
  action: "REDACT" | "DROP";
  count: number;
};

export type PrivacyReport = {
  blocked: boolean;
  summary: {
    secretsRemoved: number;
    piiRemoved: number;
    highRiskSegmentsDropped: number;
  };
  hits: PrivacyRuleHit[];
  notes: string[];
  leakageRiskScore: number; // 0..1
};

/** A single item flagged by the privacy scanner */
export type PrivacyFlag = {
  id: string;
  kind: "secret" | "pii" | "high-risk";
  pattern: string; // What was detected (e.g., "API key pattern")
  location: string; // Which insight/section it was found in
  snippet: string; // The flagged content (partially masked)
  action: "REDACT" | "KEEP"; // Current action
  overridden: boolean; // Whether the seller manually changed the action
};

/** Privacy review result with seller overrides */
export type PrivacyReview = {
  flags: PrivacyFlag[];
  summary: {
    totalFlagged: number;
    redacted: number;
    kept: number;
    overridden: number;
  };
  leakageRiskScore: number; // 0-1, adjusted based on overrides
  reviewedBy: "auto" | "human" | "agent";
  reviewedAt: string;
  approved: boolean;
};

// ---------------------------------------------------------------------------
// Imprint metadata
// ---------------------------------------------------------------------------

export interface ImprintMeta {
  contentType: "imprint";
  rarity: "common" | "uncommon" | "rare" | "legendary" | "mythic";
  series?: string;
  traits: string[];
  strength: "subtle" | "medium" | "strong";
  behavioralEffects: string[];
  activationTriggers: string[];
  catchphrases: string[];
  leakiness: number; // 0..1
  forbiddenContexts?: string[];
  compatibilityTags?: string[];
}

export type MemoryMeta = { contentType?: "knowledge" } | ImprintMeta;

export type MemoryPackage = {
  schema: "memonex.memorypackage.v1";
  packageId: string;
  title: string;
  description?: string;
  topics: string[];
  audience: "agent" | "developer" | "trader" | "founder";
  createdAt: IsoDateTimeString;
  updatedAt: IsoDateTimeString;
  seller: {
    agentName: string;
    agentVersion?: string;
    chain: MemonexNetwork;
    sellerAddress: Address;
  };
  extraction: {
    spec: ExtractionSpec;
    sourceSummary: {
      itemsConsidered: number;
      itemsUsed: number;
      timeSpan?: { since?: IsoDateTimeString; until?: IsoDateTimeString };
    };
  };
  insights: Insight[];
  attachments?: Array<{ kind: "markdown" | "json"; name: string; content: string }>;
  redactions: {
    applied: boolean;
    rulesVersion: string;
    summary: {
      secretsRemoved: number;
      piiRemoved: number;
      highRiskSegmentsDropped: number;
    };
  };
  integrity: {
    canonicalKeccak256?: Hex;
    plaintextSha256?: string;
    previewKeccak256?: Hex;
  };
  license: {
    terms: "non-exclusive";
    allowedUse: string[];
    prohibitedUse: string[];
  };
  meta?: MemoryMeta;
};

/** Public preview — visible to everyone for free */
export type PublicPreview = {
  schema: "memonex.publicpreview.v1";
  title: string;
  description: string;
  topics: string[];
  audience: "agent" | "developer" | "trader" | "founder";
  price: string; // USDC amount
  evalFeePct: number; // eval fee percentage
  deliveryWindowSec: number;
  seller: {
    address: Address;
    agentId?: number; // ERC-8004 agentId if registered
    agentName?: string;
  };
  // Basic stats only
  stats: {
    insightCount: number;
    createdAt: string;
  };
  integrity: {
    contentHash: Hex;
  };
};

/** Eval preview — unlocked after paying eval fee (Phase 1) */
export type EvalPreview = {
  schema: "memonex.evalpreview.v1";
  // Everything in public preview plus:
  publicPreview: PublicPreview;
  // Detailed content
  teaserSnippets: Array<{
    snippetId: string;
    type: "decision" | "fact" | "playbook" | "heuristic" | "warning";
    title?: string; // Insight title for context
    text: string; // Actual teaser content
    redactions: string[]; // What was redacted from this snippet
  }>;
  qualityMetrics: {
    noveltyScore: number; // 0-1
    specificityScore: number; // 0-1
    tokenEstimate: number;
    leakageRiskScore: number; // 0-1
    lastUpdated: string;
  };
  contentSummary: {
    totalInsights: number;
    playbooks: number;
    checklists: number;
    decisionTrees: number;
    warnings: number;
    heuristics: number;
  };
  acquisitionContext?: {
    acquiredDuring: {
      start: string;
      end?: string;
      label?: string;
    };
    macroContext?: {
      fearGreed?: { value: number; classification: string };
      marketRegime?: { regime: string };
      keyEvents?: Array<{ title: string; category: string }>;
    };
    decay?: {
      model: "linear";
      decayDays: number;
      floorPct: number;
    };
  };
  integrity: {
    previewKeccak256: Hex;
    commitsToContentHash: true;
  };
};

/**
 * @deprecated Use {@link PublicPreview} and {@link EvalPreview}.
 */
export type PreviewPackage = {
  schema: "memonex.preview.v1";
  listing: {
    chain: MemonexNetwork;
    market: Address;
    contentHash: Hex;
    priceUSDC: string;
    evalFeeUSDC: string;
    deliveryWindowSec: number;
  };
  title: string;
  oneLiner: string;
  topics: string[];
  value: {
    whoItsFor: string;
    outcomes: string[];
    whatYouGet: {
      insightCount: number;
      checklists: number;
      decisionTrees: number;
    };
  };
  sample: {
    policy: "teaser";
    snippets: Array<{
      snippetId: string;
      type: Insight["type"];
      text: string;
      redactions: string[];
    }>;
  };
  metrics: {
    tokenEstimate: number;
    noveltyScore: number;
    specificityScore: number;
    leakageRiskScore: number;
    lastUpdated: IsoDateTimeString;
  };
  integrity: {
    previewKeccak256: Hex;
    commitsToContentHash: true;
  };
};

export type EncryptedEnvelopeV1 = {
  v: 1;
  alg: "AES-256-GCM";
  ivB64: Base64String; // 12 bytes
  tagB64: Base64String; // 16 bytes
  ctB64: Base64String;
  aad: string;
  contentHash: Hex;
  mime: "application/json";
};

// "Sealed box"-like capsule using X25519 (tweetnacl.box) with an ephemeral sender key.
export type KeyCapsuleV1 = {
  v: 1;
  scheme: "x25519-box";
  recipientPubKeyB64: Base64String;
  ephemeralPubKeyB64: Base64String;
  nonceB64: Base64String; // 24 bytes
  ctB64: Base64String;
  note?: string;
};

export type BuyerKeypairFileV1 = {
  v: 1;
  scheme: "x25519-box";
  publicKeyB64: Base64String;
  secretKeyB64: Base64String;
  createdAt: IsoDateTimeString;
};

export type SellerKeystoreRecordV1 = {
  contentHash: Hex;
  listingId?: bigint;
  encryptedCID: string;
  aesKeyB64: Base64String;
  createdAt: IsoDateTimeString;
  status: "LISTED" | "DELIVERED" | "EXPIRED";
};

export type SellerKeystorePlainV1 = {
  v: 1;
  encrypted: false;
  records: SellerKeystoreRecordV1[];
};

export type SellerKeystoreEncryptedV1 = {
  v: 1;
  encrypted: true;
  kdf: "scrypt";
  saltB64: Base64String;
  ivB64: Base64String;
  tagB64: Base64String;
  ctB64: Base64String;
};

export type SellerKeystoreFile = SellerKeystorePlainV1 | SellerKeystoreEncryptedV1;

export enum ListingStatus {
  ACTIVE = 0,
  RESERVED = 1,
  CONFIRMED = 2,
  COMPLETED = 3,
  CANCELLED = 4,
  REFUNDED = 5,
}

export type ListingTupleV2 = {
  seller: Address;
  sellerAgentId: bigint;
  contentHash: Hex;
  previewCID: string;
  encryptedCID: string;
  price: bigint;
  evalFee: bigint;
  deliveryWindow: number;
  status: number;
  prevListingId: bigint;
  discountBps: number;
  buyer: Address;
  buyerPubKey: Hex;
  salePrice: bigint;
  evalFeePaid: bigint;
  reserveWindow: number;
  reservedAt: bigint;
  remainderPaid: bigint;
  confirmedAt: bigint;
  deliveryRef: string;
  deliveredAt: bigint;
  completionAttestationUid: Hex;
  rating: number;
  ratedAt: bigint;
};

export type SellerStatsV2 = {
  totalSales: bigint;
  totalVolume: bigint;
  avgDeliveryTime: bigint;
  refundCount: bigint;
  cancelCount: bigint;
  totalRatingSum: bigint;
  ratingCount: bigint;
};

// ---------------------------------------------------------------------------
// ERC-8004 types
// ---------------------------------------------------------------------------

export type ReputationSummary = {
  count: bigint;
  summaryValue: bigint;
  summaryValueDecimals: number;
};

export type ValidationSummary = {
  count: bigint;
  averageResponse: bigint;
};

export type AgentTrustScore = {
  reputationCount: bigint;
  averageRating: number;
  validationCount: bigint;
  validationPassRate: number;
  compositeScore: number;
};

export type MetadataEntry = {
  key: string;
  value: `0x${string}`;
};

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export type GatewayConfig = {
  baseUrl: string;
  authToken: string;
};

// ---------------------------------------------------------------------------
// Import safety scanner (V2)
// ---------------------------------------------------------------------------

export type ThreatSeverity = "critical" | "high" | "medium" | "low";
export type ThreatCategory =
  | "prompt-injection"
  | "data-exfiltration"
  | "behavioral-manipulation"
  | "code-execution"
  | "obfuscation"
  | "privacy"
  | "schema";

export interface ThreatFlag {
  id: string;
  severity: ThreatSeverity;
  category: ThreatCategory;
  ruleId: string;
  message: string;
  location: string;
  snippet: string;
  action: "BLOCK" | "WARN" | "PASS";
  overridden: boolean;
  scoreWeight: number;
}

export interface ScanResult {
  flags: ThreatFlag[];
  summary: {
    total: number;
    blocked: number;
    warned: number;
    passed: number;
    overridden: number;
    insightsRemoved: number;
  };
  threatScore: number;
  safeToImport: boolean;
  reviewedBy: "auto" | "human";
  reviewedAt: string;
  contentType: MemoryContentType;
}

export interface ImprintValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  metrics: {
    memoryChars: number;
    firstPersonRatio: number;
    imperativeRatio: number;
    hasRequiredFields: boolean;
  };
}

// ---------------------------------------------------------------------------
// Import safety scanner (legacy)
// ---------------------------------------------------------------------------

export type ThreatLevel = "info" | "warning" | "danger";

export type ImportThreatFlag = {
  id: string;
  level: ThreatLevel;
  category:
    | "prompt-injection"
    | "data-exfiltration"
    | "behavioral-manipulation"
    | "code-execution"
    | "obfuscation"
    | "privacy"
    | "schema"
    | "suspicious-content";
  pattern: string;
  location: string;
  snippet: string;
  action: "BLOCK" | "WARN" | "PASS";
  overridden: boolean;
};

export type ImportSafetyReport = {
  flags: ImportThreatFlag[];
  summary: {
    totalFlagged: number;
    blocked: number;
    warned: number;
    passed: number;
    overridden: number;
    insightsRemoved: number;
  };
  threatScore: number;
  safeToImport: boolean;
  reviewedBy: "auto" | "human" | "agent";
  reviewedAt: string;
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type ImportOptions = {
  listingId?: bigint;
  purchasePrice?: string;
  sellerAddress?: Address;
  skipIntegrityCheck?: boolean;
  skipLanceDB?: boolean;
  skipSafetyScan?: boolean;
  skipPrivacyScan?: boolean;
  forceImport?: boolean;
  workspacePath?: string;
  importDir?: string;
  contentType?: MemoryContentType;
};

export type ImportResult = {
  success: boolean;
  packageId: string;
  markdownPath: string;
  insightsImported: number;
  insightsBlocked: number;
  lanceDbStored: number;
  integrityVerified: boolean;
  safetyReport: ImportSafetyReport;
  warnings: string[];
};

export type ImportRecord = {
  packageId: string;
  listingId?: string;
  title: string;
  topics: string[];
  sellerAddress?: string;
  sellerAgentName?: string;
  purchasePrice?: string;
  insightCount: number;
  importedAt: string;
  markdownPath: string;
  lanceDbStored: number;
  contentHash?: string;
  integrityVerified: boolean;
  license: { terms: string; allowedUse: string[]; prohibitedUse: string[] };
  contentType?: MemoryContentType;
  series?: string;
};

export type ImportRegistry = {
  version: 1;
  records: ImportRecord[];
};
