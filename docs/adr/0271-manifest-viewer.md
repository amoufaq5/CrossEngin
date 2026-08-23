# ADR-0271: Manifest viewer — rendering the schema behind a proposal (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0270 (design-review queue), ADR-0267 (AI onboarding), ADR-0269 (async design jobs), ADR-0077 (Phase 4) |

## Context

ADR-0270 gave platform operators a review queue with an automated risk report, but a reviewer
approving a proposal saw only that report and a manifest hash — never the entities, fields,
classifications, permissions or lifecycle they were approving. The same was true for the tenant
on the wizard's review step, one click from making the schema live. Both were being asked to
sign off on something they could not see.

## Decision

- **The projection lives server-side.** `manifest-view.ts` turns a raw
  `Record<string, unknown>` manifest into a display view model. It is not in the web app
  because `apps/operate-web` deliberately carries zero workspace imports, and because one
  tested implementation should serve every client (the reviewer UI, the tenant wizard, and any
  future CLI or export).
- **The projection is readable, not raw.** `formatFieldType` renders `text(200)`,
  `enum(a | b)` (capped at six values, then `+N more`), `reference → Customer`,
  `decimal(12,2)`, `integer(0…10)`. Entities carry their traits and an `auditable` flag; the
  **five CRUD permissions are always present**, so an *ungranted* operation is visible rather
  than merely absent — that is exactly what a reviewer needs to notice. `entityLifecycle`
  states and transitions attach to their entity (a string `from` normalized to an array), and
  roles carry a grant count across CRUD, transition and field-level grants.
- **Defensive by construction.** Array-shaped and record-keyed manifests project identically;
  malformed input yields empty arrays and zero counts rather than throwing. The input is
  LLM-authored, so this is a correctness requirement, not politeness.
- **Injected, optional, additive.** Routes take a `projectSchema` projector the same way they
  already take `assessRisk`. The `schema` key is **omitted entirely** (never `undefined`) when
  no projector is wired, so existing callers see byte-identical responses. It is added to the
  review detail, the tenant's proposal detail, and a succeeded design job — the list route
  stays manifest-free and schema-free, since projecting every row would bloat it.
- **UI**: `SchemaView` renders on both the platform review detail and the wizard review step —
  collapsible entities (auto-expanded at ≤3 so a large manifest stays scannable), a dense field
  table, classification chips (`phi`/`regulated` red, `pii`/`commercial_sensitive` amber),
  inline reference targets, a permission matrix where an ungranted operation reads as a dashed
  "no roles" card, lifecycle states and transitions, relations and roles. Keyed by proposal id
  so collapse state cannot leak between records.

## Consequences

- **Verified live** against a real Postgres: `GET /v1/platform/design-reviews/:id` returned the
  full projection — both entities with typed fields, the `pii` and `commercial_sensitive`
  classifications, `reference → Customer`, the complete permission matrix, the relation with its
  `onDelete`, and role grant counts — and the UI rendered it under the risk findings.
- One UX fix came out of looking at the rendered result rather than trusting the markup: at
  laptop width the classification column sat outside the table's horizontal scroll viewport, so
  the reviewer's most important signal required scrolling. Classification now precedes the
  required column and is visible without scrolling.
- +52 tests (operate-server **46 files / 827**; the projection alone is 36). Full workspace
  build + typecheck + test green; operate-web build green. Typecheck also confirms the real
  `ManifestView` stays structurally assignable to the type the routes inject — the seam where
  the two parallel implementations meet.
- Follow-ups: per-field and per-transition grants are summarized only as a role's grant count,
  not shown individually; a diff view against the tenant's currently-active manifest (what
  actually changes on activation) would be the natural next step; and notifying a tenant when
  their proposal is decided remains open from ADR-0270.
