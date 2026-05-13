import { z } from "zod";

const BCP47_REGEX = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const CURRENCY_REGEX = /^[A-Z]{3}$/;
const IANA_REGEX = /^[A-Za-z]+(?:\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)?$|^UTC$/;

export const BCP47Schema = z.string().regex(BCP47_REGEX, {
  message: "locale must be BCP-47 (e.g., 'en', 'ar', 'en-US')",
});
export type Bcp47Locale = z.infer<typeof BCP47Schema>;

export const Iso4217CurrencySchema = z.string().regex(CURRENCY_REGEX, {
  message: "currency must be ISO 4217 (e.g., 'USD', 'AED')",
});

export const IanaTimezoneSchema = z.string().regex(IANA_REGEX, {
  message: "timezone must be IANA (e.g., 'Asia/Dubai', 'UTC')",
});

export const DIRECTIONS = ["ltr", "rtl"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const DATE_FORMATS = ["iso", "locale"] as const;
export type DateFormatPreset = (typeof DATE_FORMATS)[number];

export const I18nContextSchema = z.object({
  locale: BCP47Schema,
  direction: z.enum(DIRECTIONS),
  currency: Iso4217CurrencySchema,
  dateFormat: z.enum(DATE_FORMATS).default("locale"),
  timezone: IanaTimezoneSchema,
  firstDayOfWeek: z.number().int().min(0).max(6).default(1),
});
export type I18nContext = z.infer<typeof I18nContextSchema>;

const RTL_LOCALES = new Set<string>([
  "ar",
  "fa",
  "he",
  "ur",
  "ps",
  "ku",
  "yi",
  "sd",
  "ckb",
]);

export function directionFor(locale: Bcp47Locale): Direction {
  const base = locale.split("-")[0];
  if (base !== undefined && RTL_LOCALES.has(base)) return "rtl";
  return "ltr";
}

export const I18nBundleSchema = z
  .record(BCP47Schema, z.record(z.string().min(1), z.string()))
  .superRefine((bundle, ctx) => {
    const locales = Object.keys(bundle) as readonly Bcp47Locale[];
    if (locales.length === 0) return;
    const firstLocale = locales[0];
    if (firstLocale === undefined) return;
    const firstKeys = new Set(Object.keys(bundle[firstLocale] ?? {}));
    for (let i = 1; i < locales.length; i++) {
      const locale = locales[i];
      if (locale === undefined) continue;
      const keys = new Set(Object.keys(bundle[locale] ?? {}));
      for (const k of firstKeys) {
        if (!keys.has(k)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [locale, k],
            message: `locale '${locale}' is missing key '${k}' present in '${firstLocale}'`,
          });
        }
      }
    }
  });
export type I18nBundle = z.infer<typeof I18nBundleSchema>;

export interface FormatNumberOptions {
  readonly locale: Bcp47Locale;
  readonly minimumFractionDigits?: number;
  readonly maximumFractionDigits?: number;
}

export function formatNumber(value: number, opts: FormatNumberOptions): string {
  return new Intl.NumberFormat(opts.locale, {
    ...(opts.minimumFractionDigits !== undefined
      ? { minimumFractionDigits: opts.minimumFractionDigits }
      : {}),
    ...(opts.maximumFractionDigits !== undefined
      ? { maximumFractionDigits: opts.maximumFractionDigits }
      : {}),
  }).format(value);
}

export function formatCurrency(value: number, ctx: I18nContext): string {
  return new Intl.NumberFormat(ctx.locale, {
    style: "currency",
    currency: ctx.currency,
  }).format(value);
}
