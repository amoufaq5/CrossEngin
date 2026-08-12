import {
  PackSubmissionEngine,
  type PublishInput,
  type ReviewOutcomeInput,
  type RetireInput,
  type SubmitVersionInput,
} from "@crossengin/marketplace-runtime";
import type { Clock } from "@crossengin/marketplace-runtime";
import type { PackVersionRecord } from "@crossengin/marketplace";
import type { PgConnection } from "@crossengin/kernel-pg";

import { PostgresPackVersionStore } from "./version-store.js";

/**
 * A `PackSubmissionEngine` whose every step also persists the resulting
 * `PackVersionRecord` into `meta.pack_versions` (idempotent `UPSERT` on
 * `(pack_id, version)`). The pure engine stays the source of truth for the state
 * machine + signature/gate checks; this wrapper is the persistence boundary.
 */
export class PersistentPackSubmissionEngine {
  readonly engine: PackSubmissionEngine;
  readonly store: PostgresPackVersionStore;

  constructor(parts: { readonly engine: PackSubmissionEngine; readonly store: PostgresPackVersionStore }) {
    this.engine = parts.engine;
    this.store = parts.store;
  }

  async submit(input: SubmitVersionInput): Promise<PackVersionRecord> {
    return this.persist(this.engine.submit(input));
  }

  async submitForReview(version: PackVersionRecord): Promise<PackVersionRecord> {
    return this.persist(this.engine.submitForReview(version));
  }

  async recordReview(version: PackVersionRecord, outcome: ReviewOutcomeInput): Promise<PackVersionRecord> {
    return this.persist(this.engine.recordReview(version, outcome));
  }

  async publish(version: PackVersionRecord, input: PublishInput): Promise<PackVersionRecord> {
    return this.persist(this.engine.publish(version, input));
  }

  async deprecate(version: PackVersionRecord, input: RetireInput): Promise<PackVersionRecord> {
    return this.persist(this.engine.deprecate(version, input));
  }

  async withdraw(version: PackVersionRecord, input: RetireInput): Promise<PackVersionRecord> {
    return this.persist(this.engine.withdraw(version, input));
  }

  private async persist(version: PackVersionRecord): Promise<PackVersionRecord> {
    await this.store.upsert(version);
    return version;
  }
}

export function buildPersistentPackSubmissionEngine(
  conn: PgConnection,
  options: { readonly clock?: Clock } = {},
): PersistentPackSubmissionEngine {
  return new PersistentPackSubmissionEngine({
    engine: new PackSubmissionEngine(options),
    store: new PostgresPackVersionStore(conn),
  });
}
