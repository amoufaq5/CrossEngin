import type { Manifest } from "@crossengin/kernel/manifest";
import { buildErpCorePack, ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";

export interface PackEntry {
  readonly slug: string;
  readonly description: string;
  readonly build: () => Manifest;
}

export const PACK_REGISTRY: Readonly<Record<string, PackEntry>> = {
  [ERP_CORE_PACK_SLUG]: {
    slug: ERP_CORE_PACK_SLUG,
    description:
      "Core ERP entities (Account, Contact, Invoice, InvoiceLine) with billing workflow.",
    build: () => buildErpCorePack(),
  },
};

export class UnknownPackError extends Error {
  readonly kind = "unknown_pack" as const;
  readonly slug: string;
  readonly available: readonly string[];

  constructor(slug: string, available: readonly string[]) {
    super(
      `unknown pack '${slug}'. Available: ${available.length > 0 ? available.join(", ") : "(none)"}`,
    );
    this.name = "UnknownPackError";
    this.slug = slug;
    this.available = available;
  }
}

export function resolvePack(slug: string): PackEntry {
  const entry = PACK_REGISTRY[slug];
  if (entry === undefined) {
    throw new UnknownPackError(slug, listAvailablePacks());
  }
  return entry;
}

export function listAvailablePacks(): readonly string[] {
  return Object.keys(PACK_REGISTRY).sort();
}
