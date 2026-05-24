# ADR-0239: Operator guides convention + retention operator guide

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.operator-guide
- **Closes**: Consolidation of the retention CLI surface (ADR-0143
  through ADR-0238, ~33 milestones) into a single operator-facing
  reference
- **Related**: All retention CLI ADRs (ADR-0143/0150/0161/0186/0193/0198/
  0203/0205/0206/0207/0208 .. 0238)

## Context

The retention CLI has grown to 15 actions with a deep flag surface
across ~33 milestones this phase: the full filter family (kind / actor /
system-presence × positive/negative/multi-value), per-side expectation
checks, 5 output formats, 2 contradiction-detection layers, `--explain`
with raw SQL, and an analytics `summary` surface (8 dimensions +
cross-tab + gap-filling + timezone + top/min-count).

This capability is documented in 31 ADRs (design rationale) + the CLI
`--help` text (terse usage). Neither is an operator-facing *guide* —
ADRs are decision records (why), `--help` is a reference card (syntax).
Operators learning the surface have no single narrative document that
explains concepts, the shared filter family, the two-level JSON envelope,
and worked end-to-end examples.

This ADR establishes a `docs/operator-guides/` convention and ships the
first guide: `retention.md`.

## Decision

Create `docs/operator-guides/` for operator-facing narrative
documentation, distinct from `docs/adr/` (decision records). Ship
`docs/operator-guides/retention.md` consolidating the retention CLI.

### Guide structure (retention.md)

1. **Concepts** — platform default / per-tenant override / opt-out /
   history / event_kind / actor_id.
2. **Actions at a glance** — a 15-row table.
3. **Per-action sections** — grouped by mutation / read / history /
   summary / diff-* / prune.
4. **The filter family** — documented once (shared across history /
   diff-timeline / summary) rather than repeated per action.
5. **Output formats + the two-level JSON envelope** — the
   envelope-input-echo vs result-data distinction (ADR-0233).
6. **`--explain`** — query inspection with raw SQL.
7. **Exit codes** — 0 / 1 / 2 semantics.
8. **Worked examples** — end-to-end operator scenarios.

### Why a guide vs more ADRs

- ADRs answer "why was this designed this way?" (one decision each).
- `--help` answers "what's the exact syntax?" (terse).
- The guide answers "how do I accomplish operator task X?" (narrative +
  cross-cutting concepts + examples) — the missing layer.

### Convention for future guides

`docs/operator-guides/<surface>.md` — one per major operator surface
(retention now; future: chat, gateway, apply, packs). Each guide:
concepts → actions table → per-action → cross-cutting (formats,
filters) → exit codes → worked examples.

## Rejected alternatives

1. **Expand `--help` into a full guide** — `--help` should stay a terse
   reference card; a 300-line help dump is hostile to terminal users.
2. **Generate the guide from `--help` text** — the guide needs
   narrative + concepts + examples that don't belong in help text;
   auto-generation would lose the cross-cutting structure.
3. **Put the guide in the README** — the README is project-level; a
   surface-specific operator guide belongs in a dedicated docs path.
4. **One guide covering all CLI surfaces** — retention alone is
   substantial; per-surface guides are more navigable.
5. **A docs site (mkdocs/docusaurus)** — premature; markdown files in
   `docs/` are discoverable + render on GitHub; a site can wrap them
   later.
6. **No guide (rely on ADRs + help)** — operators shouldn't need to read
   31 ADRs to learn the surface; the consolidation has clear value.

## Future questions

1. **Operator guides for other surfaces** — chat, gateway, apply, packs.
   Each follows the retention.md structure. Defer — write as surfaces
   mature.

2. **Auto-validation that the guide matches the CLI** — a test asserting
   every documented flag exists in the parser + vice versa. Defer —
   the guide is prose; drift is caught in review. Could add a
   lightweight "documented actions == dispatch actions" test later.

3. **Generated flag reference appendix** — auto-extract the `--help`
   text into a guide appendix for completeness. Defer.

4. **Linking ADRs from the guide** — each guide section could cite the
   ADR(s) that introduced it. Defer — the guide is task-oriented, not
   decision-oriented; ADR cross-refs would clutter it.

5. **Versioning the guide with CLI changes** — when a flag changes, the
   guide updates. Defer — guide lives in-repo + updates with the code.

6. **A docs index / table of contents** — `docs/README.md` linking adr/
   + operator-guides/ + vision.md. Defer — small docs tree for now.

## Consequences

- **Operators get a single narrative reference** — concepts + 15 actions
  + shared filter family + formats + two-level envelope + examples in
  one document.
- **`docs/operator-guides/` convention established** — future surfaces
  (chat / gateway / apply / packs) get parallel guides.
- **No code changes** — pure documentation; no tests added (the guide is
  prose, validated in review).
- **The ~33-milestone retention investment is now usable** — the
  capability scattered across 31 ADRs + help text is consolidated into
  an operator-facing guide.
- **ADRs + help + guide are now layered** — ADRs (why) + `--help`
  (syntax) + guide (how/concepts/examples); each serves a distinct
  reader need.
- **Capstone for the retention CLI phase** — the surface is feature-
  complete (ADR-0238) and now documented (this ADR); a natural point to
  broaden to other Phase 2 surfaces.
