import { z } from "zod";
import {
  BCP47Schema,
  IanaTimezoneSchema,
  Iso4217CurrencySchema,
  RTL_LOCALES,
  type Bcp47Locale,
  type Direction,
} from "./locales.js";
import { CalendarConfigSchema, NumberingSystemSchema } from "./calendar.js";
import { TranslationBundleSchema } from "./bundle.js";

export const TenantI18nConfigSchema = z
  .object({
    defaultLocale: BCP47Schema.default("en"),
    supportedLocales: z.array(BCP47Schema).default([]),
    rtlLocales: z.array(BCP47Schema).optional(),
    currency: Iso4217CurrencySchema.default("USD"),
    alternativeCurrencies: z.array(Iso4217CurrencySchema).default([]),
    timezone: IanaTimezoneSchema.default("UTC"),
    firstDayOfWeek: z.number().int().min(0).max(6).default(1),
    weekendDays: z.array(z.number().int().min(0).max(6)).default([0, 6]),
    numberingSystem: NumberingSystemSchema.optional(),
    calendar: CalendarConfigSchema.optional(),
    translations: TranslationBundleSchema,
  })
  .superRefine((v, ctx) => {
    const declaredLocales = new Set(v.supportedLocales);
    if (declaredLocales.size > 0 && !declaredLocales.has(v.defaultLocale)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultLocale"],
        message: `defaultLocale '${v.defaultLocale}' must appear in supportedLocales`,
      });
    }
    const translationLocales = new Set(Object.keys(v.translations));
    if (!translationLocales.has(v.defaultLocale)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["translations"],
        message: `translations must include the default locale '${v.defaultLocale}'`,
      });
    }
    if (v.supportedLocales.length > 0) {
      for (const locale of v.supportedLocales) {
        if (!translationLocales.has(locale)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["translations", locale],
            message: `supportedLocale '${locale}' has no translation bundle`,
          });
        }
      }
    }
    if (v.weekendDays.length === 0 || v.weekendDays.length > 7) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["weekendDays"],
        message: "weekendDays must contain between 1 and 7 distinct day numbers",
      });
    } else if (new Set(v.weekendDays).size !== v.weekendDays.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["weekendDays"],
        message: "weekendDays must not contain duplicates",
      });
    }
  });
export type TenantI18nConfig = z.infer<typeof TenantI18nConfigSchema>;

export function resolveSupportedLocales(config: TenantI18nConfig): readonly Bcp47Locale[] {
  if (config.supportedLocales.length > 0) return config.supportedLocales;
  return Object.keys(config.translations) as Bcp47Locale[];
}

export function isRtlLocale(config: TenantI18nConfig, locale: Bcp47Locale): boolean {
  if (config.rtlLocales !== undefined) {
    return config.rtlLocales.includes(locale);
  }
  const base = locale.split("-")[0];
  return base !== undefined && RTL_LOCALES.has(base);
}

export function directionForConfigLocale(config: TenantI18nConfig, locale: Bcp47Locale): Direction {
  return isRtlLocale(config, locale) ? "rtl" : "ltr";
}
