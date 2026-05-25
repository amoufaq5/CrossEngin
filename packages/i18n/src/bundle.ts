import { z } from "zod";
import { BCP47Schema, type Bcp47Locale } from "./locales.js";
import { checkPlaceholderConsistency, IcuMessageSchema } from "./messageformat.js";

const TRANSLATION_KEY_REGEX = /^[a-z][a-zA-Z0-9._-]*$/;

export const TranslationKeySchema = z.string().regex(TRANSLATION_KEY_REGEX, {
  message: "translation key must be 'lowercase.dot.case' or 'kebab-case'",
});

export const LocaleMessagesSchema = z.record(TranslationKeySchema, IcuMessageSchema);
export type LocaleMessages = z.infer<typeof LocaleMessagesSchema>;

export const TranslationBundleSchema = z
  .record(BCP47Schema, LocaleMessagesSchema)
  .superRefine((bundle, ctx) => {
    const locales = Object.keys(bundle) as readonly Bcp47Locale[];
    if (locales.length === 0) return;
    const referenceLocale = locales[0];
    if (referenceLocale === undefined) return;
    const referenceKeys = Object.keys(bundle[referenceLocale] ?? {});
    for (let i = 1; i < locales.length; i++) {
      const locale = locales[i];
      if (locale === undefined) continue;
      const messages = bundle[locale] ?? {};
      const messageKeys = new Set(Object.keys(messages));
      for (const key of referenceKeys) {
        if (!messageKeys.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [locale, key],
            message: `locale '${locale}' is missing key '${key}' present in '${referenceLocale}'`,
          });
        }
      }
    }
  });
export type TranslationBundle = z.infer<typeof TranslationBundleSchema>;

export const MISSING_KEY_STRATEGIES = [
  "fallback_default",
  "show_marker",
  "show_key",
  "throw",
] as const;
export type MissingKeyStrategy = (typeof MISSING_KEY_STRATEGIES)[number];

export interface MissingTranslationStrategyOptions {
  readonly strategy: MissingKeyStrategy;
  readonly defaultLocale: Bcp47Locale;
  readonly markerTemplate?: string;
}

export const DEFAULT_RENDERER_MISSING_STRATEGY: MissingTranslationStrategyOptions = Object.freeze({
  strategy: "fallback_default",
  defaultLocale: "en",
  markerTemplate: "[{locale}]",
});

export const DEFAULT_VALIDATION_MISSING_STRATEGY: MissingTranslationStrategyOptions = Object.freeze(
  {
    strategy: "show_marker",
    defaultLocale: "en",
    markerTemplate: "[Translation needed: {key}]",
  },
);

export interface LookupInput {
  readonly bundle: TranslationBundle;
  readonly locale: Bcp47Locale;
  readonly key: string;
  readonly options?: MissingTranslationStrategyOptions;
}

export interface LookupResult {
  readonly message: string;
  readonly resolvedLocale: Bcp47Locale | null;
  readonly fallback: boolean;
}

export function lookupTranslation(input: LookupInput): LookupResult {
  const opts = input.options ?? DEFAULT_RENDERER_MISSING_STRATEGY;
  const messages = input.bundle[input.locale];
  const exact = messages?.[input.key];
  if (exact !== undefined) {
    return { message: exact, resolvedLocale: input.locale, fallback: false };
  }
  if (opts.strategy === "throw") {
    throw new Error(`missing translation '${input.key}' in locale '${input.locale}'`);
  }
  if (opts.strategy === "show_key") {
    return { message: input.key, resolvedLocale: null, fallback: false };
  }
  if (opts.strategy === "show_marker") {
    const template = opts.markerTemplate ?? "[{key}]";
    return {
      message: template.replace("{locale}", input.locale).replace("{key}", input.key),
      resolvedLocale: null,
      fallback: false,
    };
  }
  const defaultMessages = input.bundle[opts.defaultLocale];
  const fallback = defaultMessages?.[input.key];
  if (fallback !== undefined) {
    return { message: fallback, resolvedLocale: opts.defaultLocale, fallback: true };
  }
  return { message: input.key, resolvedLocale: null, fallback: true };
}

export interface BundleConsistencyIssue {
  readonly locale: Bcp47Locale;
  readonly key: string;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

export function checkBundleConsistency(
  bundle: TranslationBundle,
  referenceLocale: Bcp47Locale,
): readonly BundleConsistencyIssue[] {
  const reference = bundle[referenceLocale];
  if (reference === undefined) return [];
  const issues: BundleConsistencyIssue[] = [];
  for (const [locale, messages] of Object.entries(bundle)) {
    if (locale === referenceLocale) continue;
    for (const [key, refMessage] of Object.entries(reference)) {
      const message = messages[key];
      if (message === undefined) continue;
      const { missing, extra } = checkPlaceholderConsistency(refMessage, message);
      if (missing.length > 0 || extra.length > 0) {
        issues.push({ locale: locale as Bcp47Locale, key, missing, extra });
      }
    }
  }
  return issues;
}

export function mergeBundles(
  base: TranslationBundle,
  overlay: TranslationBundle,
): TranslationBundle {
  const merged: Record<string, LocaleMessages> = {};
  for (const [locale, messages] of Object.entries(base)) {
    merged[locale] = { ...messages };
  }
  for (const [locale, messages] of Object.entries(overlay)) {
    merged[locale] = { ...(merged[locale] ?? {}), ...messages };
  }
  return merged;
}
