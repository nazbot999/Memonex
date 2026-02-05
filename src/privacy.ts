import crypto from "node:crypto";
import type { Insight, PrivacyReport, PrivacyRuleHit } from "./types.js";
import { clamp01 } from "./utils.js";

type Rule = {
  id: string;
  kind: PrivacyRuleHit["kind"];
  action: PrivacyRuleHit["action"];
  regex: RegExp;
  replacement?: string;
};

// NOTE: This is intentionally conservative. If we see something that looks like
// secrets or system prompts, we drop the segment rather than risk leaking it.
const RULES: Rule[] = [
  {
    id: "secret:pem-private-key",
    kind: "secret",
    action: "DROP",
    regex: /-----BEGIN (EC|RSA|OPENSSH) PRIVATE KEY-----[\s\S]*?-----END (EC|RSA|OPENSSH) PRIVATE KEY-----/g,
  },
  {
    id: "secret:evm-private-key-hex64",
    kind: "secret",
    action: "REDACT",
    // Matches 64-char hex (private keys, tx hashes, etc.) - redact rather than drop
    // since many legitimate blockchain values match this pattern
    regex: /\b0x[a-fA-F0-9]{64}\b/g,
  },
  {
    id: "secret:openai-sk",
    kind: "secret",
    action: "REDACT",
    regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED_OPENAI_KEY]",
  },
  {
    id: "secret:jwt",
    kind: "secret",
    action: "REDACT",
    regex: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    id: "secret:bearer",
    kind: "secret",
    action: "REDACT",
    // JavaScript RegExp does not support inline (?i) flags; use /i instead.
    regex: /\bbearer\s+[A-Za-z0-9\-_.]{20,}\b/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    id: "secret:api-key-assignment",
    kind: "secret",
    action: "REDACT",
    regex: /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{8,}['\"]?/gi,
    replacement: "$1=[REDACTED_SECRET]",
  },

  // PII
  {
    id: "pii:email",
    kind: "pii",
    action: "REDACT",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    id: "pii:phone",
    kind: "pii",
    action: "REDACT",
    regex: /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    replacement: "[REDACTED_PHONE]",
  },
  {
    id: "pii:ip",
    kind: "pii",
    action: "REDACT",
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    replacement: "[REDACTED_IP]",
  },

  // Prompt / instruction leakage
  {
    id: "prompt:system-role",
    kind: "prompt",
    action: "DROP",
    regex: /\b(you are chatgpt|system prompt|developer message|tools available|follow these defaults)\b/i,
  },
];

function countMatches(regex: RegExp, text: string): number {
  if (!regex.global) {
    const m = text.match(regex);
    return m ? 1 : 0;
  }
  const m = text.match(regex);
  return m ? m.length : 0;
}

function applyRules(text: string): {
  text: string;
  dropped: boolean;
  hits: Map<string, { rule: Rule; count: number }>;
} {
  let out = text;
  let dropped = false;
  const hits = new Map<string, { rule: Rule; count: number }>();

  for (const rule of RULES) {
    const c = countMatches(rule.regex, out);
    if (c <= 0) continue;

    hits.set(rule.id, { rule, count: c });

    if (rule.action === "DROP") {
      dropped = true;
      // We still continue scanning to provide a complete report.
      continue;
    }

    out = out.replace(rule.regex, rule.replacement ?? "[REDACTED]");
  }

  return { text: out, dropped, hits };
}

export function sanitizeInsights(insights: Insight[]): {
  sanitized: Insight[];
  report: PrivacyReport;
} {
  const sanitized: Insight[] = [];

  const hitAgg = new Map<string, PrivacyRuleHit>();
  let secretsRemoved = 0;
  let piiRemoved = 0;
  let dropped = 0;
  const notes: string[] = [];

  for (const i of insights) {
    const titleRes = applyRules(i.title);
    const contentRes = applyRules(i.content);

    for (const res of [titleRes, contentRes]) {
      for (const [id, h] of res.hits.entries()) {
        const prev = hitAgg.get(id);
        const merged: PrivacyRuleHit = {
          ruleId: id,
          kind: h.rule.kind,
          action: h.rule.action,
          count: (prev?.count ?? 0) + h.count,
        };
        hitAgg.set(id, merged);

        if (h.rule.kind === "secret" && h.rule.action === "REDACT") secretsRemoved += h.count;
        if (h.rule.kind === "pii" && h.rule.action === "REDACT") piiRemoved += h.count;
      }
    }

    if (titleRes.dropped || contentRes.dropped) {
      dropped += 1;
      continue;
    }

    sanitized.push({
      ...i,
      id: i.id || crypto.randomUUID(),
      title: titleRes.text,
      content: contentRes.text,
    });
  }

  const hits = Array.from(hitAgg.values());
  const hasDropSecretOrPrompt = hits.some((h) => h.action === "DROP" && (h.kind === "secret" || h.kind === "prompt"));

  if (hasDropSecretOrPrompt) {
    notes.push("High-risk content was detected (secrets/prompts). Those segments were dropped.");
  }
  if (dropped > 0) notes.push(`Dropped ${dropped} insight(s) due to high-risk matches.`);

  const leakageRiskScore = clamp01((secretsRemoved > 0 ? 0.4 : 0) + (piiRemoved > 0 ? 0.15 : 0) + (dropped > 0 ? 0.5 : 0));

  const report: PrivacyReport = {
    blocked: hasDropSecretOrPrompt,
    summary: {
      secretsRemoved,
      piiRemoved,
      highRiskSegmentsDropped: dropped,
    },
    hits,
    notes,
    leakageRiskScore,
  };

  return { sanitized, report };
}
