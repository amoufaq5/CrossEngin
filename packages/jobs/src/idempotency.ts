import { z } from "zod";
import { JobIdSchema } from "./types.js";

export const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._:/=+-]+$/, {
    message: "idempotency key may only contain ASCII alphanumerics and . _ : / = + -",
  });
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export interface IdempotencyKeyInput {
  readonly jobId: string;
  readonly eventId?: string;
  readonly tenantId?: string;
  readonly extras?: ReadonlyArray<readonly [string, string | number | boolean]>;
}

export function computeIdempotencyKey(input: IdempotencyKeyInput): IdempotencyKey {
  const jobId = JobIdSchema.parse(input.jobId);
  const parts: string[] = [`job=${jobId}`];
  if (input.tenantId !== undefined) {
    parts.push(`tenant=${input.tenantId}`);
  }
  if (input.eventId !== undefined) {
    parts.push(`event=${input.eventId}`);
  }
  if (input.extras) {
    for (const [k, v] of [...input.extras].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      parts.push(`${k}=${String(v)}`);
    }
  }
  const key = parts.join(":");
  return IdempotencyKeySchema.parse(key);
}

export function isIdempotencyKey(value: unknown): value is IdempotencyKey {
  return IdempotencyKeySchema.safeParse(value).success;
}
