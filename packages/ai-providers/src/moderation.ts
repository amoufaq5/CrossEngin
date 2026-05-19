export const MODERATION_ERROR_KINDS = [
  "guardrail_intervened",
  "content_filtered",
  "refusal",
] as const;
export type ModerationErrorKind = (typeof MODERATION_ERROR_KINDS)[number];

export interface ModerationDiscriminator {
  readonly kind: string;
}

export function isModerationErrorKind(value: string): value is ModerationErrorKind {
  return (MODERATION_ERROR_KINDS as readonly string[]).includes(value);
}

export function isModerationError(
  err: unknown,
): err is Error & { readonly kind: ModerationErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isModerationErrorKind(kind);
}
