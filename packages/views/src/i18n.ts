import { z } from "zod";
import {
  BCP47Schema,
  DIRECTIONS,
  IanaTimezoneSchema,
  Iso4217CurrencySchema,
  type Bcp47Locale,
} from "@crossengin/i18n";

export {
  BCP47Schema,
  DIRECTIONS,
  IanaTimezoneSchema,
  Iso4217CurrencySchema,
  type Bcp47Locale,
  type Direction,
  directionFor,
} from "@crossengin/i18n";

export { TranslationBundleSchema as I18nBundleSchema } from "@crossengin/i18n";
export type { TranslationBundle as I18nBundle } from "@crossengin/i18n";

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
