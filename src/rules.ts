// Shared regex patterns used by import.scanner.ts and privacy.scanner.ts
// to avoid duplication and ensure bug fixes propagate.

export const SHARED_PRIVACY_PATTERNS = {
  bearer: /\bBearer\s+[A-Za-z0-9\-_.]{16,}\b/gi,
  skLive: /\bsk_live_[A-Za-z0-9]{8,}\b/gi,
  evmPrivateKey: /\b0x[a-fA-F0-9]{64}\b/g,
  envAssignment:
    /\b(API_KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)\b\s*[:=]\s*['"]?[^\s'"\n]{4,}['"]?/gi,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  phone: /\b\+\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  ip: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  envName:
    /\b(API_KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)\b(?!\s*[:=])/gi,
} as const;

export const EVM_KEY_CONTEXT =
  /\b(private[_\s-]?key|secret[_\s-]?key|signing[_\s-]?key)\b/i;

export const EXFIL_CONTEXT = /\b(readFile|process\.env)\b/i;
