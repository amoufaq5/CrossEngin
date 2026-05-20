export const INVALID_REQUEST_ERROR_KINDS = ["invalid_request_error"] as const;
export type InvalidRequestErrorKind =
  (typeof INVALID_REQUEST_ERROR_KINDS)[number];

export interface InvalidRequestDiscriminator {
  readonly kind: string;
}

export function isInvalidRequestErrorKind(
  value: string,
): value is InvalidRequestErrorKind {
  return (INVALID_REQUEST_ERROR_KINDS as readonly string[]).includes(value);
}

export function isInvalidRequestError(
  err: unknown,
): err is Error & { readonly kind: InvalidRequestErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isInvalidRequestErrorKind(kind);
}
