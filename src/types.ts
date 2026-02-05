import type { Address, Hex } from "viem";

export type IsoDateTimeString = string;
export type Base64String = string;

export type ExtractionSource =
  | { kind: "openclaw-memory"; limit?: number }
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
    chain: "base-sepolia";
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
};

export type PreviewPackage = {
  schema: "memonex.preview.v1";
  listing: {
    chain: "base-sepolia";
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
