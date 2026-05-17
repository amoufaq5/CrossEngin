# ADR-0022: Internationalization and Localization

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0004, ADR-0010, ADR-0016, ADR-0018, ADR-0019, ADR-0021 |

## Context

CrossEngin's first region is the UAE / Middle East (Round 2 decision). UAE business operates in Arabic + English; some GCC markets (Saudi Arabia, Oman) lean more Arabic. EU expansion (Year 2 per Round 10) adds German, French, Spanish, Italian as likely demand. Year 3 US expansion adds American English variations + potentially Spanish for healthcare in some states.

Internationalization (i18n) and localization (l10n) span:

- **Translation of UI strings** — every visible label, button, error message, help text.
- **Translation of manifest content** — entity labels, view labels, workflow state names, validation messages declared by the tenant or compliance pack.
- **Translation of generated content** — receipt PDFs, audit reports, email notifications, push notification text.
- **Locale-aware formatting** — dates, times, numbers, currencies, addresses, phone numbers.
- **Time zones** — workflows, schedules, displays, audit timestamps.
- **Text directionality** — RTL for Arabic + Hebrew; LTR for everything else; bi-directional mixed text.
- **Pluralization rules** — different languages have different plural forms (English 2 forms; Arabic 6 forms).
- **Sorting and search** — Arabic vs. English sort orders; multilingual search (cross-link ADR-0016).
- **Cultural conventions** — name order, address formats, weekend days (Friday-Saturday vs. Saturday-Sunday).

ADR-0018 already covered renderer-level RTL + i18n contract. ADR-0016 covered multilingual search. This ADR consolidates the broader i18n strategy: locale management, translation tooling, fallback rules, manifest interaction, l10n of generated content.

## Decision

CrossEngin uses **BCP-47 locale tags** with **ICU MessageFormat** for translations, **`react-intl`** for runtime formatting, and **manifest-embedded translation bundles** as the source of truth for tenant-specific text.

### Locale taxonomy

| Locale | Languages | Year supported |
|---|---|---|
| `en` | English (default) | Year 1 |
| `ar` | Arabic | Year 1 |
| `ar-AE` | Arabic (UAE specifics) | Year 1 |
| `ar-SA` | Arabic (Saudi specifics) | Year 2 |
| `fr` | French | Year 2 |
| `de` | German | Year 2 |
| `es` | Spanish | Year 3 |
| `it` | Italian | Year 3 |
| `nl` | Dutch | Year 4+ |
| `pt` | Portuguese | Year 4+ |
| `tr` | Turkish | Year 3-4 |

v1 ships `en` + `ar` + `ar-AE`. Additional locales added as customer demand arrives.

### Locale resolution

A request's effective locale is resolved by:

1. **User preference** if explicitly set in profile (`meta.users.locale`).
2. **Tenant default** from `manifest.i18n.defaultLocale`.
3. **Accept-Language header** matched against supported locales.
4. **Fallback to `en`** if none of the above resolves.

The renderer (ADR-0018) consumes the resolved locale + direction in its `I18nContext`. The kernel uses the same context for server-rendered emails, PDFs, audit messages.

### Translation bundles in manifests

```jsonc
"i18n": {
  "defaultLocale": "en",
  "supportedLocales": ["en", "ar", "ar-AE"],
  "rtlLocales": ["ar", "ar-AE"],
  "currency": "USD",
  "alternativeCurrencies": ["AED", "EUR"],
  "dateFormat": "iso",
  "timezone": "Asia/Dubai",
  "firstDayOfWeek": 6,
  "weekendDays": [5, 6],
  "translations": {
    "en": {
      "entities.prescription.label": "Prescription",
      "entities.prescription.plural": "Prescriptions",
      "workflows.prescriptionLifecycle.states.pending": "Pending Verification",
      "workflows.prescriptionLifecycle.states.verified": "Verified",
      "workflows.prescriptionLifecycle.states.dispensed": "Dispensed",
      "actions.verify": "Verify",
      "validations.quantity.range": "Quantity must be between {min} and {max}",
      "notifications.prescriptionReady.subject": "Your prescription is ready for pickup",
      "notifications.prescriptionReady.body": "Hello {patientName}, your prescription for {drugName} is ready at {pharmacyName}."
    },
    "ar": {
      "entities.prescription.label": "وصفة طبية",
      "entities.prescription.plural": "وصفات طبية",
      "workflows.prescriptionLifecycle.states.pending": "بانتظار التحقق",
      "workflows.prescriptionLifecycle.states.verified": "تم التحقق",
      "workflows.prescriptionLifecycle.states.dispensed": "تم الصرف",
      "actions.verify": "تحقق",
      "validations.quantity.range": "يجب أن تكون الكمية بين {min} و {max}",
      "notifications.prescriptionReady.subject": "وصفتك الطبية جاهزة للاستلام",
      "notifications.prescriptionReady.body": "مرحبا {patientName}، وصفتك الطبية لـ{drugName} جاهزة في {pharmacyName}."
    }
  }
}
```

Manifest translations are merged with kernel-shipped translations (button labels, common error messages, framework strings). Manifest wins on key collision.

### Kernel-shipped translation bundles

`packages/i18n/locales/<locale>/<namespace>.json` contains kernel-level translations:

- **Common UI:** "Save," "Cancel," "Confirm," "Loading," "Error."
- **System messages:** "Network error. Please try again," "Session expired."
- **Form validation:** standard validators ("Required," "Invalid email," "Too long").
- **Renderer-specific:** Kanban "Drop here," Calendar "Today," etc.
- **Auth flow:** "Sign in," "Sign out," "Forgot password," MFA prompts.
- **Billing:** Plan names, billing-portal strings.

These shipped translations are owned by CrossEngin; tenants cannot override individual kernel strings but can override entire namespaces.

### Translation file format

ICU MessageFormat for parameterized + pluralized strings:

```icu
{itemCount, plural,
  =0 {No items}
  one {1 item}
  other {{itemCount} items}
}
```

Arabic plural rules (6 categories):

```icu
{itemCount, plural,
  zero {لا توجد عناصر}
  one {عنصر واحد}
  two {عنصران}
  few {{itemCount} عناصر}
  many {{itemCount} عنصرًا}
  other {{itemCount} عنصر}
}
```

`react-intl` handles the locale-correct plural selection automatically.

### Locale-aware formatting

| Format | Tool | Notes |
|---|---|---|
| Dates | `Intl.DateTimeFormat` | Tenant timezone + locale calendar |
| Numbers | `Intl.NumberFormat` | Decimal/grouping separators |
| Currency | `Intl.NumberFormat` with `style: "currency"` | Currency from tenant config (Round 7 per-family); user preference can override display |
| Relative time | `Intl.RelativeTimeFormat` | "2 hours ago" / "في غضون 5 دقائق" |
| Lists | `Intl.ListFormat` | "A, B, and C" / "A و B و C" |
| Plurals | `Intl.PluralRules` (via react-intl) | Per-language plural categories |

All formatting happens at the renderer layer (ADR-0018). Server-side rendering uses the same `Intl` APIs.

### RTL and bidi

Per ADR-0018:

- **Layout mirrors** via Tailwind logical properties (`ps-*`, `pe-*`, `text-start`, `text-end`).
- **Icons** that imply direction (chevrons, arrows) mirror.
- **Mixed RTL+LTR text** rendered with Unicode Bidi Algorithm + appropriate isolate markers (`<bdi>` in React).
- **Date components** that have inherent direction (English "MM/DD/YYYY" within an Arabic context) use bidi isolate.
- **Email + PDF generation** respects RTL — Puppeteer renders RTL pages correctly with appropriate stylesheet.

CSS variables for theme (per ADR-0018) work in both directions; logical properties + RTL classes do the work.

### Timezone handling

- **Tenant default timezone** stored in `meta.tenants.timezone`.
- **User-override timezone** stored in `meta.users.timezone`.
- **All timestamps stored in UTC** in Postgres (TIMESTAMPTZ).
- **Display in user/tenant timezone** at render time.
- **Workflow schedules** declared in IANA TZ format ("Asia/Dubai") and resolved at execution time.
- **Audit-log timestamps** stored UTC; displayed in viewer's timezone with explicit `(UTC+04:00)` annotation for compliance.

### Currency display vs. billing

- **Billing currency** is set on the tenant's plan (per ADR-0021).
- **Display currency** in tenant UI can be different for cosmetic preference; conversion rate at display time (live ECB rates cached daily).
- **Audit + invoice numbers** retain billing currency.
- **Multi-currency entities** (a Prescription with `totalCost` stored in original currency) declared via the `currency_amount` field type (per ADR-0003); rendered in their own currency.

### Generated-content translation

PDF receipts, email templates, push notifications:

- Templates use ICU MessageFormat keys.
- Locale resolution at generation time matches the tenant's recipient.
- For tenant-customer notifications: customer locale stored in their entity record (e.g., `patient.preferredLocale`); fallback to tenant default.
- For internal staff notifications: user's locale.

### Manifest authoring i18n UX

When a tenant or AI Architect adds a new entity / view / workflow state:

- The AI Architect proposes translations for all supported locales using the LLM (per ADR-0006).
- Tenant admin reviews + edits translations in the manifest editor.
- Missing translations fall back to the default locale with a visible "[en]" marker indicating non-translation.

The agent never silently translates regulatory or compliance text — those texts are pack-supplied (per ADR-0012) and reviewed by qualified translators.

### Translation review workflow

For high-stakes translations (regulatory text, compliance pack copy, refusal messages per ADR-0025):

- **Manual translator review** before publication.
- **Bilingual reviewers** for Arabic (a native speaker plus a domain expert).
- **Versioned translation bundles** per compliance pack; pack updates can trigger re-translation.
- **Translation memory** (string + locale + translation hash) stored to enforce consistency across packs.

### Search and i18n

Per ADR-0016:

- **Per-tenant dictionary** for Postgres FTS (Arabic, English, French).
- **BGE-M3 embeddings** are multilingual; semantic search works across locales.
- **Typesense locale-aware tokenization.**
- **Cross-language search** (Year 2+ if demand): use the same embedding space for "amoxicillin" in English to match Arabic-text records.

### Date / calendar systems

CrossEngin uses the **Gregorian calendar** for storage and most display. UI may layer:

- **Hijri (Islamic) calendar** display for ME tenants. `Intl.DateTimeFormat` with `calendar: "islamic-umalqura"` for Saudi-context tenants.
- **Buddhist calendar** for Thai tenants (Year 4+).
- **Era-specific labels** (e.g., AH year alongside Gregorian) configured via manifest `i18n.calendarSystems`.

Audit logs and integration calls always use Gregorian + UTC; calendar display is a renderer concern only.

### Number systems

Western Arabic numerals (`1234`) by default. Eastern Arabic-Indic numerals (`١٢٣٤`) optional per-tenant for Arabic locales — `Intl.NumberFormat` with `numberingSystem: "arab"`. Compliance / financial documents always use Western Arabic numerals regardless of tenant preference.

### Untranslated content

When a translation is missing:

- **Renderer:** fall back to default locale; mark with subtle `[en]` indicator for translator triage.
- **Email / PDF:** fall back silently; log to observability for translator backlog.
- **Validation messages:** never fall back silently — show key with explicit "[Translation needed]" so QA catches.

### Language detection

For inbound user content (search queries, document uploads, AI Architect conversations):

- **Detect language** from the input.
- **Process accordingly** (BGE-M3 handles all supported languages; Postgres FTS uses the matching dictionary).
- **Respect tenant locale-allowlist** — a `me-only` tenant may opt out of non-Arabic/English content processing.

## Alternatives considered

### Option A — English-only forever

- **Pros:** Simplest.
- **Cons:** UAE / GCC market demands Arabic. EU expansion demands German, French. Non-starter.
- **Why not:** Locked in by region decision.

### Option B — Per-language separate codebases

Forked apps for each language.

- **Pros:** Maximum tuning.
- **Cons:** Maintenance disaster. Conflicts with one-monorepo decision.
- **Why not:** Single-codebase i18n is the modern norm.

### Option C — Tenant-supplied translations only (no kernel-shipped)

Every string a tenant sees comes from the tenant's manifest.

- **Pros:** Maximum tenant control.
- **Cons:** Every tenant reinvents "Save", "Cancel", "Loading". Inconsistency at scale.
- **Why not:** Hybrid: kernel ships common strings; manifests ship app-specific strings.

### Option D — Server-side rendering of all locale-specific content (no client i18n)

- **Pros:** Smaller client bundle.
- **Cons:** Locale-aware formatting needs real-time (current time relative formatting, live currency rates) — requires client work anyway.
- **Why not:** Hybrid SSR + CSR is the natural fit.

### Option E — Use a translation-management platform (Lokalise, Crowdin, Phrase)

Centralized translation memory + translator collaboration.

- **Pros:** Translation workflow built-in.
- **Cons:** Adds a vendor. Translation files are simple JSON; manageable in-repo for v1 volume.
- **Why not:** Defer until translation volume justifies. Manifest translations stay in manifests; kernel translations stay in `packages/i18n/locales`. Evaluate platforms at Year 2 when locale count grows.

### Option F — Translate at AI-Architect-time only (no static bundles)

Use LLM at runtime for translation.

- **Pros:** No translation files to maintain.
- **Cons:** Latency on every render. Inconsistency between sessions. Regulatory text must be human-reviewed, not LLM-translated.
- **Why not:** Hybrid: pre-translated for stable strings; LLM-suggested at authoring time for new strings.

## Consequences

### Positive

- **RTL + Arabic from v1** matches the ME-first region.
- **ICU MessageFormat** is the standard; tooling and translator familiarity.
- **Locale-aware formatting** via `Intl` APIs is free (no library needed).
- **Manifest-driven tenant strings** integrate with AI Architect and AI-suggested translations.
- **Translation review workflow** ensures regulatory text quality.

### Negative

- **Translation maintenance cost.** Adding a locale is recurring work. Mitigation: prioritize by tenant demand; revisit translation platform at Year 2.
- **Bidi edge cases.** Mixed RTL/LTR text in tables, forms, charts has visual quirks. Mitigation: explicit bidi isolate markers; QA with native speakers.
- **Calendar / number system complexity.** Tenant + user preferences interact non-trivially. Mitigation: document defaults; UI for explicit overrides.
- **Translation quality variance.** AI-suggested translations may be poor for domain-specific text. Mitigation: tenant admin review; compliance pack translations always human-reviewed.

### Neutral

- **Locale resolution** is straightforward middleware; mature pattern.
- **Generated PDFs** in Arabic via Puppeteer require system fonts; managed via Docker base image.

### Reversibility

**Low cost** to add new locales — translate bundles, declare in `i18n.supportedLocales`.

**Moderate cost** to swap translation library (`react-intl` for `next-intl` or `lingui`).

**Low cost** to revise existing translations — version-controlled.

**High cost** to remove a locale after tenant adoption. Customer disruption.

## Implementation notes

- **Package locations:**
  - `packages/i18n` — locale resolution, formatters, kernel-shipped translations.
  - `packages/i18n/locales/<locale>/<namespace>.json` — bundles.
  - `packages/i18n/middleware.ts` — Next.js locale-resolution middleware.
- **react-intl integration:** `<IntlProvider locale={locale} messages={...}>` at app root; `useIntl()` hook for formatting; `<FormattedMessage>` for inline translations.
- **Server-side i18n:** for emails / PDFs, instantiate `IntlMessageFormat` directly with the recipient's locale.
- **Bidi support:**
  - `<html dir={direction}>` set by middleware.
  - Tailwind `rtl:` variant.
  - `<bdi>` for mixed-direction inline content.
- **Translation linter:** `tools/i18n-lint` checks for missing translations, mismatched ICU placeholders, untranslated keys with non-default locales.
- **Translator workflow tools:** `tools/translation-export` produces XLIFF files for external translators; `tools/translation-import` ingests back.
- **AI Architect translation suggestions:** new manifest fields get LLM-suggested translations; flagged for tenant admin review before manifest apply.
- **Calendar utility library:** `packages/i18n/calendar` wraps `Intl.DateTimeFormat` + Hijri / Buddhist calendar conversions.
- **Locale negotiation:** middleware reads `Accept-Language`, falls back through preference chain, sets cookie for subsequent requests.
- **Testing:**
  - Snapshot tests for translated UI components.
  - RTL visual regression via Playwright with `--rtl` flag.
  - Linter tests on translation completeness.
  - Pseudo-locale test (`en-XX-pseudo` with elongated strings) catches layout issues.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Translation management platform — Lokalise vs. Crowdin vs. Phrase vs. continue in-repo JSON. Cost vs. translator workflow ease. Likely Year 2. | amoufaq5 | Year 2 |
| Pseudo-locale enforcement in CI — should every PR pass pseudo-locale render budget for layout robustness? | _pending design hire_ | Phase 5 |
| GCC dialect handling — UAE Arabic vs. Saudi Arabic vs. Egyptian Arabic. Many manifests just need `ar`; some markets demand specific. | _pending design hire_ + native-speaker reviewer | Year 2 |
| Calendar system display defaults per-tenant vs. per-user. | amoufaq5 | Phase 5 |
| RTL chart rendering — Recharts has incomplete RTL support; alternatives (visx, Apache ECharts). | _pending design hire_ | Phase 4 |
| Compliance pack translation cost — every pack ships with English; how many target translations per pack from launch? | _pending compliance hire_ | Year 2 |
| Currency conversion rate cadence — daily ECB cache is the v1 plan; some financial-services tenants may demand real-time. | amoufaq5 | Year 2 |
| Regulatory text fallback policy — if a tenant uses a pack with no Arabic translation, do we block, warn, or fall back to English? | _pending compliance hire_ | Phase 4 |

## References

- ADR-0004 (Manifest specification) — defines the `i18n` manifest section.
- ADR-0010 (Multi-region and data residency) — defines region-tenant currency / locale defaults.
- ADR-0016 (Search) — defines multilingual search dictionaries.
- ADR-0018 (Frontend renderer architecture) — defines RTL + i18n contract at the renderer layer.
- ADR-0019 (PWA and Capacitor mobile) — defines mobile-specific i18n considerations.
- ADR-0021 (Billing and metering) — defines currency display vs. billing.
- BCP-47 specification; ICU MessageFormat; ECMA-402 (Intl APIs); Unicode Bidi Algorithm.
