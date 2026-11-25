import { blocksWrites } from "@crossengin/tenant-lifecycle";
import type { TenantStanding, TenantStandingReader } from "@crossengin/operate-runtime";

import type { TenantStatusDirectory } from "./tenant-status-gate.js";

/**
 * The tenant standing a system writer consults before every job write (ADR-0469), read off the same
 * directory the request-path gate reads, so a job and a request cannot disagree about whether one
 * tenant may be written. The rule is `blocksWrites`, called and not restated, and it lives here and
 * not in `@crossengin/operate-runtime`: that package must not depend on the tenant lifecycle, so the
 * writer is handed a reader and this module is the one place that turns a lifecycle state into it.
 *
 * Three answers, and the third is why the reader returns a union rather than a boolean:
 *
 * - a state that does not block writes is `writable`;
 * - a state that does — `suspended`, `archived`, `pending_deletion`, `deleted` — is `blocked` with
 *   that state, which the writer turns into a non-retryable refusal, because the run is wrong for as
 *   long as the tenant holds the state and retrying it is the same answer;
 * - no row is `blocked` as `unprovisioned`: the claim reads its tenants from `meta.tenants`, so a run
 *   for a tenant with no row is not one a deployment can produce, and a write for a tenant nobody
 *   provisioned is the defect ADR-0376 measured on the request path, refused rather than guessed;
 * - a directory that throws is `unknown`, which the writer turns into a **retryable** failure: not
 *   knowing must not admit the write (fail closed), and it must not dead-letter work a database blip
 *   kept from being checked.
 */
export function tenantStandingFromDirectory(directory: TenantStatusDirectory): TenantStandingReader {
  return async (tenantId: string): Promise<TenantStanding> => {
    let status;
    try {
      status = await directory.statusFor(tenantId);
    } catch (err) {
      return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
    }
    if (status === null) return { kind: "blocked", status: "unprovisioned" };
    return blocksWrites(status) ? { kind: "blocked", status } : { kind: "writable" };
  };
}
