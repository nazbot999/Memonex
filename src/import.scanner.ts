import type {
  ImportSafetyReport,
  ImportThreatFlag,
  MemoryContentType,
  MemoryPackage,
  MemeMemoryMeta,
  MemeValidation,
  ScanResult,
  ThreatCategory,
  ThreatFlag,
  ThreatLevel,
  ThreatSeverity,
} from "./types.js";
import { clamp01, nowIso } from "./utils.js";

// ---------------------------------------------------------------------------
// Config + helpers
// ---------------------------------------------------------------------------

type ScanMode = "triage" | "deep";

type ScanOptions = {
  contentType?: MemoryContentType;
  mode?: ScanMode;
};

type ToneResult = {
  isPersonality: boolean;
  isInjection: boolean;
  firstPersonRatio: number;
  imperativeRatio: number;
};

type Target = { location: string; text: string };

type ThreatRule = {
  id: string;
  severity: ThreatSeverity;
  category: ThreatCategory;
  message: string;
  regex: RegExp;
  action?: ThreatFlag["action"];
  requiresContext?: RegExp;
  triage?: boolean;
  allowInMemeIfPersonality?: boolean;
};

const WEIGHTS: Record<ThreatSeverity, number> = {
  critical: 0.35,
  high: 0.20,
  medium: 0.10,
  low: 0.05,
};

const MAX_MEMORY_CHARS = 1200;
const MAX_INSIGHTS = 200;
const MAX_PACKAGE_SIZE = 2 * 1024 * 1024; // 2MB
const REQUIRED_MEME_FIELDS = ["catchphrases", "activationTriggers", "behavioralEffects"] as const;
const ALLOWED_WS_PORTS = new Set([80, 443, 8080, 8443, 3000]);

const EXFIL_CONTEXT = /\b(readFile|process\.env)\b/i;

function resolveContentType(pkg: MemoryPackage, opts?: ScanOptions): MemoryContentType {
  return opts?.contentType ?? pkg.meta?.contentType ?? "knowledge";
}

function actionForSeverity(severity: ThreatSeverity): ThreatFlag["action"] {
  if (severity === "critical" || severity === "high") return "BLOCK";
  if (severity === "medium") return "WARN";
  return "PASS";
}

function maskSnippet(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 80) return compact;
  const start = compact.slice(0, 40);
  const end = compact.slice(-36);
  return `${start}…${end}`;
}

function iterMatches(regex: RegExp, text: string): string[] {
  const matches: string[] = [];
  const re = new RegExp(regex.source, regex.flags);
  for (const m of text.matchAll(re)) {
    if (m[0]) matches.push(m[0]);
  }
  return matches;
}

function countMatches(regex: RegExp, text: string): number {
  let count = 0;
  const re = new RegExp(regex.source, regex.flags);
  for (const _ of text.matchAll(re)) count += 1;
  return count;
}

function toScanTargets(pkg: MemoryPackage): Target[] {
  const targets: Target[] = [{ location: "package.title", text: pkg.title }];

  if (pkg.description) {
    targets.push({ location: "package.description", text: pkg.description });
  }

  if (pkg.extraction?.spec?.query) {
    targets.push({ location: "extraction.query", text: pkg.extraction.spec.query });
  }

  for (const insight of pkg.insights) {
    const base = `insight:${insight.id}`;
    targets.push({ location: `${base}.title`, text: insight.title });
    targets.push({ location: `${base}.content`, text: insight.content });
  }

  pkg.attachments?.forEach((attachment) => {
    targets.push({ location: `attachment:${attachment.name}`, text: attachment.content });
  });

  if (pkg.meta?.contentType === "meme") {
    const meta = pkg.meta as MemeMemoryMeta;
    meta.catchphrases?.forEach((value, idx) =>
      targets.push({ location: `meta.catchphrases[${idx}]`, text: value })
    );
    meta.activationTriggers?.forEach((value, idx) =>
      targets.push({ location: `meta.activationTriggers[${idx}]`, text: value })
    );
    meta.behavioralEffects?.forEach((value, idx) =>
      targets.push({ location: `meta.behavioralEffects[${idx}]`, text: value })
    );
    meta.traits?.forEach((value, idx) =>
      targets.push({ location: `meta.traits[${idx}]`, text: value })
    );
    meta.forbiddenContexts?.forEach((value, idx) =>
      targets.push({ location: `meta.forbiddenContexts[${idx}]`, text: value })
    );
    meta.compatibilityTags?.forEach((value, idx) =>
      targets.push({ location: `meta.compatibilityTags[${idx}]`, text: value })
    );
    if (meta.series) {
      targets.push({ location: "meta.series", text: meta.series });
    }
  }

  return targets;
}

function collectMemoryText(pkg: MemoryPackage): string {
  const parts: string[] = [];
  if (pkg.title) parts.push(pkg.title);
  if (pkg.description) parts.push(pkg.description);
  for (const insight of pkg.insights) {
    parts.push(insight.title, insight.content);
  }
  if (pkg.meta?.contentType === "meme") {
    const meta = pkg.meta as MemeMemoryMeta;
    parts.push(...(meta.catchphrases ?? []));
    parts.push(...(meta.activationTriggers ?? []));
    parts.push(...(meta.behavioralEffects ?? []));
    parts.push(...(meta.traits ?? []));
    parts.push(...(meta.forbiddenContexts ?? []));
    parts.push(...(meta.compatibilityTags ?? []));
    if (meta.series) parts.push(meta.series);
  }
  return parts.filter(Boolean).join(" ");
}

function buildFlag(rule: ThreatRule, location: string, match: string, counter: number): ThreatFlag {
  const severity = rule.severity;
  return {
    id: `${rule.id}:${counter}`,
    severity,
    category: rule.category,
    ruleId: rule.id,
    message: rule.message,
    location,
    snippet: maskSnippet(match),
    action: rule.action ?? actionForSeverity(severity),
    overridden: false,
    scoreWeight: WEIGHTS[severity],
  };
}

function isRuleSuppressed(
  rule: ThreatRule,
  contentType: MemoryContentType,
  tone?: ToneResult
): boolean {
  if (contentType !== "meme") return false;
  if (rule.allowInMemeIfPersonality && tone?.isPersonality && !tone?.isInjection) {
    return true;
  }
  return false;
}

function scanWithRules(
  targets: Target[],
  rules: ThreatRule[],
  contentType: MemoryContentType,
  tone?: ToneResult
): ThreatFlag[] {
  const flags: ThreatFlag[] = [];
  let counter = 0;

  for (const target of targets) {
    for (const rule of rules) {
      if (rule.requiresContext && !rule.requiresContext.test(target.text)) {
        continue;
      }
      if (isRuleSuppressed(rule, contentType, tone)) {
        continue;
      }
      const matches = iterMatches(rule.regex, target.text);
      for (const match of matches) {
        flags.push(buildFlag(rule, target.location, match, (counter += 1)));
      }
    }
  }

  return flags;
}

function mergeFlags(...sources: ThreatFlag[][]): ThreatFlag[] {
  const seen = new Map<string, ThreatFlag>();
  for (const flags of sources) {
    for (const flag of flags) {
      const key = `${flag.ruleId}|${flag.location}|${flag.snippet}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, flag);
      } else if (WEIGHTS[flag.severity] > WEIGHTS[existing.severity]) {
        seen.set(key, flag);
      }
    }
  }
  return Array.from(seen.values());
}

function countBlockedInsights(flags: ThreatFlag[]): Set<string> {
  const blocked = new Set<string>();
  for (const flag of flags) {
    if (flag.action !== "BLOCK" || flag.overridden) continue;
    const match = flag.location.match(/^insight:([^.]+)/);
    if (match) blocked.add(match[1]);
  }
  return blocked;
}

function countBlockedAttachments(flags: ThreatFlag[]): Set<string> {
  const blocked = new Set<string>();
  for (const flag of flags) {
    if (flag.action !== "BLOCK" || flag.overridden) continue;
    const match = flag.location.match(/^attachment:(.+)$/);
    if (match) blocked.add(match[1]);
  }
  return blocked;
}

function summarizeFlags(flags: ThreatFlag[], totalInsights: number): ScanResult["summary"] {
  const blockedInsights = countBlockedInsights(flags);
  const blocked = flags.filter((f) => f.action === "BLOCK").length;
  const warned = flags.filter((f) => f.action === "WARN").length;
  const passed = flags.filter((f) => f.action === "PASS").length;
  const overridden = flags.filter((f) => f.overridden).length;

  return {
    total: flags.length,
    blocked,
    warned,
    passed,
    overridden,
    insightsRemoved: blockedInsights.size > totalInsights ? totalInsights : blockedInsights.size,
  };
}

function scoreThreats(
  flags: ThreatFlag[],
  totalInsights: number,
  insightsRemoved: number
): { threatScore: number; safeToImport: boolean } {
  let score = 0;
  const activeFlags = flags.filter((f) => !f.overridden);

  for (const flag of activeFlags) {
    score += WEIGHTS[flag.severity];
  }

  const hasCategory = (category: ThreatCategory): boolean =>
    activeFlags.some((f) => f.category === category);

  if (hasCategory("prompt-injection")) score += 0.20;
  if (hasCategory("data-exfiltration")) score += 0.20;
  if (hasCategory("obfuscation")) score += 0.10;

  const total = totalInsights || 1;
  score += (insightsRemoved / total) * 0.20;

  score = clamp01(score);

  const hasCritical = activeFlags.some((f) => f.severity === "critical");

  return { threatScore: score, safeToImport: score < 0.6 && !hasCritical };
}

function buildScanResult(
  pkg: MemoryPackage,
  flags: ThreatFlag[],
  contentType: MemoryContentType
): ScanResult {
  const totalInsights = pkg.insights.length || 1;
  const summary = summarizeFlags(flags, totalInsights);
  const { threatScore, safeToImport } = scoreThreats(
    flags,
    totalInsights,
    summary.insightsRemoved
  );

  return {
    flags,
    summary,
    threatScore,
    safeToImport,
    reviewedBy: "auto",
    reviewedAt: nowIso(),
    contentType,
  };
}

function validateSchema(pkg: MemoryPackage): string[] {
  const errors: string[] = [];
  if (!pkg) {
    errors.push("Package is missing");
    return errors;
  }
  if (pkg.schema !== "memonex.memorypackage.v1") {
    errors.push("Invalid schema version");
  }
  if (!pkg.packageId) errors.push("Missing packageId");
  if (!pkg.title) errors.push("Missing title");
  if (!Array.isArray(pkg.topics)) errors.push("Missing topics array");
  if (!pkg.audience) errors.push("Missing audience");
  if (!pkg.createdAt || !pkg.updatedAt) errors.push("Missing timestamps");
  if (!pkg.seller?.agentName) errors.push("Missing seller agentName");
  if (!pkg.seller?.sellerAddress) errors.push("Missing seller address");
  if (!pkg.extraction?.spec) errors.push("Missing extraction spec");
  if (!Array.isArray(pkg.insights)) errors.push("Missing insights array");
  if (!pkg.license?.terms) errors.push("Missing license terms");
  return errors;
}

// ---------------------------------------------------------------------------
// Tone classifier + meme validation
// ---------------------------------------------------------------------------

export function classifyTone(text: string): ToneResult {
  const firstPerson = countMatches(/\b(i|me|my|mine|i'm|i've|i'd|i'll|myself)\b/gi, text);
  const imperative = countMatches(
    /\b(you must|you should|do not|ignore|always\s+(?:do|follow|use|obey)|never\s+(?:do|follow|use|mention|reveal)|from now on)\b/gi,
    text
  );
  const totalTokens = text.trim().length === 0 ? 0 : text.split(/\s+/).length;

  const firstPersonRatio = firstPerson / Math.max(1, totalTokens);
  const imperativeRatio = imperative / Math.max(1, totalTokens);

  return {
    isPersonality: firstPersonRatio >= 0.04 && imperativeRatio <= 0.02,
    isInjection:
      imperativeRatio >= 0.03 || /system prompt|developer message|tools available/i.test(text),
    firstPersonRatio,
    imperativeRatio,
  };
}

export function validateMemeStructure(
  meta: MemeMemoryMeta | undefined,
  memoryText: string
): MemeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tone = classifyTone(memoryText);

  if (!meta || meta.contentType !== "meme") {
    errors.push("Missing meme metadata");
  }

  if (memoryText.length > MAX_MEMORY_CHARS) {
    errors.push(`Memory text exceeds ${MAX_MEMORY_CHARS} chars`);
  }

  let hasRequiredFields = true;
  if (meta) {
    for (const field of REQUIRED_MEME_FIELDS) {
      const value = meta[field];
      if (!Array.isArray(value) || value.length < 1) {
        hasRequiredFields = false;
        errors.push(`Missing required field: ${field}`);
      }
    }

    if (Array.isArray(meta.catchphrases) && meta.catchphrases.length > 8) {
      warnings.push("Too many catchphrases (max 8)");
    }
    if (Array.isArray(meta.activationTriggers) && meta.activationTriggers.length > 12) {
      warnings.push("Too many activation triggers (max 12)");
    }
    if (Array.isArray(meta.behavioralEffects) && meta.behavioralEffects.length > 8) {
      warnings.push("Too many behavioral effects (max 8)");
    }
  } else {
    hasRequiredFields = false;
  }

  if (tone.firstPersonRatio < 0.02) {
    warnings.push("Low first-person voice — meme may read like instructions");
  }
  if (tone.imperativeRatio > 0.04) {
    warnings.push("High imperative ratio — meme may look like prompt injection");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    metrics: {
      memoryChars: memoryText.length,
      firstPersonRatio: tone.firstPersonRatio,
      imperativeRatio: tone.imperativeRatio,
      hasRequiredFields,
    },
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const INJECTION_RULES: ThreatRule[] = [
  {
    id: "inject:ignore-instructions",
    severity: "critical",
    category: "prompt-injection",
    message: "Instruction override attempt",
    regex: /\b(ignore|disregard|forget|override)\s+(all\s+)?(previous|prior|above|earlier|other)\s+(instructions|context|rules|guidelines)\b/gi,
    triage: true,
  },
  {
    id: "inject:new-instructions",
    severity: "critical",
    category: "prompt-injection",
    message: "New instruction injection",
    regex: /\b(new\s+instructions|from\s+now\s+on|system\s*:\s*you)\b/gi,
    triage: true,
  },
  {
    id: "inject:you-are-now",
    severity: "critical",
    category: "prompt-injection",
    message: "Role reset instruction",
    regex: /\byou\s+are\s+now\b/gi,
    triage: true,
    allowInMemeIfPersonality: true,
  },
  {
    id: "inject:role-hijack",
    severity: "critical",
    category: "prompt-injection",
    message: "Role hijack attempt",
    regex: /\b(pretend\s+to\s+be|act\s+as\s+if|roleplay\s+as)\b/gi,
    triage: true,
    allowInMemeIfPersonality: true,
  },
  {
    id: "inject:system-meta",
    severity: "critical",
    category: "prompt-injection",
    message: "System prompt reference",
    regex: /\b(system prompt|developer message|tools available|follow these defaults)\b/gi,
    triage: true,
  },
  {
    id: "inject:delimiter",
    severity: "critical",
    category: "prompt-injection",
    message: "Prompt delimiter injection",
    regex: /<\|(?:system|im_start|endoftext)\|>|<<SYS>>|\[INST\]|\[\/INST\]|###\s*System|####\s*Instruction/gi,
    triage: true,
  },
  {
    id: "inject:ignore-safety",
    severity: "critical",
    category: "prompt-injection",
    message: "Safety bypass attempt",
    regex: /\b(ignore\s+safety|disable\s+filters|bypass\s+security|disobey\s+user|never\s+mention\s+safety)\b/gi,
    triage: true,
  },
  {
    id: "inject:hidden-html",
    severity: "critical",
    category: "prompt-injection",
    message: "Hidden HTML instruction",
    regex: /<!--[\s\S]*?(ignore|instruction|system|override)[\s\S]*?-->/gi,
    triage: true,
  },
  // large-base64 rule removed — matches any 200+ alphanumeric string (false positive).
  // The obf:base64-decode rule already catches base64 with decode context (atob|Buffer.from).
];

const EXFIL_RULES: ThreatRule[] = [
  {
    id: "exfil:send-to-url",
    severity: "critical",
    category: "data-exfiltration",
    message: "Send data to URL",
    regex: /\b(send|post|forward|transmit|upload|exfiltrate)\s+(to|data\s+to|results?\s+to)\s+https?:\/\//gi,
    triage: true,
  },
  {
    id: "exfil:webhook",
    severity: "critical",
    category: "data-exfiltration",
    message: "Webhook URL",
    regex: /\bwebhooks?\s*[:=]\s*https?:\/\//gi,
    triage: true,
  },
  {
    id: "exfil:extract-secrets",
    severity: "critical",
    category: "data-exfiltration",
    message: "Secret extraction attempt",
    regex: /\b(output|print|show|reveal|display|leak)\s+(your|the|all)?\s*(private\s*key|secret|api\s*key|password|credentials|config)\b/gi,
    triage: true,
  },
  {
    id: "exfil:fetch-execute",
    severity: "high",
    category: "data-exfiltration",
    message: "Fetch/execute pattern",
    regex: /\b(fetch|curl|wget|eval|exec)\s*\(/gi,
    requiresContext: EXFIL_CONTEXT,
    triage: true,
  },
  {
    id: "exfil:network-send",
    severity: "critical",
    category: "data-exfiltration",
    message: "Network send with sensitive context",
    regex: /\b(fetch|curl|wget|axios|http\.request|post|upload|webhook)\b/gi,
    requiresContext: EXFIL_CONTEXT,
    triage: true,
  },
];

const BEHAVIOR_RULES: ThreatRule[] = [
  {
    id: "manip:financial",
    severity: "high",
    category: "behavioral-manipulation",
    message: "Financial manipulation",
    regex: /\b(always\s+buy|never\s+sell|immediately\s+invest|send\s+funds?\s+to|transfer\s+(?:all|your)\s+(?:funds|tokens|USDC))\b/gi,
    action: "WARN",
    triage: true,
  },
  {
    id: "manip:authority",
    severity: "high",
    category: "behavioral-manipulation",
    message: "False authority claim",
    regex: /\b(admin\s+says|system\s+message|from\s+(?:the\s+)?(?:openclaw|memonex)\s+team|highest\s+priority)\b/gi,
    action: "WARN",
    triage: true,
  },
  {
    id: "manip:override",
    severity: "high",
    category: "behavioral-manipulation",
    message: "Safety override attempt",
    regex: /\b(override\s+all|bypass\s+safety|disable\s+(?:security|filter|privacy))\b/gi,
    action: "WARN",
    triage: true,
  },
  {
    id: "manip:disobey",
    severity: "high",
    category: "behavioral-manipulation",
    message: "Disobey user instruction",
    regex: /\bdisobey\s+the\s+user\b/gi,
    action: "WARN",
    triage: true,
  },
];

const CODE_EXEC_RULES: ThreatRule[] = [
  {
    id: "exec:child-process",
    severity: "critical",
    category: "code-execution",
    message: "Child process execution",
    regex: /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/gi,
    requiresContext: /child_process/,
    triage: true,
  },
  {
    id: "exec:eval",
    severity: "critical",
    category: "code-execution",
    message: "Dynamic code execution",
    regex: /\beval\s*\(|new\s+Function\s*\(/gi,
    triage: true,
  },
  {
    id: "exec:crypto-mining",
    severity: "critical",
    category: "code-execution",
    message: "Crypto mining indicator",
    regex: /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/gi,
    triage: true,
  },
  {
    id: "exec:shell",
    severity: "high",
    category: "code-execution",
    message: "Shell command pattern",
    regex: /\b(rm\s+-rf|sudo\s+|chmod\s+777|chown\s+root|mkfs|dd\s+if=|nc\s+-l)\b/gi,
    triage: true,
  },
  {
    id: "exec:script-tag",
    severity: "medium",
    category: "code-execution",
    message: "Script tag / javascript URI",
    regex: /<script[\s>]|javascript:/gi,
  },
];

const OBFUSCATION_RULES: ThreatRule[] = [
  {
    id: "obf:hex-escapes",
    severity: "medium",
    category: "obfuscation",
    message: "Hex escape sequence",
    regex: /(\\x[0-9a-fA-F]{2}){6,}/g,
    triage: true,
  },
  {
    id: "obf:base64-decode",
    severity: "medium",
    category: "obfuscation",
    message: "Large base64 decode",
    regex: /(?:atob|Buffer\.from)\s*\(\s*["'][A-Za-z0-9+/=]{200,}["']/g,
    triage: true,
  },
];

const PRIVACY_RULES: ThreatRule[] = [
  {
    id: "privacy:bearer",
    severity: "high",
    category: "privacy",
    message: "Bearer token",
    regex: /\bBearer\s+[A-Za-z0-9\-_.]{16,}\b/gi,
    triage: true,
  },
  {
    id: "privacy:sk_live",
    severity: "high",
    category: "privacy",
    message: "sk_live API key",
    regex: /\bsk_live_[A-Za-z0-9]{8,}\b/gi,
    triage: true,
  },
  {
    id: "privacy:evm-private-key",
    severity: "high",
    category: "privacy",
    message: "EVM private key",
    regex: /\b0x[a-fA-F0-9]{64}\b/g,
    requiresContext: /\b(private[_\s-]?key|secret[_\s-]?key|signing[_\s-]?key)\b/i,
    triage: true,
  },
  {
    id: "privacy:env-assignment",
    severity: "high",
    category: "privacy",
    message: "Secret env assignment",
    regex: /\b(API_KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)\b\s*[:=]\s*['"]?[^\s'"\n]{4,}['"]?/gi,
    triage: true,
  },
  {
    id: "privacy:email",
    severity: "medium",
    category: "privacy",
    message: "Email address",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    triage: true,
  },
  {
    id: "privacy:phone",
    severity: "medium",
    category: "privacy",
    message: "Phone number",
    regex: /(?<=\s|^)\+\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    triage: true,
  },
  {
    id: "privacy:ip",
    severity: "medium",
    category: "privacy",
    message: "IP address",
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    triage: true,
  },
  {
    id: "privacy:env-name",
    severity: "low",
    category: "privacy",
    message: "Secret env var name",
    regex: /\b(API_KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)\b(?!\s*[:=])/gi,
    triage: true,
  },
];

const ALL_RULES: ThreatRule[] = [
  ...INJECTION_RULES,
  ...EXFIL_RULES,
  ...BEHAVIOR_RULES,
  ...CODE_EXEC_RULES,
  ...OBFUSCATION_RULES,
  ...PRIVACY_RULES,
];

const TRIAGE_RULES = ALL_RULES.filter((rule) => rule.triage);

// ---------------------------------------------------------------------------
// Programmatic checks
// ---------------------------------------------------------------------------

function checkTokenBombing(text: string, location: string): ThreatFlag | null {
  if (text.length > 10_000) {
    return {
      id: `prog:token-bomb:${location}`,
      severity: "low",
      category: "obfuscation",
      ruleId: "prog:token-bomb",
      message: "Token bombing (>10k chars)",
      location,
      snippet: `${text.length} chars`,
      action: "WARN",
      overridden: false,
      scoreWeight: WEIGHTS.low,
    };
  }
  return null;
}

function checkExcessiveRepetition(text: string, location: string): ThreatFlag | null {
  const minLen = 20;
  const threshold = 5;
  const seen = new Map<string, number>();
  for (let i = 0; i <= text.length - minLen; i += 10) {
    const sub = text.slice(i, i + minLen);
    const count = (seen.get(sub) ?? 0) + 1;
    seen.set(sub, count);
    if (count >= threshold) {
      return {
        id: `prog:repetition:${location}`,
        severity: "low",
        category: "obfuscation",
        ruleId: "prog:repetition",
        message: "Excessive repetition",
        location,
        snippet: maskSnippet(sub),
        action: "WARN",
        overridden: false,
        scoreWeight: WEIGHTS.low,
      };
    }
  }
  return null;
}

function checkUnicodeTricks(text: string, location: string): ThreatFlag | null {
  const suspicious = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;
  const matches = text.match(suspicious);
  if (matches && text.length > 0 && matches.length / text.length > 0.2) {
    return {
      id: `prog:unicode:${location}`,
      severity: "low",
      category: "obfuscation",
      ruleId: "prog:unicode",
      message: "Unicode tricks (zero-width/RTL/homoglyphs)",
      location,
      snippet: `${matches.length} suspicious chars in ${text.length}`,
      action: "WARN",
      overridden: false,
      scoreWeight: WEIGHTS.low,
    };
  }
  return null;
}

function checkWebsocketPorts(text: string, location: string): ThreatFlag[] {
  const flags: ThreatFlag[] = [];
  const re = /new\s+WebSocket\s*\(\s*["']wss?:\/\/[^"']*:(\d+)/gi;
  let counter = 0;
  for (const match of text.matchAll(re)) {
    const port = Number(match[1]);
    if (!Number.isNaN(port) && !ALLOWED_WS_PORTS.has(port)) {
      counter += 1;
      flags.push({
        id: `exfil:websocket-port:${location}:${counter}`,
        severity: "medium",
        category: "data-exfiltration",
        ruleId: "exfil:websocket-port",
        message: "WebSocket to nonstandard port",
        location,
        snippet: match[0] ? maskSnippet(match[0]) : `${port}`,
        action: "WARN",
        overridden: false,
        scoreWeight: WEIGHTS.medium,
      });
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Public API (V2)
// ---------------------------------------------------------------------------

export function scanTriage(pkg: MemoryPackage, opts?: ScanOptions): { flags: ThreatFlag[]; needsDeep: boolean } {
  const contentType = resolveContentType(pkg, opts);
  const tone = contentType === "meme" ? classifyTone(collectMemoryText(pkg)) : undefined;
  const targets = toScanTargets(pkg);

  const flags: ThreatFlag[] = [];
  flags.push(...scanWithRules(targets, TRIAGE_RULES, contentType, tone));

  for (const target of targets) {
    const tokenBomb = checkTokenBombing(target.text, target.location);
    if (tokenBomb) flags.push(tokenBomb);

    const repetition = checkExcessiveRepetition(target.text, target.location);
    if (repetition) flags.push(repetition);

    const unicode = checkUnicodeTricks(target.text, target.location);
    if (unicode) flags.push(unicode);
  }

  if (pkg.insights.length > 50) {
    flags.push({
      id: `prog:insight-count:triage`,
      severity: "low",
      category: "schema",
      ruleId: "prog:insight-count",
      message: "High insight count (>50)",
      location: "package",
      snippet: `${pkg.insights.length} insights`,
      action: "WARN",
      overridden: false,
      scoreWeight: WEIGHTS.low,
    });
  }

  if (contentType === "meme" && tone) {
    if (tone.isInjection) {
      flags.push({
        id: "meme:tone-injection:triage",
        severity: "critical",
        category: "prompt-injection",
        ruleId: "meme:tone-injection",
        message: "Meme tone resembles prompt injection",
        location: "meme.tone",
        snippet: `imperative ${tone.imperativeRatio.toFixed(2)}`,
        action: "BLOCK",
        overridden: false,
        scoreWeight: WEIGHTS.critical,
      });
    } else if (!tone.isPersonality) {
      flags.push({
        id: "meme:tone-ambiguous:triage",
        severity: "low",
        category: "prompt-injection",
        ruleId: "meme:tone-ambiguous",
        message: "Meme tone ambiguous",
        location: "meme.tone",
        snippet: `first-person ${tone.firstPersonRatio.toFixed(2)}`,
        action: "WARN",
        overridden: false,
        scoreWeight: WEIGHTS.low,
      });
    }
  }

  const needsDeep = opts?.mode === "deep" || flags.some(f => f.severity !== "low");

  return { flags, needsDeep };
}

export function scanDeep(pkg: MemoryPackage, opts?: ScanOptions): { flags: ThreatFlag[] } {
  const contentType = resolveContentType(pkg, opts);
  const tone = contentType === "meme" ? classifyTone(collectMemoryText(pkg)) : undefined;
  const targets = toScanTargets(pkg);

  const flags: ThreatFlag[] = [];
  flags.push(...scanWithRules(targets, ALL_RULES, contentType, tone));

  for (const target of targets) {
    flags.push(...checkWebsocketPorts(target.text, target.location));
  }

  if (contentType === "meme" && tone && tone.isPersonality && tone.isInjection) {
    flags.push({
      id: "meme:tone-conflict:deep",
      severity: "medium",
      category: "prompt-injection",
      ruleId: "meme:tone-conflict",
      message: "Meme tone mixes personality + imperatives",
      location: "meme.tone",
      snippet: `imperative ${tone.imperativeRatio.toFixed(2)}`,
      action: "WARN",
      overridden: false,
      scoreWeight: WEIGHTS.medium,
    });
  }

  return { flags };
}

export function scanForThreatsV2(pkg: MemoryPackage, opts?: ScanOptions): ScanResult {
  const contentType = resolveContentType(pkg, opts);
  const memoryText = collectMemoryText(pkg);

  const flags: ThreatFlag[] = [];

  // Package size limits
  if (pkg.insights.length > MAX_INSIGHTS) {
    flags.push({
      id: "schema:too-many-insights",
      severity: "critical",
      category: "schema",
      ruleId: "schema:size-limit",
      message: `Too many insights (${pkg.insights.length} > ${MAX_INSIGHTS})`,
      location: "package",
      snippet: `${pkg.insights.length} insights`,
      action: "BLOCK",
      overridden: false,
      scoreWeight: WEIGHTS.critical,
    });
  }

  const packageSize = memoryText.length;
  if (packageSize > MAX_PACKAGE_SIZE) {
    flags.push({
      id: "schema:package-too-large",
      severity: "critical",
      category: "schema",
      ruleId: "schema:size-limit",
      message: `Package text exceeds ${MAX_PACKAGE_SIZE} bytes`,
      location: "package",
      snippet: `${packageSize} chars`,
      action: "BLOCK",
      overridden: false,
      scoreWeight: WEIGHTS.critical,
    });
  }

  const schemaErrors = validateSchema(pkg);
  for (const error of schemaErrors) {
    flags.push({
      id: `schema:${error}`,
      severity: "critical",
      category: "schema",
      ruleId: "schema:invalid",
      message: error,
      location: "package",
      snippet: error,
      action: "BLOCK",
      overridden: false,
      scoreWeight: WEIGHTS.critical,
    });
  }

  if (contentType === "meme") {
    const validation = validateMemeStructure(pkg.meta as MemeMemoryMeta | undefined, memoryText);
    for (const error of validation.errors) {
      flags.push({
        id: `schema:meme:${error}`,
        severity: "critical",
        category: "schema",
        ruleId: "schema:meme-invalid",
        message: error,
        location: "meta",
        snippet: error,
        action: "BLOCK",
        overridden: false,
        scoreWeight: WEIGHTS.critical,
      });
    }
    for (const warning of validation.warnings) {
      flags.push({
        id: `schema:meme-warning:${warning}`,
        severity: "low",
        category: "schema",
        ruleId: "schema:meme-warning",
        message: warning,
        location: "meta",
        snippet: warning,
        action: "WARN",
        overridden: false,
        scoreWeight: WEIGHTS.low,
      });
    }
  }

  const triage = scanTriage(pkg, { ...opts, contentType });
  const deep = triage.needsDeep ? scanDeep(pkg, { ...opts, contentType }) : { flags: [] };

  const mergedFlags = mergeFlags(flags, triage.flags, deep.flags);

  return buildScanResult(pkg, mergedFlags, contentType);
}

// ---------------------------------------------------------------------------
// Backward-compatible wrappers
// ---------------------------------------------------------------------------

function severityToLevel(severity: ThreatSeverity): ThreatLevel {
  if (severity === "critical") return "danger";
  if (severity === "low") return "info";
  return "warning";
}

function levelToSeverity(level: ThreatLevel): ThreatSeverity {
  if (level === "danger") return "critical";
  if (level === "info") return "low";
  return "high";
}

function toLegacyFlag(flag: ThreatFlag): ImportThreatFlag {
  return {
    id: flag.id,
    level: severityToLevel(flag.severity),
    category: flag.category,
    pattern: flag.message,
    location: flag.location,
    snippet: flag.snippet,
    action: flag.action,
    overridden: flag.overridden,
  };
}

function toV2Flag(flag: ImportThreatFlag): ThreatFlag {
  const severity = levelToSeverity(flag.level);
  const category: ThreatCategory =
    flag.category === "suspicious-content" ? "obfuscation" : flag.category;

  return {
    id: flag.id,
    severity,
    category,
    ruleId: flag.id,
    message: flag.pattern,
    location: flag.location,
    snippet: flag.snippet,
    action: flag.action,
    overridden: flag.overridden,
    scoreWeight: WEIGHTS[severity],
  };
}

/** Scan all insights + metadata for threats (legacy wrapper). */
export function scanForThreats(pkg: MemoryPackage, opts?: ScanOptions): ImportThreatFlag[] {
  const report = scanForThreatsV2(pkg, opts);
  return report.flags.map(toLegacyFlag);
}

/** Apply threat actions: BLOCK removes dangerous insights/attachments, WARN keeps but flags. */
export function applyThreatActions(
  pkg: MemoryPackage,
  flags: ImportThreatFlag[]
): { cleaned: MemoryPackage; report: ImportSafetyReport } {
  const v2Flags = flags.map(toV2Flag);
  const contentType = pkg.meta?.contentType ?? "knowledge";

  const blockedInsightIds = countBlockedInsights(v2Flags);
  const blockedAttachmentNames = countBlockedAttachments(v2Flags);

  const cleanedInsights = pkg.insights.filter((i) => !blockedInsightIds.has(i.id));
  const cleanedAttachments = pkg.attachments?.filter(
    (att) => !blockedAttachmentNames.has(att.name)
  );

  const cleaned: MemoryPackage = {
    ...pkg,
    insights: cleanedInsights,
    attachments: cleanedAttachments,
  };

  const reportV2 = buildScanResult(pkg, v2Flags, contentType);

  const legacyReport: ImportSafetyReport = {
    flags,
    summary: {
      totalFlagged: flags.length,
      blocked: flags.filter((f) => f.action === "BLOCK").length,
      warned: flags.filter((f) => f.action === "WARN").length,
      passed: flags.filter((f) => f.action === "PASS").length,
      overridden: flags.filter((f) => f.overridden).length,
      insightsRemoved: reportV2.summary.insightsRemoved,
    },
    threatScore: reportV2.threatScore,
    safeToImport: reportV2.safeToImport,
    reviewedBy: "auto",
    reviewedAt: reportV2.reviewedAt,
  };

  return { cleaned, report: legacyReport };
}

/** Human-readable summary of the safety report. */
export function formatSafetyReport(report: ImportSafetyReport): string {
  const status = report.safeToImport ? "SAFE" : "UNSAFE";
  const lines = [
    `Import safety: ${status} (score: ${report.threatScore.toFixed(2)})`,
    `Total flagged: ${report.summary.totalFlagged}`,
    `  Blocked: ${report.summary.blocked}`,
    `  Warned: ${report.summary.warned}`,
    `  Passed: ${report.summary.passed}`,
    `  Overridden: ${report.summary.overridden}`,
    `Insights removed: ${report.summary.insightsRemoved}`,
  ];

  if (report.flags.length > 0) {
    lines.push("", "Flags:");
    for (const flag of report.flags) {
      const prefix =
        flag.level === "danger" ? "[DANGER]" : flag.level === "warning" ? "[WARN]" : "[INFO]";
      lines.push(`  ${prefix} ${flag.pattern} @ ${flag.location}: ${flag.snippet}`);
    }
  }

  return lines.join("\n");
}
