import type { Manifest, ManifestRegistry } from "@crossengin/kernel/manifest";
import { buildErpCorePack, ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import {
  buildErpHealthcarePack,
  ERP_HEALTHCARE_PACK_SLUG,
} from "@crossengin/pack-erp-healthcare";
import {
  buildErpPaymentsPack,
  ERP_PAYMENTS_PACK_SLUG,
} from "@crossengin/pack-erp-payments";

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
  [ERP_PAYMENTS_PACK_SLUG]: {
    slug: ERP_PAYMENTS_PACK_SLUG,
    description:
      "Payment entity + lifecycle workflow on top of operate-erp/core. Adds payment-provider webhook handler + settlement sweep jobs.",
    build: () => buildErpPaymentsPack(),
  },
  [ERP_HEALTHCARE_PACK_SLUG]: {
    slug: ERP_HEALTHCARE_PACK_SLUG,
    description:
      "Patient + Encounter + Observation entities on top of operate-erp/core. FHIR-shaped fields, encounter_lifecycle + observation_lifecycle workflows, HIPAA + 21 CFR 11 compliance defaults, FHIR R4 export job.",
    build: () => buildErpHealthcarePack(),
  },
};

export function packManifestRegistry(
  registry: Readonly<Record<string, PackEntry>> = PACK_REGISTRY,
): ManifestRegistry {
  return {
    async getManifest(slug: string): Promise<Manifest | null> {
      const entry = registry[slug];
      return entry !== undefined ? entry.build() : null;
    },
  };
}

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
