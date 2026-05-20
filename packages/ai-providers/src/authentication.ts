export const AUTHENTICATION_ERROR_KINDS = ["authentication_error"] as const;
export type AuthenticationErrorKind =
  (typeof AUTHENTICATION_ERROR_KINDS)[number];

export interface AuthenticationDiscriminator {
  readonly kind: string;
}

export function isAuthenticationErrorKind(
  value: string,
): value is AuthenticationErrorKind {
  return (AUTHENTICATION_ERROR_KINDS as readonly string[]).includes(value);
}

export function isAuthenticationError(
  err: unknown,
): err is Error & { readonly kind: AuthenticationErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isAuthenticationErrorKind(kind);
}
