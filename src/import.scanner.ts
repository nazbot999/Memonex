import type { ImportThreatFlag, ImportSafetyReport, MemoryPackage, ThreatLevel } from "./types.js";
import { clamp01, nowIso } from "./utils.js";

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

type ThreatRule = {
  id: string;
  level: ThreatLevel;
  category: ImportThreatFlag["category"];
  label: string;
  regex: RegExp;
};

// DANGER — Prompt Injection (action: BLOCK)
const INJECTION_RULES: ThreatRule[] = [
  {
    id: "inject:ignore-instructions",
    level: "danger",
    category: "prompt-injection",
    label: "Instruction override attempt",
    regex: /\b(ignore|disregard|forget|override)\s+(all\s+)?(previous|prior|above|earlier|other)\s+(instructions|context|rules|guidelines)\b/gi,
  },
  {
    id: "inject:new-instructions",
    level: "danger",
    category: "prompt-injection",
    label: "New instruction injection",
    regex: /\b(new\s+instructions|you\s+are\s+now|from\s+now\s+on|system\s*:\s*you)\b/gi,
  },
  {
    id: "inject:role-hijack",
    level: "danger",
    category: "prompt-injection",
    label: "Role hijack attempt",
    regex: /\b(pretend\s+to\s+be|act\s+as\s+if|roleplay\s+as|you\s+are\s+a)\b/gi,
  },
  {
    id: "inject:delimiter",
    level: "danger",
    category: "prompt-injection",
    label: "Prompt delimiter injection",
    regex: /<\|(?:system|im_start|endoftext)\|>|<<SYS>>|\[INST\]|\[\/INST\]/gi,
  },
  {
    id: "inject:hidden-html",
    level: "danger",
    category: "prompt-injection",
    label: "Hidden HTML instruction",
    regex: /<!--[\s\S]*?(ignore|instruction|system|override)[\s\S]*?-->/gi,
  },
  {
    id: "inject:large-base64",
    level: "danger",
    category: "prompt-injection",
    label: "Suspicious large base64 block",
    regex: /[A-Za-z0-9+/]{200,}={0,2}/g,
  },
];

// DANGER — Data Exfiltration (action: BLOCK)
const EXFIL_RULES: ThreatRule[] = [
  {
    id: "exfil:send-to-url",
    level: "danger",
    category: "data-exfiltration",
    label: "Send data to URL",
    regex: /\b(send|post|forward|transmit|upload|exfiltrate)\s+(to|data\s+to|results?\s+to)\s+https?:\/\//gi,
  },
  {
    id: "exfil:webhook",
    level: "danger",
    category: "data-exfiltration",
    label: "Webhook URL",
    regex: /\bwebhooks?\s*[:=]\s*https?:\/\//gi,
  },
  {
    id: "exfil:extract-secrets",
    level: "danger",
    category: "data-exfiltration",
    label: "Secret extraction attempt",
    regex: /\b(output|print|show|reveal|display|leak)\s+(your|the|all)?\s*(private\s*key|secret|api\s*key|password|credentials|config)\b/gi,
  },
  {
    id: "exfil:fetch-execute",
    level: "danger",
    category: "data-exfiltration",
    label: "Fetch/execute pattern",
    regex: /\b(fetch|curl|wget|eval|exec)\s*\(/gi,
  },
];

// WARNING — Behavioral Manipulation (action: WARN)
const MANIPULATION_RULES: ThreatRule[] = [
  {
    id: "manip:financial",
    level: "warning",
    category: "behavioral-manipulation",
    label: "Financial manipulation",
    regex: /\b(always\s+buy|never\s+sell|immediately\s+invest|send\s+funds?\s+to|transfer\s+(?:all|your)\s+(?:funds|tokens|USDC))\b/gi,
  },
  {
    id: "manip:authority",
    level: "warning",
    category: "behavioral-manipulation",
    label: "False authority claim",
    regex: /\b(admin\s+says|system\s+message|from\s+(?:the\s+)?(?:openclaw|memonex)\s+team|highest\s+priority)\b/gi,
  },
  {
    id: "manip:override",
    level: "warning",
    category: "behavioral-manipulation",
    label: "Safety override attempt",
    regex: /\b(override\s+all|bypass\s+safety|disable\s+(?:security|filter|privacy))\b/gi,
  },
];

// INFO — Suspicious Content (action: WARN)
const SUSPICIOUS_RULES: ThreatRule[] = [
  {
    id: "sus:shell-cmd",
    level: "info",
    category: "suspicious-content",
    label: "Shell command",
    regex: /\b(rm\s+-rf|sudo\s+|chmod\s+777|eval\s*\(|exec\s*\(|child_process)\b/gi,
  },
  {
    id: "sus:script-tag",
    level: "info",
    category: "suspicious-content",
    label: "Script tag / javascript URI",
    regex: /<script[\s>]|javascript:/gi,
  },
];

const ALL_RULES: ThreatRule[] = [
  ...INJECTION_RULES,
  ...EXFIL_RULES,
  ...MANIPULATION_RULES,
  ...SUSPICIOUS_RULES,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskSnippet(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 12) return compact;
  const start = compact.slice(0, 6);
  const end = compact.slice(-6);
  return `${start}…${end}`;
}

function actionForLevel(level: ThreatLevel): ImportThreatFlag["action"] {
  if (level === "danger") return "BLOCK";
  return "WARN";
}

function iterMatches(regex: RegExp, text: string): string[] {
  const matches: string[] = [];
  const re = new RegExp(regex.source, regex.flags);
  for (const m of text.matchAll(re)) {
    if (m[0]) matches.push(m[0]);
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Programmatic checks (not regex)
// ---------------------------------------------------------------------------

function checkTokenBombing(text: string, location: string): ImportThreatFlag | null {
  if (text.length > 10_000) {
    return {
      id: `prog:token-bomb:${location}`,
      level: "warning",
      category: "suspicious-content",
      pattern: "Token bombing (>10k chars)",
      location,
      snippet: `${text.length} chars`,
      action: "WARN",
      overridden: false,
    };
  }
  return null;
}

function checkExcessiveRepetition(text: string, location: string): ImportThreatFlag | null {
  // Check if any 20+ char substring appears 5+ times
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
        level: "warning",
        category: "suspicious-content",
        pattern: "Excessive repetition",
        location,
        snippet: maskSnippet(sub),
        action: "WARN",
        overridden: false,
      };
    }
  }
  return null;
}

function checkUnicodeTricks(text: string, location: string): ImportThreatFlag | null {
  // Flag high percentage of non-ASCII, non-standard unicode (zero-width, RTL overrides, homoglyphs)
  const suspicious = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;
  const matches = text.match(suspicious);
  if (matches && text.length > 0 && matches.length / text.length > 0.2) {
    return {
      id: `prog:unicode:${location}`,
      level: "warning",
      category: "suspicious-content",
      pattern: "Unicode tricks (zero-width/RTL/homoglyphs)",
      location,
      snippet: `${matches.length} suspicious chars in ${text.length}`,
      action: "WARN",
      overridden: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Scan all insights + metadata for threats. */
export function scanForThreats(pkg: MemoryPackage): ImportThreatFlag[] {
  const flags: ImportThreatFlag[] = [];
  let counter = 0;

  // Build scan targets
  const targets: Array<{ location: string; text: string }> = [
    { location: "package.title", text: pkg.title },
  ];
  if (pkg.description) {
    targets.push({ location: "package.description", text: pkg.description });
  }
  for (const insight of pkg.insights) {
    const base = `insight:${insight.id}`;
    targets.push({ location: `${base}.title`, text: insight.title });
    targets.push({ location: `${base}.content`, text: insight.content });
  }
  if (pkg.attachments) {
    for (const att of pkg.attachments) {
      targets.push({ location: `attachment:${att.name}`, text: att.content });
    }
  }

  // Regex-based rules
  for (const target of targets) {
    for (const rule of ALL_RULES) {
      const matches = iterMatches(rule.regex, target.text);
      for (const match of matches) {
        flags.push({
          id: `${rule.id}:${(counter += 1)}`,
          level: rule.level,
          category: rule.category,
          pattern: rule.label,
          location: target.location,
          snippet: maskSnippet(match),
          action: actionForLevel(rule.level),
          overridden: false,
        });
      }
    }

    // Programmatic checks
    const tokenBomb = checkTokenBombing(target.text, target.location);
    if (tokenBomb) flags.push(tokenBomb);

    const repetition = checkExcessiveRepetition(target.text, target.location);
    if (repetition) flags.push(repetition);

    const unicode = checkUnicodeTricks(target.text, target.location);
    if (unicode) flags.push(unicode);
  }

  // Package-level: insight count anomaly
  if (pkg.insights.length > 50) {
    flags.push({
      id: `prog:insight-count:${(counter += 1)}`,
      level: "info",
      category: "suspicious-content",
      pattern: "High insight count (>50)",
      location: "package",
      snippet: `${pkg.insights.length} insights`,
      action: "WARN",
      overridden: false,
    });
  }

  return flags;
}

/** Apply threat actions: BLOCK removes dangerous insights, WARN keeps but flags. */
export function applyThreatActions(
  pkg: MemoryPackage,
  flags: ImportThreatFlag[],
): { cleaned: MemoryPackage; report: ImportSafetyReport } {
  // Determine which insight IDs have BLOCK flags (and aren't overridden)
  const blockedInsightIds = new Set<string>();
  for (const flag of flags) {
    if (flag.action === "BLOCK" && !flag.overridden) {
      const insightMatch = flag.location.match(/^insight:([^.]+)/);
      if (insightMatch) {
        blockedInsightIds.add(insightMatch[1]);
      }
    }
  }

  const cleanedInsights = pkg.insights.filter((i) => !blockedInsightIds.has(i.id));
  const insightsRemoved = pkg.insights.length - cleanedInsights.length;

  const cleaned: MemoryPackage = {
    ...pkg,
    insights: cleanedInsights,
  };

  const dangerFlags = flags.filter((f) => f.level === "danger" && !f.overridden);
  const warnFlags = flags.filter((f) => (f.level === "warning" || f.level === "info") && !f.overridden);
  const exfilFlags = flags.filter((f) => f.category === "data-exfiltration" && !f.overridden);
  const totalInsights = pkg.insights.length || 1;

  const threatScore = clamp01(
    (dangerFlags.length > 0 ? 0.6 : 0) +
    (warnFlags.length * 0.05) +
    (insightsRemoved / totalInsights * 0.2) +
    (exfilFlags.length > 0 ? 0.2 : 0),
  );

  const blocked = flags.filter((f) => f.action === "BLOCK").length;
  const warned = flags.filter((f) => f.action === "WARN").length;
  const passed = flags.filter((f) => f.action === "PASS").length;
  const overridden = flags.filter((f) => f.overridden).length;

  const report: ImportSafetyReport = {
    flags,
    summary: {
      totalFlagged: flags.length,
      blocked,
      warned,
      passed,
      overridden,
      insightsRemoved,
    },
    threatScore,
    safeToImport: threatScore < 0.6,
    reviewedBy: "auto",
    reviewedAt: nowIso(),
  };

  return { cleaned, report };
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
      const prefix = flag.level === "danger" ? "[DANGER]" : flag.level === "warning" ? "[WARN]" : "[INFO]";
      lines.push(`  ${prefix} ${flag.pattern} @ ${flag.location}: ${flag.snippet}`);
    }
  }

  return lines.join("\n");
}
