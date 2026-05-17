import { z } from "zod";

const COUNTRY_REGEX = /^[A-Z]{2}$/;

export const CountryCodeSchema = z.string().regex(COUNTRY_REGEX, {
  message: "country must be an ISO 3166-1 alpha-2 code",
});

export const TaxAddressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().min(1).optional(),
  postalCode: z.string().min(1).optional(),
  country: CountryCodeSchema,
});
export type TaxAddress = z.infer<typeof TaxAddressSchema>;

export const TAX_KINDS = ["vat", "gst", "sales_tax", "none"] as const;
export type TaxKind = (typeof TAX_KINDS)[number];

export interface TaxRateEntry {
  readonly country: string;
  readonly region?: string;
  readonly kind: TaxKind;
  readonly ratePercent: number;
  readonly reverseChargeEligible: boolean;
}

export const STATUTORY_TAX_RATES: ReadonlyArray<TaxRateEntry> = Object.freeze([
  { country: "AE", kind: "vat", ratePercent: 5, reverseChargeEligible: false },
  { country: "SA", kind: "vat", ratePercent: 15, reverseChargeEligible: false },
  { country: "OM", kind: "vat", ratePercent: 5, reverseChargeEligible: false },
  { country: "BH", kind: "vat", ratePercent: 10, reverseChargeEligible: false },
  { country: "KW", kind: "none", ratePercent: 0, reverseChargeEligible: false },
  { country: "QA", kind: "none", ratePercent: 0, reverseChargeEligible: false },
  { country: "DE", kind: "vat", ratePercent: 19, reverseChargeEligible: true },
  { country: "FR", kind: "vat", ratePercent: 20, reverseChargeEligible: true },
  { country: "ES", kind: "vat", ratePercent: 21, reverseChargeEligible: true },
  { country: "IT", kind: "vat", ratePercent: 22, reverseChargeEligible: true },
  { country: "NL", kind: "vat", ratePercent: 21, reverseChargeEligible: true },
  { country: "PT", kind: "vat", ratePercent: 23, reverseChargeEligible: true },
  { country: "GB", kind: "vat", ratePercent: 20, reverseChargeEligible: false },
  { country: "TR", kind: "vat", ratePercent: 20, reverseChargeEligible: false },
  { country: "US", kind: "sales_tax", ratePercent: 0, reverseChargeEligible: false },
]);

export function rateFor(
  address: TaxAddress,
  rates: ReadonlyArray<TaxRateEntry> = STATUTORY_TAX_RATES,
): TaxRateEntry {
  const exact = rates.find((r) => r.country === address.country && r.region === address.region);
  if (exact !== undefined) return exact;
  const country = rates.find((r) => r.country === address.country && r.region === undefined);
  if (country !== undefined) return country;
  return { country: address.country, kind: "none", ratePercent: 0, reverseChargeEligible: false };
}

export interface TaxComputation {
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly appliedRate: TaxRateEntry;
  readonly reverseCharged: boolean;
}

export interface TaxComputationInput {
  readonly subtotalCents: number;
  readonly address: TaxAddress;
  readonly isB2b: boolean;
  readonly hasValidVatId?: boolean;
  readonly rates?: ReadonlyArray<TaxRateEntry>;
}

export function computeTax(input: TaxComputationInput): TaxComputation {
  if (input.subtotalCents < 0) {
    throw new Error("subtotalCents must be non-negative");
  }
  const rate = rateFor(input.address, input.rates);
  const reverseCharged =
    input.isB2b === true && rate.reverseChargeEligible && input.hasValidVatId === true;
  const taxCents = reverseCharged
    ? 0
    : Math.round((input.subtotalCents * rate.ratePercent) / 100);
  return {
    subtotalCents: input.subtotalCents,
    taxCents,
    totalCents: input.subtotalCents + taxCents,
    appliedRate: rate,
    reverseCharged,
  };
}
