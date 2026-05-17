# ADR-0018: Frontend Renderer Architecture

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0003, ADR-0004, ADR-0005, ADR-0008, ADR-0014, ADR-0019, ADR-0022 |

## Context

CrossEngin's central promise is that a tenant describes a business and gets a working application within an hour. That application has a UI. The UI cannot be hand-coded per tenant; the kernel + manifests produce hundreds of entity types across thousands of tenants. The UI must be **generated from the manifest at runtime**.

Generation has to work for very different applications: a community pharmacy, a vaccination registry, a graduate-school admissions system, a construction project tracker. The entities differ. The workflows differ. The compliance overlays differ. The cultural conventions differ (LTR vs. RTL; English vs. Arabic vs. French; ISO date format vs. local format). The visual language has to feel coherent enough to be one product, while letting each family (Operate, Govern, Heal, Educate, Serve) carry its own tone.

The original `/home/user/ERP` ships hand-coded page monoliths — 2,000-line files per entity type. That approach does not scale to 150 sub-types. It also bakes assumptions about specific entities into UI code, defeating the kernel/manifest separation. Phase 1's frontend work must replace it with generic renderers driven by manifest view declarations.

Three properties matter most:

1. **Manifest-driven.** The renderer does not know what a `Prescription` is. It knows how to render any entity that satisfies the manifest's entity contract.
2. **Permission-aware.** RBAC + ABAC + field-level rules (ADR-0008) gate what each user sees and edits. The renderer reads the permission decisions; the UI degrades gracefully when fields are redacted.
3. **Themable and localizable.** Each tenant (and each app family) can override colors, typography, voice, locale, currency, date format, and reading direction. The renderer treats theme + i18n as first-class.

Decisions that shape this ADR:

- **shadcn UI + Tailwind** are the design system base (salvaged from `/home/user/ERP`, per ADR-0024).
- **Next.js + TypeScript + pnpm + Turborepo** is the app stack (per ADR-0024).
- **PWA + Capacitor** for mobile, no native iOS/Android in v1 (per project constraints and ADR-0019).
- **Closed source** (Round 2). The renderer code is proprietary; no public extension hooks until Year 5+.
- **Per-tenant theming** (vision section 4).
- **Deterministic diff explainer** (Round 5, ADR-0005). The renderer turns structured diffs into UI without an LLM call.
- **Per-family context injection** (Round 5) means the renderer must respect family-level theme overrides.

## Decision

CrossEngin ships eight **renderer types**. Each is a React component package that consumes a manifest view declaration and an entity/dataset payload, plus a permission decision set from the kernel, and renders the appropriate UI.

### Renderer catalog

| Renderer | Use case | View `kind` in manifest |
|---|---|---|
| **List** | Tabular listing of entity instances; sortable, filterable, paginated, with bulk actions | `list` |
| **Record** | Single-entity detail view; sections, related entities, workflow controls | `record` |
| **Form** | Create / edit / multi-step intake form | `form` |
| **Kanban** | State-machine-driven board view (one column per `status` value) | `kanban` |
| **Calendar** | Time-indexed view (day/week/month/agenda) | `calendar` |
| **Map** | Geo-indexed view (markers + polygons, layered) | `map` |
| **Dashboard** | Composition of widgets (KPIs, charts, lists) from reports | `dashboard` |
| **Pivot** | Cross-tabbed analysis with row/column/measure selection | `pivot` |

Each renderer is implemented as a top-level React component in `packages/ui-renderers/<name>/`:

```
packages/ui-renderers/
├── list/        — List renderer (TanStack Table + virtualizer)
├── record/      — Record renderer
├── form/        — Form renderer (react-hook-form + Zod)
├── kanban/      — Kanban renderer (dnd-kit)
├── calendar/    — Calendar renderer (FullCalendar wrapper)
├── map/         — Map renderer (MapLibre GL)
├── dashboard/   — Dashboard renderer (Recharts + grid)
└── pivot/       — Pivot renderer (custom; small)
```

Each renderer's contract:

```typescript
type RendererProps<V extends ManifestView> = {
  view: V;                              // The view declaration from manifest
  entity: ManifestEntity;               // Entity declaration (fields, types, relations)
  permissions: PermissionDecisionSet;   // From kernel (ADR-0008)
  data: DataPayload;                    // Entity rows / single entity / report result
  i18n: I18nContext;                    // Locale, direction, currency, date format
  theme: ThemeOverlay;                  // Tenant + family theme overrides
  callbacks: RendererCallbacks;         // onAction, onTransition, onFilter, onSort
  workflow: WorkflowContext;            // Available transitions for the rendered entity(s)
};
```

The renderer is purely declarative. It never fetches data; the surrounding page (`apps/web`) handles data fetching via TanStack Query and passes the result. The renderer never mutates state directly; it invokes callbacks that the page handles.

### View declarations in the manifest

```jsonc
"views": {
  "prescriptionInbox": {
    "kind": "list",
    "entity": "prescription",
    "label": { "en": "Prescription Inbox", "ar": "صندوق الوصفات" },
    "icon": "Pill",
    "filters": [
      { "field": "status", "operator": "in", "values": ["pending", "verified"] },
      { "field": "writtenAt", "operator": "gte", "value": "$today - 30 days" }
    ],
    "sort": [{ "field": "writtenAt", "direction": "desc" }],
    "columns": [
      { "field": "patient.name", "label": { "en": "Patient" }, "width": 200 },
      { "field": "drug.name",    "label": { "en": "Drug" } },
      { "field": "quantity",     "label": { "en": "Qty" }, "align": "right" },
      { "field": "status",       "label": { "en": "Status" }, "render": "badge" },
      { "field": "writtenAt",    "label": { "en": "Written" }, "render": "relativeTime" }
    ],
    "rowAction": { "kind": "openRecord", "view": "prescriptionDetail" },
    "bulkActions": [
      { "kind": "workflow", "name": "verifyPrescription", "label": { "en": "Verify" } }
    ],
    "permissions": "inherit"
  }
}
```

The view declares **what to show, not how to show it**. The renderer decides layout, spacing, focus order, keyboard shortcuts.

### Form generation from entities

For forms, the renderer derives the form schema from the entity's field declarations (ADR-0003):

- `text(max_length=N)` → `<Input>` with `maxLength={N}` validation
- `long_text` → `<Textarea>`
- `integer(min, max)` → `<Input type="number">` with range validation
- `decimal(precision, scale)` → `<Input type="number" step={...}>`
- `enum([...])` → `<Select>` or `<RadioGroup>` (decided by `render` hint)
- `reference -> Entity` → `<EntityPicker>` (autocomplete, filtered by ABAC scope)
- `boolean` → `<Checkbox>` or `<Switch>`
- `date / time / datetime` → date/time picker with locale-aware format
- `file -> StorageReference` → `<FileUpload>` (per ADR-0014)
- `currency_amount` → `<Input>` + currency selector (per i18n)
- `geo_point` → small map widget

Zod validators are auto-generated from the meta-schema (per ADR-0003). The form renderer wires them into `react-hook-form`. Server-side, the kernel re-validates with the same Zod schemas — the client validator is a UX optimization, not a security boundary.

Multi-step forms (`kind: "form"` with `steps: [...]`) walk a wizard with progress + back-navigation. Each step's fields are a subset of the entity's fields.

### Permission-aware rendering

The renderer receives a `PermissionDecisionSet` from the kernel containing:

- Per-entity allowed operations (`read`, `create`, `update`, `delete`)
- Per-field redaction list (fields the session cannot read)
- Per-field write-mask (fields the session cannot write)
- Available transitions for each rendered entity instance

The renderer reflects this in the UI:

- **Redacted fields** show as `<RedactedField label="Patient SSN" reason="role:technician cannot read PHI"/>` placeholders so users know data exists but they can't see it.
- **Write-locked fields** render with `readOnly` + a lock icon + a tooltip explaining the policy.
- **Unavailable bulk actions** are hidden (not greyed) when zero rows in the selection allow them; shown with a tooltip when some-but-not-all rows allow.
- **Unavailable workflow transitions** are hidden from the record's primary action area.

The renderer never sends a request the kernel would reject. The permission decision is the ground truth; the UI mirrors it.

### Theme system

A `ThemeOverlay` is an object with brand color, typography, density, and accent rules:

```jsonc
{
  "brandColor": "#1e6f3f",
  "accentColor": "#a8c39a",
  "neutralPalette": "stone",
  "density": "comfortable" | "compact",
  "logoUrl": "https://...",
  "fontFamily": "Inter",
  "voice": "professional" | "warm" | "regulator-aware"
}
```

Layering (last wins):

1. CrossEngin default (shadcn base + neutral palette)
2. Family overlay (Operate, Govern, Heal, Educate, Serve, Build) — each family has its own brand-tone defaults
3. Tenant overlay from the manifest's `theme` section
4. User preference (light / dark mode)

The Tailwind config consumes the resolved palette via CSS variables — `--bc-primary`, `--bc-accent`, `--bc-neutral-50` through `--bc-neutral-950`. Renderers reference variables, not literal colors.

### Internationalization and RTL

The renderer reads `I18nContext` for:

- `locale: BCP47` (e.g., `en`, `ar`, `fr`)
- `direction: "ltr" | "rtl"`
- `currency: ISO 4217`
- `dateFormat: "iso" | "locale" | "<custom>"`
- `timezone: IANA`
- `firstDayOfWeek: 0..6`

All renderer text comes from i18n bundles in the manifest's `i18n` section. Hard-coded English in renderer code is forbidden (ESLint rule blocks `string literals in JSX`).

RTL is full-bidi: layout mirrors (left padding becomes right padding via Tailwind's logical properties), icons mirror where directional (chevrons), date/time formats respect locale. Tested with Arabic + English mixed content (a common case for ME tenants).

### Generic vs. custom widgets

The renderer ships with ~40 generic field widgets covering the manifest's primitive + structured + domain types. Tenants needing a custom widget (e.g., a barcode scanner for pharmacy inventory) declare it in the manifest:

```jsonc
"customWidgets": {
  "barcodeScanner": {
    "package": "@crossengin/widget-barcode",
    "render": "BarcodeScanner",
    "appliesTo": { "field": "barcode", "entity": "prescription" }
  }
}
```

Custom widgets are first-party packages we ship; tenants cannot inject arbitrary code (closed-source posture). The list grows by demand. For v1, only the generic widgets exist.

### Mobile and PWA

The renderer respects the device viewport:

- **Desktop** (`>=1024px`): full list/record layouts with side-panels.
- **Tablet** (`768-1024px`): stacked layouts, collapsible side-panels.
- **Mobile** (`<768px`): single-column, gesture-friendly (swipe for actions, bottom-sheet for filters).

The Capacitor wrapper (ADR-0019) provides native plugin hooks (BLE scanner, ESC/POS printer, NFC, camera). The renderer detects Capacitor at runtime via `@capacitor/core` and exposes the additional widgets (barcode scan via camera, receipt print) where available.

Offline-first behavior (ADR-0019) is handled at the data-fetching layer (TanStack Query + service worker), not in the renderer. The renderer is offline-agnostic; it renders whatever data it's given.

### Accessibility

WCAG 2.1 AA is the baseline. The renderer:

- Uses semantic HTML elements; no `<div>`-on-`<div>` widgets.
- Manages focus on modals and step transitions.
- Provides keyboard shortcuts for primary actions (configurable per view).
- Announces async state changes via `aria-live` regions.
- Contrast checked against the resolved palette at build time; warnings if any text fails AA.
- Color is never the only signal — status badges include icons + text.

WCAG 2.1 AAA is targeted for Govern (public-sector accessibility expectations) and Heal (some healthcare programs require it). The compliance pack flags it; the renderer raises the bar for that tenant.

## Alternatives considered

### Option A — Single mega-renderer

One React component that conditionally renders any view kind based on the `kind` field.

- **Pros:** Simpler routing. One component to maintain.
- **Cons:** Bundle size — every page loads all renderer code. Test surface is monolithic. Code-splitting becomes awkward.
- **Why not:** Eight focused packages with clear contracts are simpler to evolve and easier to lazy-load.

### Option B — Renderer per entity type (manifest-generated React components)

A code-generation step emits one React component per entity. Tenants get truly bespoke compiled UI.

- **Pros:** Maximum performance (zero runtime view interpretation). Tenant-specific optimizations possible.
- **Cons:** Build pipeline per tenant. Hot reloading manifest changes requires recompile + deploy. AI Architect changes wait minutes for UI to reflect.
- **Why not:** Runtime interpretation is fast enough (sub-50 ms render budget for 1000-row tables) and matches the "manifest = data, not code" premise (ADR-0004).

### Option C — Off-the-shelf low-code UI builder (Retool, Tooljet, AppSmith)

Embed a low-code platform inside CrossEngin; manifest views map to their primitives.

- **Pros:** Don't build it ourselves. Mature widget catalog.
- **Cons:** None of them are designed for closed-source vertical-SaaS embedding. Licensing models are wrong for our shape. The manifest model conflicts with their drag-and-drop premise. Multi-tenancy story is fragile.
- **Why not:** We need a renderer we control. Low-code builders are competitors, not foundations.

### Option D — Server-side rendering only (no client state)

Pure server-rendered pages; no React on the client.

- **Pros:** Smallest client bundle. Fastest initial load. Simpler.
- **Cons:** No client-side interactivity. Form validation server-only (slow UX). Kanban drag-drop, calendar pan/zoom, map interactivity all require client React.
- **Why not:** Modern UX expectations mandate client interactivity. We use server components for the chrome and client for the renderer.

### Option E — React Server Components-first (Next.js App Router)

Most of the page is server components; client components only where interactivity is needed.

- **Pros:** Smaller client bundle. Faster TTI.
- **Cons:** Renderer logic that needs permission decisions + interaction state is mostly client-side anyway.
- **Why not:** We adopt RSC for the page shell and data fetching, but each renderer is a client component. This is the standard 2026 pattern.

### Option F — Three-pane Mendix-style visual builder for tenants

Drag-and-drop UI builder embedded in the tenant admin.

- **Pros:** Visual editing for tenants.
- **Cons:** Conflicts with AI Architect as primary editor (ADR-0005). Adds large UI surface to build and maintain.
- **Why not:** AI Architect is the primary editor. A visual designer is a Phase 4+ refinement, not a v1 deliverable.

## Consequences

### Positive

- **One renderer team, many tenants.** No per-tenant UI code. Bug fixes ship to every tenant on next deploy.
- **AI Architect target is well-defined.** The agent emits manifest views; the renderer interprets. Validation catches bad views before they reach a tenant's screen.
- **Permission-aware UI by construction.** Field redaction, write-masks, and transition availability are wired through automatically.
- **Theme + i18n + RTL are first-class.** ME tenants (Arabic + English) and EU tenants (multiple LTR languages) work without code changes.
- **Accessibility baseline is mandatory.** Every tenant inherits WCAG 2.1 AA.
- **Mobile + PWA fit naturally.** Same renderer; viewport-aware layouts.

### Negative

- **Implementation cost is real.** Eight renderers + ~40 widgets + theme system + i18n + Capacitor integration is ~10–12 weeks for v1. Mitigation: List, Record, Form first (covers 80% of v1); Kanban, Calendar second; Map, Pivot, Dashboard third.
- **Runtime interpretation has a small perf tax.** Hot paths (1000-row table, dense Kanban) need careful memoization. Profiling early prevents jank.
- **Custom-widget catalog ownership.** Every domain that wants a special widget (barcode, signature pad, drawing canvas) is a CrossEngin work item. We can't open it up for tenant-supplied code (closed-source posture).
- **No visual designer in v1.** Tenants edit views via the AI Architect; non-conversational tenants are not served.

### Neutral

- **shadcn + Tailwind is a known quantity** in the React ecosystem. Recruiting and onboarding benefit.
- **Hot reload during development** works as for any Next.js app; manifest changes trigger view-component re-render via the data layer.

### Reversibility

**Moderate cost.** Swapping table libraries (TanStack Table) or form libraries (react-hook-form) is one renderer rewrite each. Swapping the entire renderer paradigm (e.g., to compile-time code generation) is a quarter+ of work.

**High cost** for the manifest view schema. Once tenants and the AI Architect author views, breaking changes require migration. Additive evolution (new view kinds, new view fields) is cheap.

## Implementation notes

- **Package boundaries:**
  - `packages/ui` — shadcn primitives, design tokens, theme provider.
  - `packages/ui-renderers/<name>` — one per view kind.
  - `packages/ui-widgets` — field widgets (input variants, pickers, etc.).
  - `packages/ui-icons` — Lucide-React wrapper with CrossEngin extensions.
- **Data fetching:** TanStack Query in `apps/web/lib/queries`. Renderers receive data as props; they never call fetch().
- **State management:** local component state for renderer UI; `nuqs` (URL state) for filters/sort/pagination; Zustand for cross-component renderer state (e.g., Kanban drag state).
- **Form library:** react-hook-form + Zod resolver. Multi-step forms use react-hook-form's `useFieldArray` for repeating sections.
- **Table library:** TanStack Table (headless) + `@tanstack/react-virtual` for 100K+ row lists.
- **Kanban library:** dnd-kit (more accessible than `react-beautiful-dnd`).
- **Calendar library:** FullCalendar wrapped in a CrossEngin component to apply theme + permission decisions.
- **Map library:** MapLibre GL (open-source successor to Mapbox GL).
- **Chart library:** Recharts for v1 dashboards. Visx for advanced (Pivot) viz later.
- **Theming:** Tailwind v4 with CSS variables. Resolved palette set via `<style>` in `<head>` per request.
- **i18n:** `react-intl` for ICU MessageFormat; manifest translations bundled into MessageFormat catalogs at build/apply time.
- **RTL:** Tailwind's `rtl:` variant + logical properties (`ps-*`, `pe-*`, `text-start`, `text-end`).
- **Performance budgets:**
  - First Contentful Paint < 1.5 s on 4G median.
  - Time to Interactive < 3.0 s on 4G median.
  - Per-renderer render budget: List 50 ms for 1K rows; Record 200 ms; Form 100 ms.
  - JS bundle per route < 250 KB gzipped initial; renderers lazy-loaded.
- **Accessibility tooling:** `axe-core` in CI runs against representative views. `eslint-plugin-jsx-a11y` enforces baseline rules. Manual screen-reader testing pre-Phase-5 launch.
- **Tooling alignment with Capacitor:** the renderer uses no DOM APIs unavailable on iOS/Android WebView; verified via a Capacitor-build CI job (ADR-0019).
- **Renderer testing:** Vitest for unit tests; Storybook for visual review; Playwright for E2E smoke per view kind. Snapshot testing for the deterministic diff explainer's output.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Table library choice — TanStack Table headless is the lead candidate, but AG-Grid Community Edition offers more out-of-the-box features. Worth the extra bundle + license cost? | amoufaq5 | Phase 2 |
| Calendar library — FullCalendar is feature-rich but has historical license complexity (FullCalendar Premium for some views). Build our own thin calendar on date-fns + react-day-picker if license is friction? | amoufaq5 | Phase 3 |
| Theme overlay scope: at v1 we expose brand color + accent + density. Should tenants also override component-level styling (button shape, card elevation)? Slippery slope toward "tenant CSS injection." | _pending design hire_ | Phase 4 |
| Custom-widget governance: process for accepting first-party custom widgets when MENA pharma chains demand them (label printers, prescription pads, etc.). | amoufaq5 + _pending compliance hire_ | Phase 4 |
| Visual designer for non-conversational tenants — Phase 4 lightweight (filters/columns editing only) vs. Phase 5+ full view-builder. | amoufaq5 | Phase 4 |
| Pivot renderer scope — is it a v1 deliverable or deferred to Phase 6 (Operate Professional Services / Field Service has heavy pivot needs)? | amoufaq5 | Phase 4 |
| Dashboard renderer chart library — Recharts is the lead; visx and ECharts are alternatives with different trade-offs. | amoufaq5 | Phase 3 |
| Theming dark mode contrast — guarantee AA across all family overlays in dark mode, or warn-only with tenant-side override? | _pending design hire_ | Phase 4 |

## References

- ADR-0003 (Meta-schema and dynamic entity engine) — defines the field types the form renderer auto-generates from.
- ADR-0004 (Manifest specification) — defines the `views`, `forms`, `dashboards`, `i18n`, `theme` manifest sections.
- ADR-0005 (AI Architect contract) — defines how views are proposed and applied via the AI Architect.
- ADR-0008 (RBAC v2, ABAC, audit) — defines the permission decisions the renderer consumes.
- ADR-0014 (Files and storage) — defines the file upload widget integration.
- ADR-0019 (PWA and Capacitor mobile) — defines mobile-specific renderer constraints and native plugin hooks.
- ADR-0022 (Internationalization and localization) — defines the i18n context the renderer consumes.
- shadcn UI documentation; Tailwind CSS v4 documentation; TanStack Table; react-hook-form; FullCalendar; MapLibre GL; WCAG 2.1.
