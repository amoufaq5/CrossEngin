import { createHash } from "node:crypto";

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export function hashStatement(sql: string): string {
  const normalized = normalizeSql(sql);
  const hex = createHash("sha256").update(normalized, "utf8").digest("hex");
  return hex;
}

export function isStatementHash(value: string): boolean {
  return SHA256_HEX_REGEX.test(value);
}

export function excerptStatement(sql: string, maxLength = 200): string {
  const normalized = normalizeSql(sql);
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 1) + "…";
}
