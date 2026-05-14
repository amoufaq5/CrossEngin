import { describe, expect, it } from "vitest";
import {
  LISTING_STATUSES,
  ListingPricingSchema,
  MarketplaceListingSchema,
  PRICING_MODELS,
  PackReviewSchema,
  canTransitionListing,
  isListingDiscoverable,
  recomputeRating,
  type ListingPricing,
  type MarketplaceListing,
  type PackReview,
} from "./listings.js";

describe("constants", () => {
  it("LISTING_STATUSES has 5 entries", () => {
    expect(LISTING_STATUSES).toEqual([
      "draft",
      "submitted",
      "approved",
      "live",
      "delisted",
    ]);
  });

  it("PRICING_MODELS has 6 entries", () => {
    expect(PRICING_MODELS).toContain("free");
    expect(PRICING_MODELS).toContain("metered");
    expect(PRICING_MODELS).toContain("request_quote");
  });
});

describe("canTransitionListing", () => {
  it("draft -> submitted", () => {
    expect(canTransitionListing("draft", "submitted")).toBe(true);
  });

  it("submitted -> approved", () => {
    expect(canTransitionListing("submitted", "approved")).toBe(true);
  });

  it("approved -> live", () => {
    expect(canTransitionListing("approved", "live")).toBe(true);
  });

  it("delisted -> draft (republish)", () => {
    expect(canTransitionListing("delisted", "draft")).toBe(true);
  });

  it("draft -> live is not allowed (must go through approval)", () => {
    expect(canTransitionListing("draft", "live")).toBe(false);
  });
});

describe("ListingPricingSchema", () => {
  const base: ListingPricing = {
    model: "per_tenant_monthly",
    currency: "USD",
    listPriceCents: 9900,
    freeTrialDays: 14,
    revenueSharePercent: 20,
  };

  it("accepts a valid recurring price", () => {
    expect(() => ListingPricingSchema.parse(base)).not.toThrow();
  });

  it("rejects free model with non-zero listPriceCents", () => {
    expect(() =>
      ListingPricingSchema.parse({ ...base, model: "free", listPriceCents: 100 }),
    ).toThrow(/free model/);
  });

  it("rejects per_seat without listPriceCents", () => {
    expect(() =>
      ListingPricingSchema.parse({
        ...base,
        model: "per_seat_monthly",
        listPriceCents: null,
      }),
    ).toThrow(/requires listPriceCents/);
  });

  it("rejects request_quote with listPriceCents", () => {
    expect(() =>
      ListingPricingSchema.parse({ ...base, model: "request_quote", listPriceCents: 100 }),
    ).toThrow(/must not declare listPriceCents/);
  });

  it("rejects free model with freeTrialDays > 0", () => {
    expect(() =>
      ListingPricingSchema.parse({
        ...base,
        model: "free",
        listPriceCents: null,
        freeTrialDays: 7,
      }),
    ).toThrow(/cannot declare freeTrialDays/);
  });

  it("rejects malformed currency", () => {
    expect(() =>
      ListingPricingSchema.parse({ ...base, currency: "usd" }),
    ).toThrow();
  });
});

describe("MarketplaceListingSchema", () => {
  const base: MarketplaceListing = {
    id: "listing-1",
    packId: "com.crossengin.pharmacy",
    title: "Pharmacy Pack",
    tagline: "Run a pharmacy on CrossEngin",
    longDescription: "A complete pharmacy workflow…",
    heroImageUrl: "https://cdn.crossengin.io/p/hero.png",
    screenshotUrls: [],
    status: "live",
    pricing: {
      model: "per_tenant_monthly",
      currency: "USD",
      listPriceCents: 9900,
      freeTrialDays: 14,
      revenueSharePercent: 20,
    },
    publishedVersion: "1.0.0",
    submittedAt: "2026-05-01T00:00:00Z",
    submittedBy: "publisher-1",
    approvedAt: "2026-05-05T00:00:00Z",
    approvedBy: "reviewer-1",
    liveAt: "2026-05-10T00:00:00Z",
    delistedAt: null,
    installCount: 42,
    averageRating: 4.5,
    ratingCount: 10,
  };

  it("accepts a valid live listing", () => {
    expect(() => MarketplaceListingSchema.parse(base)).not.toThrow();
  });

  it("rejects live without publishedVersion", () => {
    expect(() =>
      MarketplaceListingSchema.parse({ ...base, publishedVersion: null }),
    ).toThrow(/publishedVersion/);
  });

  it("rejects approved without approvedBy", () => {
    expect(() =>
      MarketplaceListingSchema.parse({
        ...base,
        status: "approved",
        approvedBy: null,
        liveAt: null,
      }),
    ).toThrow(/approvedBy/);
  });

  it("rejects delisted without delistedReason", () => {
    expect(() =>
      MarketplaceListingSchema.parse({
        ...base,
        status: "delisted",
        delistedAt: "2026-05-12T00:00:00Z",
        liveAt: null,
        publishedVersion: null,
      }),
    ).toThrow(/delistedReason/);
  });

  it("rejects averageRating non-null when ratingCount=0", () => {
    expect(() =>
      MarketplaceListingSchema.parse({
        ...base,
        averageRating: 4.5,
        ratingCount: 0,
      }),
    ).toThrow(/averageRating must be null/);
  });

  it("rejects averageRating null when ratingCount>0", () => {
    expect(() =>
      MarketplaceListingSchema.parse({
        ...base,
        averageRating: null,
        ratingCount: 10,
      }),
    ).toThrow(/averageRating must be present/);
  });

  it("rejects more than 8 screenshots", () => {
    expect(() =>
      MarketplaceListingSchema.parse({
        ...base,
        screenshotUrls: Array.from({ length: 9 }, (_, i) => `https://x/${i}.png`),
      }),
    ).toThrow();
  });
});

describe("PackReviewSchema", () => {
  const base: PackReview = {
    id: "rev-1",
    packId: "com.crossengin.x",
    tenantId: "t-1",
    authorId: "u-1",
    rating: 5,
    title: "Great",
    body: "Loved it.",
    verifiedInstall: true,
    submittedAt: "2026-05-14T10:00:00Z",
    editedAt: null,
    moderationStatus: "published",
  };

  it("accepts a valid review", () => {
    expect(() => PackReviewSchema.parse(base)).not.toThrow();
  });

  it("rejects rating out of 1..5", () => {
    expect(() => PackReviewSchema.parse({ ...base, rating: 6 })).toThrow();
    expect(() => PackReviewSchema.parse({ ...base, rating: 0 })).toThrow();
  });

  it("rejects hidden without hiddenReason", () => {
    expect(() =>
      PackReviewSchema.parse({ ...base, moderationStatus: "hidden" }),
    ).toThrow(/hiddenReason/);
  });

  it("rejects editedAt before submittedAt", () => {
    expect(() =>
      PackReviewSchema.parse({
        ...base,
        editedAt: "2026-05-13T00:00:00Z",
      }),
    ).toThrow(/cannot be before submittedAt/);
  });
});

describe("recomputeRating", () => {
  const review = (rating: number, status: "published" | "hidden" = "published"): PackReview => ({
    id: `r-${rating}-${status}`,
    packId: "com.crossengin.x",
    tenantId: "t-1",
    authorId: `u-${rating}`,
    rating,
    title: "x",
    body: "x",
    verifiedInstall: true,
    submittedAt: "2026-05-14T10:00:00Z",
    editedAt: null,
    moderationStatus: status,
    hiddenReason: status === "hidden" ? "spam" : undefined,
  });

  it("returns null/0 for empty input", () => {
    expect(recomputeRating([])).toEqual({ averageRating: null, ratingCount: 0 });
  });

  it("averages published reviews", () => {
    const r = recomputeRating([review(5), review(4), review(3)]);
    expect(r.ratingCount).toBe(3);
    expect(r.averageRating).toBe(4);
  });

  it("excludes hidden reviews", () => {
    const r = recomputeRating([review(5), review(1, "hidden")]);
    expect(r.ratingCount).toBe(1);
    expect(r.averageRating).toBe(5);
  });

  it("rounds to two decimals", () => {
    const r = recomputeRating([review(5), review(4)]);
    expect(r.averageRating).toBe(4.5);
  });
});

describe("isListingDiscoverable", () => {
  it("returns true only for live status", () => {
    const make = (status: MarketplaceListing["status"]): MarketplaceListing => ({
      id: "x",
      packId: "com.crossengin.x",
      title: "x",
      tagline: "x",
      longDescription: "x",
      heroImageUrl: "https://x/img.png",
      screenshotUrls: [],
      status,
      pricing: {
        model: "free",
        currency: "USD",
        listPriceCents: null,
        freeTrialDays: 0,
        revenueSharePercent: 0,
      },
      publishedVersion: status === "live" ? "1.0.0" : null,
      submittedAt: "2026-05-01T00:00:00Z",
      submittedBy: "x",
      approvedAt: status === "live" || status === "approved" ? "2026-05-05T00:00:00Z" : null,
      approvedBy: status === "live" || status === "approved" ? "x" : null,
      liveAt: status === "live" ? "2026-05-10T00:00:00Z" : null,
      delistedAt: status === "delisted" ? "2026-05-12T00:00:00Z" : null,
      delistedReason: status === "delisted" ? "spam" : undefined,
      installCount: 0,
      averageRating: null,
      ratingCount: 0,
    });
    expect(isListingDiscoverable(make("live"))).toBe(true);
    expect(isListingDiscoverable(make("approved"))).toBe(false);
    expect(isListingDiscoverable(make("draft"))).toBe(false);
  });
});
