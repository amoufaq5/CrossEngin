# ADR-0148: Minimalist console UI

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | operate-web console (ADR-0127+ report screens) |

## Context

The console used a crisp-white theme with a salient red accent applied fairly widely
(active nav, key figures, hero cards) plus card shadows and uppercase labels. The ask is a
minimalist restyle. Implemented at the design-token + primitive + shared-chrome level so it
cascades across every screen without editing each page.

## Decision

- **Tokens (`tailwind.config.ts`).** Flat by default — `shadow.card = none`, `pop` softened
  to a light overlay; `line` lightened to a truer hairline (`#ecedf0`); ink softened; border
  radius tightened (`xl` 0.9→0.625rem); brand kept but its tints muted.
- **Primitives (`globals.css`).** `.card` is border-only (no shadow); `.label` drops
  uppercase/tracking and heavy weight (sentence-case, `font-medium`); `.btn` is `font-medium`
  with a neutral focus ring and no active nudge; `.field` loses its shadow and uses a subtle
  ink focus border.
- **Restrained accent.** Red is now reserved for the brand mark and primary actions only.
  The **Sidebar** active state is neutral (`bg-surface-sunken`/`text-ink`, not red), the role
  label and inbox count are neutral; the **Topbar** avatar/pills are neutral; the dashboard
  inbox hero is a neutral surface card. Status **Badge**s keep their functional colors
  (green/amber/red for scannability) but lose the ring for flatness.

## Consequences

- The interface reads calm and content-first: near-monochrome, generous whitespace, hairline
  borders, no shadows, one deliberate red for identity + primary CTAs.
- Cascades to all screens via tokens/primitives/chrome — individual pages using `.card`,
  `border-line`, `rounded-xl`, and the shared components pick it up automatically.
- `operate-web` build green; no package/server change.
- Follow-up: a light/dark theme token pass; per-tenant brand-color theming (relevant to the
  multi-tenant cloud offering).
