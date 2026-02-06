import type { MemoryPackage, PrivacyFlag, PrivacyReview } from "./types.js";
import { clamp01, nowIso } from "./utils.js";

type Rule = {
  id: string;
  kind: PrivacyFlag["kind"];
  label: string;
  regex: RegExp;
  replacement?: string | ((match: string, ...groups: string[]) => string);
};

const RULES: Rule[] = [
  {
    id: "secret:bearer",
    kind: "secret",
    label: "Bearer token",
    regex: /\bBearer\s+[A-Za-z0-9\-_.]{16,}\b/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    id: "secret:sk_live",
    kind: "secret",
    label: "sk_live API key",
    regex: /\bsk_live_[A-Za-z0-9]{8,}\b/gi,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    id: "secret:evm-private-key",
    kind: "secret",
    label: "EVM private key",
    regex: /\b0x[a-fA-F0-9]{64}\b/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    id: "secret:env-assignment",
    kind: "secret",
    label: "Secret env assignment",
    regex: /\b(API_KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)\b\s*[:=]\s*['\"]?[^\s'\"\n]{4,}['\"]?/gi,
    replacement: (_match, key) => `${key}=[REDACTED_SECRET]`,
  },
  {
    id: "pii:email",
    kind: "pii",
    label: "Email address",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    id: "pii:phone",
    kind: "pii",
    label: "Phone number",
    regex: /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    replacement: "[REDACTED_PHONE]",
  },
  {
    id: "pii:ip",
    kind: "pii",
    label: "IP address",
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    replacement: "[REDACTED_IP]",
  },
  {
    id: "highrisk:env-name",
    kind: "high-risk",
    label: "Secret env var name",
    regex: /\b(API_KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)\b(?!\s*[:=])/gi,
    replacement: "[REDACTED_ENV_VAR]",
  },
];

function maskSnippet(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 8) return compact;
  const start = compact.slice(0, 4);
  const end = compact.slice(-4);
  return `${start}…${end}`;
}

function iterMatches(regex: RegExp, text: string): string[] {
  const matches: string[] = [];
  const re = new RegExp(regex.source, regex.flags);
  for (const match of text.matchAll(re)) {
    if (match[0]) matches.push(match[0]);
  }
  return matches;
}

function buildTargets(pkg: MemoryPackage): Array<{ location: string; text: string }> {
  const targets: Array<{ location: string; text: string }> = [
    { location: "package.title", text: pkg.title },
  ];

  if (pkg.description) {
    targets.push({ location: "package.description", text: pkg.description });
  }

  if (pkg.extraction?.spec?.query) {
    targets.push({ location: "extraction.query", text: pkg.extraction.spec.query });
  }

  pkg.insights.forEach((insight) => {
    const base = `insight:${insight.id}`;
    targets.push({ location: `${base}.title`, text: insight.title });
    targets.push({ location: `${base}.content`, text: insight.content });
  });

  pkg.attachments?.forEach((attachment) => {
    targets.push({ location: `attachment:${attachment.name}`, text: attachment.content });
  });

  return targets;
}

function buildFlagIndex(flags: PrivacyFlag[]): Map<string, PrivacyFlag[]> {
  const index = new Map<string, PrivacyFlag[]>();
  for (const flag of flags) {
    const key = `${flag.location}|${flag.pattern}|${flag.snippet}`;
    const list = index.get(key) ?? [];
    list.push(flag);
    index.set(key, list);
  }
  return index;
}

function resolveFlag(
  index: Map<string, PrivacyFlag[]>,
  location: string,
  rule: Rule,
  match: string
): PrivacyFlag | undefined {
  const snippet = maskSnippet(match);
  const key = `${location}|${rule.label}|${snippet}`;
  const list = index.get(key);
  if (!list || list.length === 0) return undefined;
  return list.shift();
}

function applyReplacement(rule: Rule, match: string, groups: string[]): string {
  if (typeof rule.replacement === "function") {
    return rule.replacement(match, ...groups);
  }
  if (typeof rule.replacement === "string") {
    return rule.replacement;
  }
  return "[REDACTED]";
}

function redactText(
  text: string,
  location: string,
  flagIndex: Map<string, PrivacyFlag[]>
): string {
  let out = text;

  for (const rule of RULES) {
    const re = new RegExp(rule.regex.source, rule.regex.flags);
    out = out.replace(re, (match, ...args) => {
      const groups = args.slice(0, -2) as string[];
      const flag = resolveFlag(flagIndex, location, rule, match);
      if (!flag) return match;
      if (flag.action === "KEEP") return match;
      return applyReplacement(rule, match, groups);
    });
  }

  return out;
}

/** Scan a memory package for sensitive content. */
export function scanForPrivacy(pkg: MemoryPackage): PrivacyFlag[] {
  const flags: PrivacyFlag[] = [];
  let counter = 0;

  const targets = buildTargets(pkg);
  for (const target of targets) {
    for (const rule of RULES) {
      const matches = iterMatches(rule.regex, target.text);
      for (const match of matches) {
        flags.push({
          id: `${rule.id}:${counter += 1}`,
          kind: rule.kind,
          pattern: rule.label,
          location: target.location,
          snippet: maskSnippet(match),
          action: "REDACT",
          overridden: false,
        });
      }
    }
  }

  return flags;
}

/** Apply privacy actions (redact or keep) and return cleaned package. */
export function applyPrivacyActions(
  pkg: MemoryPackage,
  flags: PrivacyFlag[]
): { cleaned: MemoryPackage; review: PrivacyReview } {
  const flagIndex = buildFlagIndex(flags);

  const cleaned: MemoryPackage = {
    ...pkg,
    title: redactText(pkg.title, "package.title", flagIndex),
    description: pkg.description
      ? redactText(pkg.description, "package.description", flagIndex)
      : pkg.description,
    extraction: pkg.extraction
      ? {
        ...pkg.extraction,
        spec: pkg.extraction.spec
          ? {
            ...pkg.extraction.spec,
            query: redactText(pkg.extraction.spec.query, "extraction.query", flagIndex),
          }
          : pkg.extraction.spec,
      }
      : pkg.extraction,
    insights: pkg.insights.map((insight) => {
      const base = `insight:${insight.id}`;
      return {
        ...insight,
        title: redactText(insight.title, `${base}.title`, flagIndex),
        content: redactText(insight.content, `${base}.content`, flagIndex),
      };
    }),
    attachments: pkg.attachments?.map((attachment) => ({
      ...attachment,
      content: redactText(attachment.content, `attachment:${attachment.name}`, flagIndex),
    })),
  };

  const totalFlagged = flags.length;
  const redacted = flags.filter((flag) => flag.action === "REDACT").length;
  const kept = flags.filter((flag) => flag.action === "KEEP").length;
  const overridden = flags.filter((flag) => flag.overridden).length;

  const keptSecrets = flags.filter((flag) => flag.action === "KEEP" && flag.kind === "secret").length;
  const keptPii = flags.filter((flag) => flag.action === "KEEP" && flag.kind === "pii").length;

  const leakageRiskScore = clamp01(
    (totalFlagged > 0 ? 0.15 : 0) +
      (keptSecrets > 0 ? 0.5 : 0) +
      (keptPii > 0 ? 0.2 : 0) +
      (overridden > 0 ? 0.1 : 0)
  );

  const review: PrivacyReview = {
    flags,
    summary: {
      totalFlagged,
      redacted,
      kept,
      overridden,
    },
    leakageRiskScore,
    reviewedBy: "auto",
    reviewedAt: nowIso(),
    approved: keptSecrets === 0 && leakageRiskScore <= 0.5,
  };

  return { cleaned, review };
}

/** Generate a human-readable privacy summary. */
export function formatPrivacySummary(review: PrivacyReview): string {
  const status = review.approved ? "approved" : "needs review";
  return [
    `Privacy review: ${status}`,
    `Total flagged: ${review.summary.totalFlagged}`,
    `Redacted: ${review.summary.redacted}`,
    `Kept: ${review.summary.kept}`,
    `Overrides: ${review.summary.overridden}`,
    `Leakage risk: ${review.leakageRiskScore.toFixed(2)}`,
    `Reviewed by: ${review.reviewedBy} @ ${review.reviewedAt}`,
  ].join("\n");
}
