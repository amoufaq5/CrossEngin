import { z } from "zod";

export const ERROR_CATEGORIES = [
  "validation",
  "authentication",
  "authorization",
  "not_found",
  "conflict",
  "rate_limited",
  "internal",
  "dependency",
  "unsupported",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];
export const ErrorCategorySchema = z.enum(ERROR_CATEGORIES);

const ERROR_CODE_REGEX = /^[A-Z][A-Z0-9_]*$/;
export const ErrorCodeSchema = z.string().regex(ERROR_CODE_REGEX, {
  message: "error code must be SCREAMING_SNAKE_CASE",
});
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const FieldErrorSchema = z.object({
  field: z.string().min(1),
  code: ErrorCodeSchema,
  message: z.string().min(1),
});
export type FieldError = z.infer<typeof FieldErrorSchema>;

export const HTTP_STATUS_FOR_CATEGORY: Readonly<Record<ErrorCategory, number>> = Object.freeze({
  validation: 422,
  authentication: 401,
  authorization: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
  dependency: 502,
  unsupported: 415,
});

const TYPE_URI_REGEX = /^https?:\/\/[A-Za-z0-9.-]+\/errors\/[a-z][a-z0-9-]*$/;

export const ProblemDetailsSchema = z
  .object({
    type: z.string().regex(TYPE_URI_REGEX),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    detail: z.string().min(1),
    instance: z
      .string()
      .regex(/^\/[A-Za-z0-9._\-/]*$/)
      .optional(),
    code: ErrorCodeSchema,
    category: ErrorCategorySchema,
    errors: z.array(FieldErrorSchema).default([]),
    retryable: z.boolean().default(false),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
    traceId: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
    documentationUrl: z.string().url().optional(),
  })
  .superRefine((v, ctx) => {
    const expected = HTTP_STATUS_FOR_CATEGORY[v.category];
    if (v.status !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: `category '${v.category}' expects HTTP status ${expected}, got ${v.status}`,
      });
    }
    if (v.category === "validation" && v.errors.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errors"],
        message: "validation category requires at least one FieldError",
      });
    }
    if (v.category === "rate_limited" && v.retryAfterSeconds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryAfterSeconds"],
        message: "rate_limited category requires retryAfterSeconds",
      });
    }
    if (v.status >= 500 && !v.retryable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryable"],
        message: "5xx errors must be retryable=true",
      });
    }
    if (v.category === "validation" && v.retryable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryable"],
        message: "validation errors must not be retryable (client must fix the request)",
      });
    }
    const fieldNames = new Set<string>();
    v.errors.forEach((e, i) => {
      const dedupKey = `${e.field}|${e.code}`;
      if (fieldNames.has(dedupKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["errors", i],
          message: `duplicate FieldError for '${dedupKey}'`,
        });
      }
      fieldNames.add(dedupKey);
    });
  });
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export interface ProblemFactoryInput {
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
  readonly detail: string;
  readonly instance?: string;
  readonly errors?: readonly FieldError[];
  readonly retryAfterSeconds?: number;
  readonly traceId?: string;
  readonly title?: string;
  readonly documentationBase?: string;
}

export function problemFor(input: ProblemFactoryInput): ProblemDetails {
  const base = input.documentationBase ?? "https://docs.crossengin.io/errors";
  const slug = input.code.toLowerCase().replace(/_/g, "-");
  const status = HTTP_STATUS_FOR_CATEGORY[input.category];
  const errors = input.errors ?? [];
  return ProblemDetailsSchema.parse({
    type: `${base}/${slug}`,
    title: input.title ?? input.code.replace(/_/g, " ").toLowerCase(),
    status,
    detail: input.detail,
    instance: input.instance,
    code: input.code,
    category: input.category,
    errors,
    retryable: input.category === "rate_limited" || status >= 500,
    retryAfterSeconds: input.retryAfterSeconds,
    traceId: input.traceId,
  });
}

export function httpStatusForCategory(category: ErrorCategory): number {
  return HTTP_STATUS_FOR_CATEGORY[category];
}

export function isRetryable(problem: ProblemDetails): boolean {
  return problem.retryable;
}
