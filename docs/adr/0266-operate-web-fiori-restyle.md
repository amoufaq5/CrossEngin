# ADR-0266: SAP-Fiori restyle of operate-web in the CrossEngin palette (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0265 (platform admin console), ADR-0077 (Phase 4) |

## Context

`operate-web` had a minimalist near-monochrome look. The request was an SAP-Fiori
enterprise feel — top shell bar, tile launchpad, dense data tables, bold type —
but in the CrossEngin palette (brand red `#E5132B`, not Fiori blue), with
translucent chrome where it reads well.

The app funnels its visual language through a small set of shared primitives:
semantic color tokens (`brand` / `ink` / `surface` / `line`) and component
classes (`.btn*`, `.card`, `.field` ×97, `.label` ×230). So the restyle could be
achieved by changing the *definitions* of those primitives plus the shell chrome —
cascading to every page — rather than editing each page.

## Decision

- **Type:** wire **Inter** (weights 400–900) via `next/font/google` in the root
  layout, setting the `--font-sans` variable the theme already referenced (it was
  previously unset, falling back to system fonts). Headings default to bold.
- **Theme (`tailwind.config.ts`):** keep the brand red scale; cool the neutral
  ramp; add a Fiori elevation scale (`tile` / `tile-hover` / `shell` / `pop`) and
  a `shell` backdrop-blur. No token *names* changed, so existing pages keep
  working.
- **Component classes (`globals.css`):** restyle `.btn-primary` (bold, elevated),
  `.field` (focus ring in brand), `.label` (uppercase semibold), `.card`; add
  `.shell-bar` + `.glass` (translucent blurred chrome), `.tile` (lift-on-hover
  launchpad tile), `.data-table` (sticky uppercase headers, zebra, brand hover),
  `.page-header`, `.chip`.
- **Shell chrome:** a new translucent **`ShellBar`** spans the app (brand mark,
  product title, workspace chip, viewer role + avatar); the root layout stacks it
  above the (side-nav + work area) row. The `Sidebar` drops its own logo (now in
  the shell bar), sits below the bar, and marks the active item with a Fiori-style
  red left-accent selection. `Topbar` becomes a bold object-page header. The home
  page's stat + department + workflow cards become `.tile`s.

## Consequences

- The whole console reads as SAP-Fiori in the brand red — verified by rendering a
  real production build (Chromium screenshots of the launchpad, an entity
  object-page, and the platform console): translucent shell bar, red-accent side
  nav, bold KPI tiles, dense tables, bold red primary actions.
- Pure `operate-web` change — no backend, no API, no schema, no shared package
  touched; every other package is unaffected. The restyle rides the existing
  token/class seams, so per-page markup was largely untouched (only the home
  launchpad tiles + the two chrome components).
- `next build` green (all 12 routes; Inter fetched at build), `operate-web`
  typecheck green, full workspace `-r typecheck` green. (operate-web has no test
  suite; it is typecheck- and build-gated.)
- Follow-up (open): apply `.data-table` to the entity list/table component for
  full row-density parity; a dark theme; per-tenant brand theming (logo + accent)
  once tenants can carry brand settings.
