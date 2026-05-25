export const PERMISSION_ERROR_KINDS = ["permission_error"] as const;
export type PermissionErrorKind = (typeof PERMISSION_ERROR_KINDS)[number];

export interface PermissionDiscriminator {
  readonly kind: string;
}

export function isPermissionErrorKind(value: string): value is PermissionErrorKind {
  return (PERMISSION_ERROR_KINDS as readonly string[]).includes(value);
}

export function isPermissionError(
  err: unknown,
): err is Error & { readonly kind: PermissionErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isPermissionErrorKind(kind);
}
