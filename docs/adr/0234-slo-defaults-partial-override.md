# ADR-0234: Partial override for manifest-derived SLOs (`--slo-defaults-override`) (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0233 (--slo-defaults), ADR-0227 (--slo-config), ADR-0077 (P3 plan — P8) |

## Context

`--slo-defaults` (ADR-0233) derives sensible SLOs from the manifest but with placeholder defaults: a
stand-in alert policy (no real paging) and a nil system actor. The alternative, `--slo-config`, means
re-declaring every SLO by hand just to attach a real alert policy. The missing middle is: keep the
derived per-operation SLOs, but layer real paging + tuning + a few extra SLOs on top — without
re-authoring the derived set.

## Decision

- **`SloDefaultsOverrideSchema`** (`slo-defaults.ts`) — a fully-optional partial: `systemActorUserId?`,
  `alertPolicy?`, `evaluateIntervalMs?`, the derivation tweaks (`window?`, `readAvailability?`,
  `writeAvailability?`, `readP95?`, `writeP95?`, `includeLatency?`, `tenantId?`), and
  `extraAvailability?` / `extraLatency?` (extra `SloRegistrationConfig`s appended after the derived
  ones). `sloDefaultsOptionsFromOverride` maps it to `deriveSloConfig` options, dropping the undefined
  keys — so every field the file omits keeps its derived default.
- **`deriveSloConfig` extended** to append `extraAvailability` / `extraLatency` before the final
  `SloConfigSchema.parse`, so an override's extra SLOs are validated identically to the derived ones
  (and the empty-guard now counts availability + latency together).
- **`--slo-defaults-override <path>` flag** — requires `--slo-defaults` (CLI-enforced); `serve()` loads
  the override, maps it to options, and derives the config with them. `SloRegistrationConfigSchema` was
  exported from `slo-config.ts` for reuse.

## Consequences

- The three-way choice is now complete: `--slo-config` (fully hand-authored), `--slo-defaults`
  (fully derived, placeholder paging), and `--slo-defaults` + `--slo-defaults-override` (derived SLOs +
  real paging/tuning + a few bespoke SLOs). An operator gets production-grade SLO enforcement with a
  ~10-line override instead of a per-operation config.
- The override is validated end-to-end: its `alertPolicy` by `AlertPolicySchema`, its extra SLOs by
  `SloSchema` (via the final `SloConfigSchema.parse`), so a malformed override is rejected at boot, not
  silently ignored.
- Merge semantics are last-writer-wins per field with omitted keys inheriting the derived default — the
  smallest surprise. Extra SLOs are additive (they never replace a derived surface's SLO; two SLOs on
  one surface would both evaluate, which the engines already dedup per incident).
- +8 operate-server tests (override parse + unknown-key reject, layering a real policy + tweaks,
  omitted-fields inheritance, extra-registration append, file load + missing-file error, CLI parse +
  requires-`--slo-defaults`). Full build + typecheck + workspace tests green. No META tables, no new
  package or dependency.
- Follow-up (open): per-surface target overrides in the file (tighten one operation without a full
  extra SLO); deriving the override's alert policy from the deployment descriptor.
