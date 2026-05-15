import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const EDISCOVERY_ID_REGEX = /^ED-\d{4}-\d{4,8}$/;

export const EDISCOVERY_STATUSES = [
  "requested",
  "scoped",
  "running",
  "producing",
  "delivered",
  "objected",
  "complete",
  "withdrawn",
] as const;
export type EDiscoveryStatus = (typeof EDISCOVERY_STATUSES)[number];
export const EDiscoveryStatusSchema = z.enum(EDISCOVERY_STATUSES);

export const EDISCOVERY_TRANSITIONS: Readonly<
  Record<EDiscoveryStatus, readonly EDiscoveryStatus[]>
> = Object.freeze({
  requested: ["scoped", "withdrawn", "objected"],
  scoped: ["running", "withdrawn", "objected"],
  running: ["producing", "objected"],
  producing: ["delivered", "objected"],
  delivered: ["complete", "objected"],
  objected: ["scoped", "withdrawn"],
  complete: [],
  withdrawn: [],
});

export function canTransitionEDiscovery(
  from: EDiscoveryStatus,
  to: EDiscoveryStatus,
): boolean {
  return EDISCOVERY_TRANSITIONS[from].includes(to);
}

export const PRODUCTION_FORMATS = [
  "native",
  "pdf_with_load_file",
  "tiff_with_load_file",
  "csv",
  "json",
] as const;
export type ProductionFormat = (typeof PRODUCTION_FORMATS)[number];

export const SearchScopeSchema = z
  .object({
    tenantIds: z.array(z.string().min(1)).default([]),
    custodianUserIds: z.array(z.string().min(1)).default([]),
    dataClasses: z.array(z.string().min(1)).default([]),
    dateRangeStart: Iso8601,
    dateRangeEnd: Iso8601,
    keywordsAllOf: z.array(z.string().min(1)).default([]),
    keywordsAnyOf: z.array(z.string().min(1)).default([]),
    keywordsNoneOf: z.array(z.string().min(1)).default([]),
    excludePrivilegedContent: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (new Date(v.dateRangeEnd).getTime() <= new Date(v.dateRangeStart).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateRangeEnd"],
        message: "dateRangeEnd must be after dateRangeStart",
      });
    }
    const allKeywords =
      v.keywordsAllOf.length + v.keywordsAnyOf.length + v.keywordsNoneOf.length;
    if (allKeywords === 0 && v.custodianUserIds.length === 0 && v.tenantIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keywordsAllOf"],
        message:
          "search scope must declare at least one of: tenantIds, custodianUserIds, or keywords (overbroad search disallowed)",
      });
    }
  });
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const EDiscoveryRequestSchema = z
  .object({
    id: z.string().regex(EDISCOVERY_ID_REGEX, {
      message: "ediscovery id must match 'ED-YYYY-NNNN'",
    }),
    matterReference: z.string().min(1),
    requestingParty: z.string().min(1),
    legalCounselId: z.string().min(1),
    status: EDiscoveryStatusSchema,
    relatedLegalHoldIds: z.array(z.string().min(1)).min(1),
    scope: SearchScopeSchema,
    productionFormat: z.enum(PRODUCTION_FORMATS),
    requestedAt: Iso8601,
    requestedBy: z.string().min(1),
    scopedAt: Iso8601.nullable().default(null),
    scopedBy: z.string().min(1).nullable().default(null),
    runStartedAt: Iso8601.nullable().default(null),
    deliveredAt: Iso8601.nullable().default(null),
    completeAt: Iso8601.nullable().default(null),
    objectionReason: z.string().min(1).optional(),
    withdrawnReason: z.string().min(1).optional(),
    estimatedDocumentCount: z.number().int().nonnegative().optional(),
    producedDocumentCount: z.number().int().nonnegative().nullable().default(null),
    producedSizeBytes: z.number().int().nonnegative().nullable().default(null),
    productionSha256: z.string().regex(SHA256_REGEX).nullable().default(null),
    productionStorageUri: z.string().min(1).nullable().default(null),
    privilegedExclusionCount: z.number().int().nonnegative().default(0),
    deadlineAt: Iso8601,
  })
  .superRefine((v, ctx) => {
    if (
      new Date(v.deadlineAt).getTime() <= new Date(v.requestedAt).getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineAt"],
        message: "deadlineAt must be after requestedAt",
      });
    }
    if (
      (v.status === "scoped" ||
        v.status === "running" ||
        v.status === "producing" ||
        v.status === "delivered" ||
        v.status === "complete") &&
      (v.scopedAt === null || v.scopedBy === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopedAt"],
        message: `status '${v.status}' requires scopedAt + scopedBy`,
      });
    }
    if (v.status === "delivered" || v.status === "complete") {
      if (v.deliveredAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deliveredAt"],
          message: `status '${v.status}' requires deliveredAt`,
        });
      }
      if (v.producedDocumentCount === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["producedDocumentCount"],
          message: `status '${v.status}' requires producedDocumentCount`,
        });
      }
      if (v.productionSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["productionSha256"],
          message: `status '${v.status}' requires productionSha256 (cryptographic proof)`,
        });
      }
      if (v.productionStorageUri === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["productionStorageUri"],
          message: `status '${v.status}' requires productionStorageUri`,
        });
      }
    }
    if (v.status === "complete" && v.completeAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completeAt"],
        message: "complete status requires completeAt",
      });
    }
    if (v.status === "objected" && v.objectionReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objectionReason"],
        message: "objected status requires objectionReason",
      });
    }
    if (v.status === "withdrawn" && v.withdrawnReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["withdrawnReason"],
        message: "withdrawn status requires withdrawnReason",
      });
    }
    if (v.requestingParty === v.legalCounselId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["legalCounselId"],
        message:
          "requestingParty cannot also be legalCounselId (separation of party and counsel)",
      });
    }
    const holds = new Set<string>();
    v.relatedLegalHoldIds.forEach((h, i) => {
      if (holds.has(h)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["relatedLegalHoldIds", i],
          message: `duplicate legal hold '${h}'`,
        });
      }
      holds.add(h);
    });
  });
export type EDiscoveryRequest = z.infer<typeof EDiscoveryRequestSchema>;

export function isPastDeadline(
  request: EDiscoveryRequest,
  now: Date = new Date(),
): boolean {
  if (request.status === "complete" || request.status === "withdrawn") return false;
  return now.getTime() > new Date(request.deadlineAt).getTime();
}

export function productionRatio(request: EDiscoveryRequest): number | null {
  if (
    request.producedDocumentCount === null ||
    request.estimatedDocumentCount === undefined ||
    request.estimatedDocumentCount === 0
  ) {
    return null;
  }
  return (
    Math.round(
      (request.producedDocumentCount / request.estimatedDocumentCount) * 100,
    ) / 100
  );
}

export function daysUntilDeadline(
  request: EDiscoveryRequest,
  now: Date = new Date(),
): number {
  return Math.floor(
    (new Date(request.deadlineAt).getTime() - now.getTime()) / 1000 / 86_400,
  );
}
