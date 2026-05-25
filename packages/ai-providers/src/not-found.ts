export const NOT_FOUND_ERROR_KINDS = ["not_found_error"] as const;
export type NotFoundErrorKind = (typeof NOT_FOUND_ERROR_KINDS)[number];

export interface NotFoundDiscriminator {
  readonly kind: string;
}

export function isNotFoundErrorKind(value: string): value is NotFoundErrorKind {
  return (NOT_FOUND_ERROR_KINDS as readonly string[]).includes(value);
}

export function isNotFoundError(err: unknown): err is Error & { readonly kind: NotFoundErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isNotFoundErrorKind(kind);
}
