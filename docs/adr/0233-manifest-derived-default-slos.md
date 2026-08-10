# ADR-0233: Manifest-derived default SLOs (`--slo-defaults`) (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0227 (--slo-config), ADR-0226 (SLO live-stream wiring), ADR-0060 (observability-runtime), ADR-0077 (P3 plan — P8) |

## Context

`--slo-config` (ADR-0227) makes the deployed binary auto-enforce SLOs, but only from a hand-written JSON
file — every deployment must author availability/latency targets per surface before it gets any SLO
coverage. The manifest already declares every entity operation (the gateway's `routeOperationId`s), so a
pack can ship with sensible default SLOs derived from its own shape, with zero config.

## Decision

- **`deriveSloConfig(manifest, opts?)`** (`slo-defaults.ts`) — a pure function that walks
  `manifestRouteSpecs(manifest)` and emits one availability SLO (and, by default, one latency SLO) per
  entity operation surface. Read operations (`list`/`read`/`get`) get a tighter availability target
  (default 0.999) + a lower latency budget (p95 200ms, `endpointClass: "read"`); writes (create / update
  / delete / lifecycle transitions) get 0.995 + p95 500ms (`endpointClass: "write"`). The SLO `surface`
  is the operationId (matching the gateway's `routeOperationId`); the SLO `id` is a kebab slug of it
  (`sloSlug`: `salesOrder.create` → `salesorder-create-availability`). Every target/window is
  overridable via `opts`; the result is validated through the existing `SloConfigSchema`, so it is a
  drop-in for `buildSloEnforcement`.
- **Defaults for zero-config operation**: `DEFAULT_SLO_SYSTEM_ACTOR` (nil uuid) and a
  `DEFAULT_SLO_ALERT_POLICY` (a placeholder routing the emitted severities to a default channel) let
  `--slo-defaults` enforce with nothing else supplied; a deployment that actually pages supplies a real
  policy via `--slo-config`.
- **`--slo-defaults` flag** — when set, `serve()` derives the config from the loaded (resolved) manifest
  instead of a file. Mutually exclusive with `--slo-config` (CLI rejects both).

## Consequences

- A pack now ships with SLO coverage for free: `operate-server --pack erp-retail --slo-defaults` enforces
  availability + latency on every entity operation over the live request stream — no config authoring.
  The read/write target split gives sensible, differentiated defaults out of the box.
- The derivation is pure + validated through `SloConfigSchema`, so a derived config is
  indistinguishable from a hand-written one downstream — the whole `--slo-config` machinery (observer,
  scheduler, incident/paging/rollback) is reused unchanged.
- Defaults are honest placeholders: the alert policy pages a stand-in channel, so an operator who wants
  real routing still uses `--slo-config` (or, as a follow-up, `--slo-defaults` + a partial override
  file). The nil system actor is a valid uuid but obviously non-attributable — a deployment override is
  expected in production.
- +10 operate-server tests (slug kebabbing, per-operation derivation, read>write target split, latency
  endpointClass, overrides, empty-manifest guard, CLI parse + mutual exclusion). Full build + typecheck +
  workspace tests green. No META tables, no new package or dependency (operate-runtime + observability
  are already deps).
- Follow-ups (open): merging `--slo-defaults` with a partial override file (defaults + a real alert
  policy without re-declaring every SLO); deriving DR infra + access-review scopes from the
  deployment/manifest the same way; per-endpoint budget hints on the manifest's `ListView` /
  lifecycle declarations.
