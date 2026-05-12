# @crossengin/kernel-supabase

Supabase adapter for the CrossEngin kernel.

Supabase is the primary v1 host (Round 1 decision; ADR-0002 +
ADR-0010). This package provides:

- Connection management (one Postgres client per tenant; SET LOCAL
  for RLS context).
- Storage adapter (Supabase Storage as the v1 file backend per
  ADR-0014).
- Auth bridge (Supabase Auth for sessions, optionally backing
  `@crossengin/auth`).
- Realtime channel (Phase 2-3).

## On-prem and BYOC

For deployments that can't use Supabase, the equivalent surface is
provided by `@crossengin/kernel-prisma` (built alongside this
adapter per ADR-0024).

## Status

Skeleton. Real implementation lands in Phase 2.
