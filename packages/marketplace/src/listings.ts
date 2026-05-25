import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const PACK_ID_REGEX = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}$/;
const SEMVER_REGEX =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const LISTING_STATUSES = ["draft", "submitted", "approved", "live", "delisted"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export const ListingStatusSchema = z.enum(LISTING_STATUSES);

export const LISTING_TRANSITIONS: Readonly<Record<ListingStatus, readonly ListingStatus[]>> =
  Object.freeze({
    draft: ["submitted", "delisted"],
    submitted: ["approved", "draft", "delisted"],
    approved: ["live", "delisted"],
    live: ["delisted"],
    delisted: ["draft"],
  });

export function canTransitionListing(from: ListingStatus, to: ListingStatus): boolean {
  return LISTING_TRANSITIONS[from].includes(to);
}

export const PRICING_MODELS = [
  "free",
  "one_time",
  "per_seat_monthly",
  "per_tenant_monthly",
  "metered",
  "request_quote",
] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];
export const PricingModelSchema = z.enum(PRICING_MODELS);

export const ListingPricingSchema = z
  .object({
    model: PricingModelSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    listPriceCents: z.number().int().nonnegative().nullable().default(null),
    freeTrialDays: z.number().int().min(0).max(90).default(0),
    revenueSharePercent: z.number().min(0).max(100).default(20),
  })
  .superRefine((v, ctx) => {
    if (v.model === "free" && v.listPriceCents !== null && v.listPriceCents !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["listPriceCents"],
        message: "free model requires listPriceCents=null or 0",
      });
    }
    if (
      (v.model === "one_time" ||
        v.model === "per_seat_monthly" ||
        v.model === "per_tenant_monthly") &&
      v.listPriceCents === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["listPriceCents"],
        message: `pricing model '${v.model}' requires listPriceCents`,
      });
    }
    if (v.model === "request_quote" && v.listPriceCents !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["listPriceCents"],
        message: "request_quote model must not declare listPriceCents",
      });
    }
    if (v.model === "free" && v.freeTrialDays > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["freeTrialDays"],
        message: "free model cannot declare freeTrialDays (already free)",
      });
    }
  });
export type ListingPricing = z.infer<typeof ListingPricingSchema>;

export const MarketplaceListingSchema = z
  .object({
    id: z.string().min(1),
    packId: z.string().regex(PACK_ID_REGEX),
    title: z.string().min(1).max(80),
    tagline: z.string().min(1).max(160),
    longDescription: z.string().min(1).max(10_000),
    heroImageUrl: z.string().url(),
    screenshotUrls: z.array(z.string().url()).max(8).default([]),
    videoUrl: z.string().url().optional(),
    status: ListingStatusSchema,
    pricing: ListingPricingSchema,
    publishedVersion: z.string().regex(SEMVER_REGEX).nullable().default(null),
    submittedAt: Iso8601.nullable().default(null),
    submittedBy: z.string().min(1).nullable().default(null),
    approvedAt: Iso8601.nullable().default(null),
    approvedBy: z.string().min(1).nullable().default(null),
    liveAt: Iso8601.nullable().default(null),
    delistedAt: Iso8601.nullable().default(null),
    delistedReason: z.string().min(1).optional(),
    installCount: z.number().int().nonnegative().default(0),
    averageRating: z.number().min(0).max(5).nullable().default(null),
    ratingCount: z.number().int().nonnegative().default(0),
  })
  .superRefine((v, ctx) => {
    if (v.status === "submitted" || v.status === "approved" || v.status === "live") {
      if (v.submittedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["submittedAt"],
          message: `status '${v.status}' requires submittedAt`,
        });
      }
      if (v.submittedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["submittedBy"],
          message: `status '${v.status}' requires submittedBy`,
        });
      }
    }
    if (v.status === "approved" || v.status === "live") {
      if (v.approvedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvedAt"],
          message: `status '${v.status}' requires approvedAt`,
        });
      }
      if (v.approvedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["approvedBy"],
          message: `status '${v.status}' requires approvedBy`,
        });
      }
    }
    if (v.status === "live") {
      if (v.liveAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["liveAt"],
          message: "live status requires liveAt",
        });
      }
      if (v.publishedVersion === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publishedVersion"],
          message: "live status requires publishedVersion",
        });
      }
    }
    if (v.status === "delisted") {
      if (v.delistedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["delistedAt"],
          message: "delisted status requires delistedAt",
        });
      }
      if (v.delistedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["delistedReason"],
          message: "delisted status requires delistedReason",
        });
      }
    }
    if (v.ratingCount === 0 && v.averageRating !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["averageRating"],
        message: "averageRating must be null when ratingCount=0",
      });
    }
    if (v.ratingCount > 0 && v.averageRating === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["averageRating"],
        message: "averageRating must be present when ratingCount>0",
      });
    }
  });
export type MarketplaceListing = z.infer<typeof MarketplaceListingSchema>;

export const PackReviewSchema = z
  .object({
    id: z.string().min(1),
    packId: z.string().regex(PACK_ID_REGEX),
    tenantId: z.string().min(1),
    authorId: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(2_000),
    verifiedInstall: z.boolean(),
    submittedAt: Iso8601,
    editedAt: Iso8601.nullable().default(null),
    moderationStatus: z.enum(["published", "pending", "hidden"]).default("published"),
    hiddenReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.moderationStatus === "hidden" && v.hiddenReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hiddenReason"],
        message: "hidden moderationStatus requires hiddenReason",
      });
    }
    if (v.editedAt !== null && new Date(v.editedAt).getTime() < new Date(v.submittedAt).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["editedAt"],
        message: "editedAt cannot be before submittedAt",
      });
    }
  });
export type PackReview = z.infer<typeof PackReviewSchema>;

export function recomputeRating(reviews: readonly PackReview[]): {
  readonly averageRating: number | null;
  readonly ratingCount: number;
} {
  const visible = reviews.filter((r) => r.moderationStatus === "published");
  if (visible.length === 0) return { averageRating: null, ratingCount: 0 };
  const sum = visible.reduce((acc, r) => acc + r.rating, 0);
  return {
    averageRating: Math.round((sum / visible.length) * 100) / 100,
    ratingCount: visible.length,
  };
}

export function isListingDiscoverable(listing: MarketplaceListing): boolean {
  return listing.status === "live";
}
