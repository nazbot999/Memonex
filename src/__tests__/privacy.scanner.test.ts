import { describe, it, expect } from "vitest";
import { scanForPrivacy, applyPrivacyActions } from "../privacy.scanner.js";
import { makeKnowledgePackage } from "./helpers.js";

describe("privacy scanner — detection", () => {
  it("detects bearer tokens", () => {
    const pkg = makeKnowledgePackage({
      insights: [
        { title: "Auth", content: "Use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 for authentication" },
      ],
    });
    const flags = scanForPrivacy(pkg);
    const bearerFlags = flags.filter((f) => f.pattern === "Bearer token");
    expect(bearerFlags.length).toBeGreaterThanOrEqual(1);
  });

  it("detects API keys", () => {
    const pkg = makeKnowledgePackage({
      insights: [
        { title: "Key", content: "The key is sk_live_abcdefghijk12345" },
      ],
    });
    const flags = scanForPrivacy(pkg);
    const keyFlags = flags.filter((f) => f.pattern === "sk_live API key");
    expect(keyFlags.length).toBeGreaterThanOrEqual(1);
  });

  it("detects email addresses", () => {
    const pkg = makeKnowledgePackage({
      insights: [
        { title: "Contact", content: "Email: user@example.com for support" },
      ],
    });
    const flags = scanForPrivacy(pkg);
    const emailFlags = flags.filter((f) => f.pattern === "Email address");
    expect(emailFlags.length).toBeGreaterThanOrEqual(1);
  });

  it("detects IP addresses", () => {
    const pkg = makeKnowledgePackage({
      insights: [
        { title: "Server", content: "Connect to 192.168.1.100 for the API" },
      ],
    });
    const flags = scanForPrivacy(pkg);
    const ipFlags = flags.filter((f) => f.pattern === "IP address");
    expect(ipFlags.length).toBeGreaterThanOrEqual(1);
  });
});

describe("privacy scanner — redaction", () => {
  it("redacts flagged content", () => {
    const pkg = makeKnowledgePackage({
      insights: [
        { title: "Auth", content: "Use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 to authenticate" },
      ],
    });
    const flags = scanForPrivacy(pkg);
    const { cleaned } = applyPrivacyActions(pkg, flags);
    expect(cleaned.insights[0].content).toContain("[REDACTED_TOKEN]");
    expect(cleaned.insights[0].content).not.toContain("eyJhbGci");
  });

  it("preserves content when action is KEEP (override)", () => {
    const pkg = makeKnowledgePackage({
      insights: [
        { title: "Email", content: "Contact: user@example.com" },
      ],
    });
    const flags = scanForPrivacy(pkg);
    // Simulate seller override to KEEP
    for (const flag of flags) {
      flag.action = "KEEP";
      flag.overridden = true;
    }
    const { cleaned, review } = applyPrivacyActions(pkg, flags);
    expect(cleaned.insights[0].content).toContain("user@example.com");
    expect(review.summary.kept).toBeGreaterThanOrEqual(1);
    expect(review.summary.overridden).toBeGreaterThanOrEqual(1);
  });
});
