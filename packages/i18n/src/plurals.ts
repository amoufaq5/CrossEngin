import type { Bcp47Locale } from "./locales.js";
import { languageOf } from "./locales.js";

export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

export const PLURAL_TYPES = ["cardinal", "ordinal"] as const;
export type PluralType = (typeof PLURAL_TYPES)[number];

const LANG_PLURAL_CATEGORIES: Readonly<Record<string, ReadonlyArray<PluralCategory>>> =
  Object.freeze({
    en: ["one", "other"],
    fr: ["one", "many", "other"],
    de: ["one", "other"],
    es: ["one", "many", "other"],
    it: ["one", "many", "other"],
    pt: ["one", "many", "other"],
    nl: ["one", "other"],
    tr: ["one", "other"],
    ar: ["zero", "one", "two", "few", "many", "other"],
    he: ["one", "two", "many", "other"],
    fa: ["one", "other"],
    ur: ["one", "other"],
    ru: ["one", "few", "many", "other"],
    pl: ["one", "few", "many", "other"],
    zh: ["other"],
    ja: ["other"],
    th: ["other"],
    vi: ["other"],
  });

export function pluralCategoriesFor(locale: Bcp47Locale): ReadonlyArray<PluralCategory> {
  const lang = languageOf(locale);
  return LANG_PLURAL_CATEGORIES[lang] ?? ["one", "other"];
}

export function pluralCategory(
  locale: Bcp47Locale,
  count: number,
  type: PluralType = "cardinal",
): PluralCategory {
  const rules = new Intl.PluralRules(locale, { type });
  const cat = rules.select(count) as PluralCategory;
  if ((PLURAL_CATEGORIES as readonly string[]).includes(cat)) {
    return cat;
  }
  return "other";
}

export function exactCaseFor(count: number): `=${number}` {
  return `=${count}` as const;
}

export function isCompleteForLocale(
  locale: Bcp47Locale,
  declaredCases: readonly string[],
): boolean {
  const required = pluralCategoriesFor(locale);
  const presentCategories = new Set<string>();
  for (const c of declaredCases) {
    if (!c.startsWith("=")) presentCategories.add(c);
  }
  for (const required_case of required) {
    if (!presentCategories.has(required_case)) return false;
  }
  return true;
}

export function missingPluralCases(
  locale: Bcp47Locale,
  declaredCases: readonly string[],
): readonly PluralCategory[] {
  const required = pluralCategoriesFor(locale);
  const present = new Set<string>();
  for (const c of declaredCases) {
    if (!c.startsWith("=")) present.add(c);
  }
  return required.filter((r) => !present.has(r));
}
