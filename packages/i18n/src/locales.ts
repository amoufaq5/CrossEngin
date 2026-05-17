import { z } from "zod";

const BCP47_REGEX = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const CURRENCY_REGEX = /^[A-Z]{3}$/;
const IANA_REGEX = /^[A-Za-z]+(?:\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)?$|^UTC$/;

export const BCP47Schema = z.string().regex(BCP47_REGEX, {
  message: "locale must be BCP-47 (e.g., 'en', 'ar', 'en-US', 'ar-AE')",
});
export type Bcp47Locale = z.infer<typeof BCP47Schema>;

export const Iso4217CurrencySchema = z.string().regex(CURRENCY_REGEX, {
  message: "currency must be ISO 4217 (e.g., 'USD', 'AED', 'EUR')",
});
export type Iso4217Currency = z.infer<typeof Iso4217CurrencySchema>;

export const IanaTimezoneSchema = z.string().regex(IANA_REGEX, {
  message: "timezone must be IANA (e.g., 'Asia/Dubai', 'UTC')",
});
export type IanaTimezone = z.infer<typeof IanaTimezoneSchema>;

export const DIRECTIONS = ["ltr", "rtl"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const RTL_LOCALES: ReadonlySet<string> = new Set<string>([
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

export function languageOf(locale: Bcp47Locale): string {
  const base = locale.split("-")[0];
  return base ?? locale;
}

export function regionOf(locale: Bcp47Locale): string | null {
  const parts = locale.split("-");
  return parts.length > 1 && parts[1] !== undefined ? parts[1] : null;
}

export const SUPPORTED_LOCALES_V1 = ["en", "ar", "ar-AE"] as const;
export const SUPPORTED_LOCALES_ROADMAP = [
  "en",
  "ar",
  "ar-AE",
  "ar-SA",
  "fr",
  "de",
  "es",
  "it",
  "tr",
  "nl",
  "pt",
] as const;

export interface LocaleRecord {
  readonly locale: Bcp47Locale;
  readonly nativeName: string;
  readonly englishName: string;
  readonly direction: Direction;
  readonly yearSupported: number;
}

export const LOCALE_REGISTRY: ReadonlyArray<LocaleRecord> = Object.freeze([
  { locale: "en", nativeName: "English", englishName: "English", direction: "ltr", yearSupported: 2026 },
  { locale: "ar", nativeName: "العربية", englishName: "Arabic", direction: "rtl", yearSupported: 2026 },
  { locale: "ar-AE", nativeName: "العربية (الإمارات)", englishName: "Arabic (UAE)", direction: "rtl", yearSupported: 2026 },
  { locale: "ar-SA", nativeName: "العربية (السعودية)", englishName: "Arabic (Saudi Arabia)", direction: "rtl", yearSupported: 2027 },
  { locale: "fr", nativeName: "Français", englishName: "French", direction: "ltr", yearSupported: 2027 },
  { locale: "de", nativeName: "Deutsch", englishName: "German", direction: "ltr", yearSupported: 2027 },
  { locale: "es", nativeName: "Español", englishName: "Spanish", direction: "ltr", yearSupported: 2028 },
  { locale: "it", nativeName: "Italiano", englishName: "Italian", direction: "ltr", yearSupported: 2028 },
  { locale: "tr", nativeName: "Türkçe", englishName: "Turkish", direction: "ltr", yearSupported: 2028 },
  { locale: "nl", nativeName: "Nederlands", englishName: "Dutch", direction: "ltr", yearSupported: 2029 },
  { locale: "pt", nativeName: "Português", englishName: "Portuguese", direction: "ltr", yearSupported: 2029 },
]);

export function localeRecord(locale: Bcp47Locale): LocaleRecord | null {
  return LOCALE_REGISTRY.find((r) => r.locale === locale) ?? null;
}
