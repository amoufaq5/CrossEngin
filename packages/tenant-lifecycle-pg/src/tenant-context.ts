/**
 * The one spelling of "scope this transaction to a tenant", for this package.
 *
 * Its own module following the convention five sibling `-pg` packages already follow
 * (`access-reviews-runtime-pg`, `ai-architect-runtime-pg`, `billing-runtime-pg`, `crypto-pg`,
 * `dr-runtime-pg`), rather than a re-export out of whichever store happened to need it first.
 *
 * It exists here because two of this package's stores were writing **unscoped** and could therefore
 * never write at all against a real non-owner database (ADR-0335): on both
 * `meta.gdpr_deletion_requests` and `meta.tenant_lifecycle_events` the isolation policy is the only
 * arm carrying a `WITH CHECK` — the platform arm is `SELECT`-scoped by ADR-0332's rule — so an
 * `INSERT` or `UPDATE` with no `app.current_tenant_id` raises `42501`. The *reads* elevate through
 * `app.platform_audit` and worked fine, which is exactly what hid it: an operator could list
 * deletion requests and never create one.
 *
 * Transaction-local (`set_config(…, true)`), which is load-bearing twice over. It means a scope set
 * for one append cannot leak past the commit into a pooled connection's next caller — and it means
 * a bare `conn.query` is **not** enough: without a wrapping transaction the setting is discarded
 * with the implicit single-statement transaction it was set in, before the statement it was for.
 */
export const SET_TENANT_CONTEXT_SQL = "SELECT set_config('app.current_tenant_id', $1, true)";
