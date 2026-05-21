const REDACTION = "[REDACTED_SECRET]";

const SECRET_PATTERNS = [
  /\bsk-or-v1-[A-Za-z0-9._-]{12,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bgh[pousr]_[0-9A-Za-z_]{20,}\b/g,
  /\bgsk_[0-9A-Za-z_]{12,}\b/g,
  /\bcsk-[0-9A-Za-z_-]{12,}\b/g,
  /\b(?:zai|glm)-[0-9A-Za-z._-]{12,}\b/gi,
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecrets(text: string | null | undefined, secretValues: string[] = []): string {
  if (!text) return text || "";

  let redacted = text;
  const uniqueSecrets = Array.from(new Set(secretValues))
    .filter(value => value && value.length >= 8)
    .sort((a, b) => b.length - a.length);

  for (const secret of uniqueSecrets) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), REDACTION);
  }

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTION);
  }

  return redacted;
}

export function isVisualArtifactMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return /^(image|video)\//.test(mime) || mime === "application/pdf";
}
