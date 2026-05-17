import { languageOf, type Bcp47Locale } from "./locales.js";

export const RESOLUTION_SOURCES = [
  "user_preference",
  "tenant_default",
  "accept_language",
  "fallback",
] as const;
export type ResolutionSource = (typeof RESOLUTION_SOURCES)[number];

export interface LocaleResolutionInput {
  readonly userPreference?: Bcp47Locale;
  readonly tenantDefault?: Bcp47Locale;
  readonly acceptLanguage?: string;
  readonly supportedLocales: ReadonlyArray<Bcp47Locale>;
  readonly fallback?: Bcp47Locale;
}

export interface LocaleResolutionResult {
  readonly locale: Bcp47Locale;
  readonly source: ResolutionSource;
}

export function resolveLocale(input: LocaleResolutionInput): LocaleResolutionResult {
  const supported = new Set<string>(input.supportedLocales);

  if (input.userPreference !== undefined && supported.has(input.userPreference)) {
    return { locale: input.userPreference, source: "user_preference" };
  }
  if (input.userPreference !== undefined) {
    const lang = languageOf(input.userPreference);
    for (const candidate of input.supportedLocales) {
      if (languageOf(candidate) === lang) {
        return { locale: candidate, source: "user_preference" };
      }
    }
  }

  if (input.tenantDefault !== undefined && supported.has(input.tenantDefault)) {
    return { locale: input.tenantDefault, source: "tenant_default" };
  }

  if (input.acceptLanguage !== undefined) {
    const negotiated = negotiateAcceptLanguage(input.acceptLanguage, input.supportedLocales);
    if (negotiated !== null) {
      return { locale: negotiated, source: "accept_language" };
    }
  }

  const fallback = input.fallback ?? "en";
  return { locale: fallback, source: "fallback" };
}

interface ParsedPreference {
  readonly locale: string;
  readonly quality: number;
}

function parseAcceptLanguage(header: string): readonly ParsedPreference[] {
  const entries = header.split(",");
  const parsed: ParsedPreference[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const [tag, ...params] = trimmed.split(";");
    if (tag === undefined || tag === "*") continue;
    let quality = 1.0;
    for (const param of params) {
      const m = param.trim().match(/^q=(\d+(?:\.\d+)?)$/);
      if (m !== null && m[1] !== undefined) {
        quality = Number.parseFloat(m[1]);
      }
    }
    parsed.push({ locale: normalizeTag(tag.trim()), quality });
  }
  return parsed.sort((a, b) => b.quality - a.quality);
}

function normalizeTag(tag: string): string {
  const parts = tag.split("-");
  if (parts.length === 0) return tag;
  const lang = (parts[0] ?? "").toLowerCase();
  if (parts.length === 1) return lang;
  const region = (parts[1] ?? "").toUpperCase();
  return `${lang}-${region}`;
}

export function negotiateAcceptLanguage(
  header: string,
  supportedLocales: ReadonlyArray<Bcp47Locale>,
): Bcp47Locale | null {
  const preferences = parseAcceptLanguage(header);
  const supportedSet = new Set<string>(supportedLocales);

  for (const pref of preferences) {
    if (supportedSet.has(pref.locale)) return pref.locale as Bcp47Locale;
  }

  for (const pref of preferences) {
    const lang = languageOf(pref.locale as Bcp47Locale);
    for (const candidate of supportedLocales) {
      if (languageOf(candidate) === lang) return candidate;
    }
  }

  return null;
}
