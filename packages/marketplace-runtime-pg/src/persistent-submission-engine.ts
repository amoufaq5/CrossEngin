import {
  PackSubmissionEngine,
  type PublishInput,
  type ReviewOutcomeInput,
  type RetireInput,
  type SubmitVersionInput,
} from "@crossengin/marketplace-runtime";
import type { Clock } from "@crossengin/marketplace-runtime";
import type { PackPublisherRegistry, PackVersionRecord } from "@crossengin/marketplace";
import type { PgConnection } from "@crossengin/kernel-pg";

import { PostgresPackVersionStore } from "./version-store.js";

/**
 * A `PackSubmissionEngine` whose every step also persists the resulting `PackVersionRecord` into
 * `meta.pack_versions`: a submission inserts a new version and refuses one that exists, and every
 * later step advances the row only from the state it was read in. The pure engine stays the source
 * of truth for the state machine and the publisher/gate checks; this wrapper is the persistence
 * boundary.
 */
export class PersistentPackSubmissionEngine {
  readonly engine: PackSubmissionEngine;
  readonly store: PostgresPackVersionStore;

  constructor(parts: { readonly engine: PackSubmissionEngine; readonly store: PostgresPackVersionStore }) {
    this.engine = parts.engine;
    this.store = parts.store;
  }

  async submit(input: SubmitVersionInput): Promise<PackVersionRecord> {
    const draft = this.engine.submit(input);
    await this.store.insertDraft(draft);
    return draft;
  }

  async submitForReview(version: PackVersionRecord): Promise<PackVersionRecord> {
    return this.advance(version, this.engine.submitForReview(version));
  }

  async recordReview(version: PackVersionRecord, outcome: ReviewOutcomeInput): Promise<PackVersionRecord> {
    return this.advance(version, this.engine.recordReview(version, outcome));
  }

  async publish(version: PackVersionRecord, input: PublishInput): Promise<PackVersionRecord> {
    return this.advance(version, this.engine.publish(version, input));
  }

  async deprecate(version: PackVersionRecord, input: RetireInput): Promise<PackVersionRecord> {
    return this.advance(version, this.engine.deprecate(version, input));
  }

  async withdraw(version: PackVersionRecord, input: RetireInput): Promise<PackVersionRecord> {
    return this.advance(version, this.engine.withdraw(version, input));
  }

  private async advance(previous: PackVersionRecord, next: PackVersionRecord): Promise<PackVersionRecord> {
    await this.store.advance(previous, next);
    return next;
  }
}

export function buildPersistentPackSubmissionEngine(
  conn: PgConnection,
  options: { readonly clock?: Clock; readonly publishers: PackPublisherRegistry },
): PersistentPackSubmissionEngine {
  return new PersistentPackSubmissionEngine({
    engine: new PackSubmissionEngine(options),
    store: new PostgresPackVersionStore(conn),
  });
}
