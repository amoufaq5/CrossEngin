export const INPUT_TOO_LARGE_ERROR_KINDS = ["request_too_large"] as const;
export type InputTooLargeErrorKind = (typeof INPUT_TOO_LARGE_ERROR_KINDS)[number];

export interface InputTooLargeDiscriminator {
  readonly kind: string;
}

export function isInputTooLargeErrorKind(value: string): value is InputTooLargeErrorKind {
  return (INPUT_TOO_LARGE_ERROR_KINDS as readonly string[]).includes(value);
}

export function isInputTooLargeError(
  err: unknown,
): err is Error & { readonly kind: InputTooLargeErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isInputTooLargeErrorKind(kind);
}
