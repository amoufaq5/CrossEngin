export const CONFLICT_ERROR_KINDS = ["conflict_error"] as const;
export type ConflictErrorKind = (typeof CONFLICT_ERROR_KINDS)[number];

export interface ConflictDiscriminator {
  readonly kind: string;
}

export function isConflictErrorKind(value: string): value is ConflictErrorKind {
  return (CONFLICT_ERROR_KINDS as readonly string[]).includes(value);
}

export function isConflictError(
  err: unknown,
): err is Error & { readonly kind: ConflictErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isConflictErrorKind(kind);
}
