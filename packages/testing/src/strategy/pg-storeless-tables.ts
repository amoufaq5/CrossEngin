import { z } from "zod";

/**
 * The catalogued tables nothing writes, turned from a backlog into a decision.
 *
 * ADR-0333's scanner could enumerate in one pass what the repo had been rediscovering one table at a
 * time: of 145 catalogued tables, 83 have no writer anywhere in the workspace. That class — declared
 * in Phase 1, never written — has been found by accident six times, by ADR-0300 (`feature_flags`,
 * drifted eighteen columns behind its contract), ADR-0318 (`tenant_tombstones`), ADR-0321
 * (`gdpr_deletion_requests`), ADR-0330 (both read-state tables, drifted to a column type their
 * contract's ids cannot be stored in), ADR-0331 (`workflow_definitions`) and twice in ADR-0333. **Every
 * one of them had drifted behind its contract by the time somebody tried to write it**, because
 * nothing compares a table nobody writes.
 *
 * ADR-0333 reported the number and deliberately did not assert on it, for a reason this file has to
 * respect: for many of these tables having no writer is a known, intentional state, so a blanket
 * assertion would fail on day one and be muted — and a muted check is worse than none. So the
 * assertion is not "every table has a writer". It is:
 *
 *   **no catalogued table is writerless without a declaration saying why.**
 *
 * That turns the next Phase-1-style table into a test failure at the moment it is added, and turns
 * this list into a decision with a reason per member — which is the repo's established idiom for
 * exactly this shape: `PLATFORM_RECORD_TABLES` and `STATUTORY_RETENTION_TABLES` in
 * `tenant-lifecycle-pg`, and `DELIBERATELY_ERASED_BILLING_TABLES`, which exists to "name them so
 * nobody completes the table later".
 *
 * **Why the declaration lives here and not in the catalog.** It was argued both ways. Against: a
 * maintained list in `packages/testing` is the shape ADR-0288's `needsAuditEmitter` had, and that was
 * wrong three times. For, and decisively:
 *
 *  - *ADR-0288's list had no forcing function.* You could add a flag and never touch it, and nothing
 *    compared the two copies. This list is compared against `META_TABLES` **in both directions** on
 *    every test run: a writerless table with no declaration fails, a declaration for a table that has
 *    acquired a writer fails, and a declaration naming a table the catalog does not have fails. A list
 *    that cannot be out of date without going red is not ADR-0288's list.
 *  - *The repo's own precedent puts the set with the consumer.* `PLATFORM_RECORD_TABLES` names
 *    catalogued tables as plain strings and lives in the package that acts on the decision, not in
 *    `meta-schema.ts`. The consumer of this decision is the scanner, so the set lives beside it.
 *  - *In the catalog it would be the first `TableDefinition` field with no database consequence.*
 *    Every other annotation there — `notNull`, `check`, `rls`, `renamedFrom` — changes emitted DDL or
 *    a reconciliation step. "Nothing writes this, on purpose" changes neither, and a field that the
 *    emitter must ignore invites a reader that forgets to.
 *
 * The dependency graph does not decide it: the scanner reads `META_TABLES` as *text* precisely so it
 * can read anything on disk, so a declaration in the catalog would have been readable too.
 */

/* ------------------------------------------------------------------- reasons */

/**
 * Why a catalogued table has no writer. Six members, and the splits are the load-bearing part.
 *
 * ADR-0330 split one retention set into two because *defining a reason away* was what made a real
 * requirement inexpressible. The same trap is here twice:
 *
 *  - **`unbuilt_subsystem` vs `unwritten_table`.** Both are gaps, and merging them would hide the one
 *    that matters. A contracts-only subsystem nobody has implemented will be built, if ever, whole —
 *    with its tables reconciled against their contracts on the way in. A table *skipped beside a live
 *    store that writes its siblings* is the ADR-0300 class exactly: the store exists, it is being
 *    maintained, and this table is drifting silently behind the contract the store's siblings are
 *    kept honest against. Those are different risks and want different answers.
 *  - **`dynamic_writer` vs the rest.** A table written only through SQL whose target this scan cannot
 *    resolve is *written*, and calling it storeless would be a false statement about the most-written
 *    table in the product. It is declared with the file, cross-checked against `PG_SCAN_GAPS`, so the
 *    two lists cannot drift apart.
 */
export const STORELESS_REASONS = [
  /** The rows are a compile-time constant in TypeScript; a table would be a second source of truth. */
  "static_catalog",
  /** A named catalogued table is written instead; this one is a Phase-1 forward declaration. */
  "superseded",
  /** The facts come from outside this workspace — an identity provider, or deployment configuration. */
  "out_of_band",
  /** Written, but only through a statement `PG_SCAN_GAPS` declares the scanner cannot resolve. */
  "dynamic_writer",
  /** Nothing anywhere persists this subsystem's records; the owning package is contracts-only. */
  "unbuilt_subsystem",
  /** A live store writes this table's siblings and skips this one. The ADR-0300 class. */
  "unwritten_table",
] as const;
export type StorelessReason = (typeof STORELESS_REASONS)[number];

/** Only a `superseded` declaration may name a successor, and it must name one. */
export const SUCCESSOR_BEARING_REASONS: readonly StorelessReason[] = ["superseded"];

/** Only a `dynamic_writer` declaration may name the unresolvable statement, and it must name one. */
export const WRITER_BEARING_REASONS: readonly StorelessReason[] = ["dynamic_writer"];

/**
 * Only a gap may state a consequence, and it must state one — so a gap cannot be parked without
 * saying what a deployment does not get. Following ADR-0317's rule that only a scope-bearing outcome
 * may carry figures: a field that may ride along on any member is a field that can be forgotten.
 */
export const CONSEQUENCE_BEARING_REASONS: readonly StorelessReason[] = [
  "unbuilt_subsystem",
  "unwritten_table",
];

const QUALIFIED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

export const StorelessDeclarationSchema = z
  .object({
    /** Schema-qualified, as `META_TABLES` spells it: `meta.sso_providers`. */
    table: z.string().regex(QUALIFIED),
    reason: z.enum(STORELESS_REASONS),
    /** The package or app whose contracts declare the record this table would hold. */
    owner: z.string().min(1),
    /** The catalogued table(s) written instead. `superseded` only. */
    supersededBy: z.array(z.string().regex(QUALIFIED)).min(1).optional(),
    /** The workspace-relative file whose unresolvable statement writes it. `dynamic_writer` only. */
    writtenVia: z.string().min(1).optional(),
    /** What a deployment does not get. The two gap reasons only. */
    consequence: z.string().min(1).optional(),
    /** The evidence: which store writes the siblings, where the constant lives, who reads this. */
    note: z.string().min(20),
  })
  .superRefine((value, ctx) => {
    const wants = (set: readonly StorelessReason[]): boolean => set.includes(value.reason);
    if (wants(SUCCESSOR_BEARING_REASONS) !== (value.supersededBy !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersededBy"],
        message: `only a superseded declaration may name a successor, and it must name one (${value.reason})`,
      });
    }
    if (wants(WRITER_BEARING_REASONS) !== (value.writtenVia !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["writtenVia"],
        message: `only a dynamic_writer declaration may name the statement that writes it (${value.reason})`,
      });
    }
    if (wants(CONSEQUENCE_BEARING_REASONS) !== (value.consequence !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["consequence"],
        message: `only a gap may state a consequence, and a gap must state one (${value.reason})`,
      });
    }
  });
export type StorelessDeclaration = z.infer<typeof StorelessDeclarationSchema>;

/* -------------------------------------------------------------------- facts */

/**
 * What the workspace scan knows about one catalogued table.
 *
 * `written` and `read` are deliberately separate, and the separation is what makes the sharpest
 * finding in this file expressible at all: a table that is **read and never written** serves its
 * reader nothing, for ever, silently. `apps/operate-server/src/certification.ts` reads
 * `meta.access_review_evidence` to answer "is this deployment certifiable", and nothing writes that
 * table — so the adapter answers `null` on every call, which the certification engine reads as
 * "no evidence" rather than as "this check is not wired".
 */
export const StorelessTableFactsSchema = z.object({
  table: z.string().regex(QUALIFIED),
  /** Any INSERT, UPDATE, DO UPDATE, DELETE or TRUNCATE naming this table. */
  written: z.boolean(),
  /** Any SELECT, FROM or JOIN naming it. */
  read: z.boolean(),
});
export type StorelessTableFacts = z.infer<typeof StorelessTableFactsSchema>;

/* ----------------------------------------------------------------- findings */

export const STORELESS_FINDING_KINDS = [
  /** A catalogued table with no writer and no declaration. **This is the fence.** */
  "undeclared",
  /** Declared storeless and something writes it now — the decision has been overtaken by a store. */
  "overtaken",
  /** Declared for a table `META_TABLES` does not have. */
  "unknown_table",
  /** Declared twice, which would let two contradictory reasons both pass. */
  "duplicate",
  /** `dynamic_writer` naming a file `PG_SCAN_GAPS` does not declare a gap in. */
  "unsupported_dynamic_writer",
  /** `superseded` by a table the catalog does not declare. */
  "unknown_successor",
  /** `superseded` by a table that has no writer either, so nothing is persisted on either side. */
  "writerless_successor",
] as const;
export type StorelessFindingKind = (typeof STORELESS_FINDING_KINDS)[number];

export interface StorelessFinding {
  readonly kind: StorelessFindingKind;
  readonly table: string;
  readonly detail: string;
}

export interface StorelessAuditInput {
  readonly facts: readonly StorelessTableFacts[];
  readonly declarations: readonly StorelessDeclaration[];
  /** The files `PG_SCAN_GAPS` declares, so a `dynamic_writer` claim has to be backed by one. */
  readonly scanGapFiles: readonly string[];
}

/**
 * Reports every member of the class. An empty array is the invariant holding.
 *
 * `undeclared` is phrased from the catalog's side and `overtaken` from the declaration's, so the two
 * together pin the list in both directions — which is the property that distinguishes this from the
 * hand-maintained list ADR-0288 found wrong three times. A list that can only be wrong by going red
 * is not that list.
 */
export function auditStorelessTables(input: StorelessAuditInput): readonly StorelessFinding[] {
  const { facts, declarations, scanGapFiles } = input;
  const byTable = new Map<string, StorelessTableFacts>();
  for (const fact of facts) byTable.set(fact.table, fact);
  const gaps = new Set(scanGapFiles);

  const findings: StorelessFinding[] = [];
  const seen = new Set<string>();

  for (const declaration of declarations) {
    const { table } = declaration;
    if (seen.has(table)) {
      findings.push({
        kind: "duplicate",
        table,
        detail: `${table} is declared more than once, so two reasons would both pass`,
      });
      continue;
    }
    seen.add(table);

    const fact = byTable.get(table);
    if (fact === undefined) {
      findings.push({
        kind: "unknown_table",
        table,
        detail: `${table} is declared storeless and META_TABLES does not declare it — a stale decision`,
      });
      continue;
    }
    if (fact.written) {
      findings.push({
        kind: "overtaken",
        table,
        detail: `${table} is declared storeless (${declaration.reason}) and something now writes it — the decision is overtaken; remove the declaration`,
      });
    }
    if (declaration.writtenVia !== undefined && !gaps.has(declaration.writtenVia)) {
      findings.push({
        kind: "unsupported_dynamic_writer",
        table,
        detail: `${table} claims a dynamic writer in ${declaration.writtenVia}, which PG_SCAN_GAPS does not declare a gap in — either the statement resolves now or the file moved`,
      });
    }
    for (const successor of declaration.supersededBy ?? []) {
      const successorFact = byTable.get(successor);
      if (successorFact === undefined) {
        findings.push({
          kind: "unknown_successor",
          table,
          detail: `${table} is superseded by ${successor}, which META_TABLES does not declare`,
        });
        continue;
      }
      if (!successorFact.written) {
        findings.push({
          kind: "writerless_successor",
          table,
          detail: `${table} is superseded by ${successor}, which has no writer either — nothing persists this record on either side, so the reason is wrong`,
        });
      }
    }
  }

  for (const fact of facts) {
    if (fact.written || seen.has(fact.table)) continue;
    findings.push({
      kind: "undeclared",
      table: fact.table,
      detail: `${fact.table} is catalogued and nothing in the workspace writes it, and no declaration says why — ${
        fact.read
          ? "something reads it, so its reader is being served nothing"
          : "it is declared and unreachable"
      }. Add a STORELESS_TABLES line with a reason, or a writer.`,
    });
  }

  return findings;
}

export function formatStorelessFindings(findings: readonly StorelessFinding[]): string {
  return findings.map((f) => `[${f.kind}] ${f.detail}`).join("\n");
}

/**
 * The declared-storeless tables something reads — the sharp subset.
 *
 * A reader with no writer is not a dormant gap: it is a surface that answers "nothing" and is
 * indistinguishable, to its caller, from a surface that answers "nothing is there". Restricted to
 * the two gap reasons on purpose: `out_of_band` and `dynamic_writer` tables are *supposed* to be
 * read without this workspace writing them, and reporting those would bury the two that matter.
 */
export function readersWithNoWriter(
  facts: readonly StorelessTableFacts[],
  declarations: readonly StorelessDeclaration[],
): readonly StorelessDeclaration[] {
  const read = new Set(facts.filter((f) => f.read && !f.written).map((f) => f.table));
  return declarations
    .filter((d) => CONSEQUENCE_BEARING_REASONS.includes(d.reason) && read.has(d.table))
    .slice()
    .sort((a, b) => a.table.localeCompare(b.table));
}

export function countByReason(
  declarations: readonly StorelessDeclaration[],
): ReadonlyMap<StorelessReason, number> {
  const counts = new Map<StorelessReason, number>();
  for (const reason of STORELESS_REASONS) counts.set(reason, 0);
  for (const declaration of declarations) {
    counts.set(declaration.reason, (counts.get(declaration.reason) ?? 0) + 1);
  }
  return counts;
}

/* ------------------------------------------------------------ the declaration */

/**
 * Every catalogued table with no writer, with the reason it has none.
 *
 * Ordered by reason rather than alphabetically, because the reasons are what a reader is here for:
 * the first fourteen are decisions that should stay true, and the last sixty-nine are the backlog
 * with its cost written down. The count assertion in the test is against `META_TABLES`, not against
 * this list's length, so a member removed on its own is a failure rather than a smaller number.
 */
export const STORELESS_TABLES: readonly StorelessDeclaration[] = Object.freeze([
  /* ---------------------------------------------------------- static_catalog (2) */
  {
    table: "meta.regions",
    reason: "static_catalog",
    owner: "residency",
    note: "`REGIONS` in packages/residency/src/regions.ts is the eight-region source of truth, and `broadRegionOf` / the residency profiles are compiled against that union type; residency-runtime-pg persists per-*tenant* profiles (meta.tenant_residency_profiles), which is the part that varies.",
  },
  {
    table: "meta.plans",
    reason: "static_catalog",
    owner: "billing",
    note: "`DEFAULT_PLAN_CATALOG` in packages/operate-runtime/src/plan-catalog.ts, overridable per deployment by `--plan-catalog <file>`; entitlements and signed offline licences are resolved from that catalog, so a table would make the file and the row two sources of truth for what a tenant may do.",
  },

  /* ----------------------------------------------------------- out_of_band (3) */
  {
    table: "meta.users",
    reason: "out_of_band",
    owner: "kernel",
    note: "Read by apps/operate-server/src/recipient-resolver.ts (joined to the membership table to resolve an audience) and never written here: the platform has no user-provisioning surface, since SSO and SCIM are contracts-only. Seventy-three catalogued tables carry a RESTRICT foreign key into it, nine of them from tables with live writers and NOT NULL — see the test's cross-check.",
  },
  {
    table: "meta.user_tenant_membership",
    reason: "out_of_band",
    owner: "kernel",
    note: "The other half of the same read: recipient-resolver.ts selects `m.primary_role`/`m.secondary_roles` from it to resolve `role_in_tenant` and `tenant_all_users` audiences. Memberships are seeded with the users, by the same out-of-band provisioning.",
  },
  {
    table: "meta.api_keys",
    reason: "out_of_band",
    owner: "api-gateway",
    note: "Credentials come from argv: `--api-key key:role:tenant[:principal]`, parsed by `parseApiKeySpec` (ADR-0331). Persisting them is not a wiring step — ADR-0331 refused to derive a principal id from a credential at all, because a principal id lands in meta.audit_log and hashing the secret into it would turn an audit reader into an offline brute-forcer.",
  },

  /* ---------------------------------------------------------- dynamic_writer (1) */
  {
    table: "meta.operate_entity_records",
    reason: "dynamic_writer",
    owner: "operate-runtime",
    writtenVia: "packages/operate-runtime-pg/src/entity-ops.ts",
    note: "The JSONB document table, and the most-written table in the product: `createOp`/`updateOp`/`removeOp` issue `INSERT INTO ${table}` / `UPDATE ${table}` / `DELETE FROM ${table}` against a table handed in, so the target is a declared PG_SCAN_GAPS entry rather than a resolvable name. Reading `no statement names it` as `nothing writes it` would be false of every served entity write.",
  },

  /* -------------------------------------------------------------- superseded (8) */
  {
    table: "meta.manifests",
    reason: "superseded",
    owner: "kernel",
    supersededBy: ["meta.operate_tenant_manifests"],
    note: "ADR-0314's per-tenant activation store is what operate-server reads and the activation poller writes; it carries the manifest hash the tenant's own schema is memoised on, which this Phase-1 shape has no column for.",
  },
  {
    table: "meta.ai_conversations",
    reason: "superseded",
    owner: "ai-architect",
    supersededBy: ["meta.architect_sessions", "meta.architect_messages"],
    note: "ai-architect-pg's `PostgresTranscript` splits a design conversation into a session plus per-message rows plus tool invocations and proposals, because the approval decision has to be auditable per message; this table's single `working_manifest` column cannot hold that.",
  },
  {
    table: "meta.idempotency_records",
    reason: "superseded",
    owner: "api-gateway",
    supersededBy: ["meta.gateway_idempotency_records"],
    note: "packages/api-gateway-pg/src/idempotency-store.ts binds `TABLE = \"gateway_idempotency_records\"`, whose key is `(tenant_id, operation_id, idempotency_key)`; this table keys on `(tenant_id, method, path)`, which cannot distinguish two operations on one path.",
  },
  {
    table: "meta.failover_records",
    reason: "superseded",
    owner: "dr",
    supersededBy: ["meta.dr_failover_executions"],
    note: "dr-runtime-pg's failover store writes the executor's record, with the status column `FAILOVER_TRANSITIONS` is walked against (ADR-0333); this table has timestamps and no status at all, so a transition map could not be enforced against it.",
  },
  {
    table: "meta.dr_drills",
    reason: "superseded",
    owner: "dr",
    supersededBy: ["meta.dr_drill_executions"],
    note: "The same pairing: dr-runtime-pg writes the drill executor's record and `assessDrReadiness` counts drills from it (ADR-0333 scoped that read), while this table holds a `findings` blob with no outcome column.",
  },
  {
    table: "meta.subscriptions",
    reason: "superseded",
    owner: "billing",
    supersededBy: ["meta.billing_subscriptions"],
    note: "billing-runtime-pg and the Stripe webhook ingest write meta.billing_subscriptions; the shared-table erasure names *that* one in DELIBERATELY_ERASED_BILLING_TABLES, with the note that retaining it would leave a deleted tenant entitled — so the live table is unambiguous.",
  },
  {
    table: "meta.events",
    reason: "superseded",
    owner: "kernel",
    supersededBy: ["meta.job_runs", "meta.workflow_events"],
    note: "There is deliberately no generic event store: `PostgresEntityEventSink` turns a served write into `pending` meta.job_runs rows through `enqueueJobsForEvent`, and a workflow event lands in the append-only instance log. An event logged to a third table nothing drains would be a record with no consumer.",
  },
  {
    table: "meta.extension_packs",
    reason: "superseded",
    owner: "marketplace",
    supersededBy: ["meta.pack_versions"],
    note: "marketplace-runtime-pg's version store is the registry, keyed `(pack_id, version)` and carrying the Ed25519 signature and security-review state a publish turns on; nothing references this pack-level table, so the per-version row is the whole record.",
  },

  /* ------------------------------------------------------- unwritten_table (29) */
  {
    table: "meta.access_review_evidence",
    reason: "unwritten_table",
    owner: "access-reviews",
    consequence:
      "apps/operate-server/src/certification.ts READS this table (`latestSealed(framework)`) and nothing writes it, so the access-review evidence adapter answers null on every call and the certification engine scores that as `no evidence` rather than `this check is not wired` — a framework assessment that is silently missing one of its four real signals.",
    note: "access-reviews-runtime-pg writes campaigns, items and decisions and stops there. This is the sharpest member of the class: a live reader over a table with no writer.",
  },
  {
    table: "meta.notification_preferences",
    reason: "unwritten_table",
    owner: "notifications",
    consequence:
      "apps/operate-server/src/recipient-resolver.ts READS it (`preferencesFor`) to build each recipient's `UserPreferenceMatrix`, and nothing writes it — so every user's preferences are the built-in defaults for ever, and a tenant that turns a category off in the UI has nowhere for that to land. ADR-0331 gave read state three HTTP routes; preferences never got theirs.",
    note: "operate-server writes dispatches, deliveries, digests, suppressions, templates, read states and watermarks. Preferences is the one table in the notification stack with a reader and no writer.",
  },
  {
    table: "meta.notification_user_quiet_hours",
    reason: "unwritten_table",
    owner: "notifications",
    consequence:
      "ADR-0309 modelled per-user quiet hours and the planner `fails open to no policy`, so with no writer and no reader every user is permanently outside quiet hours — the fail-open direction, and silent.",
    note: "Modelled in packages/notifications/src/quiet-hours.ts and referenced by nothing but the catalog. ADR-0330 wrote the two read-state tables from the same ADR and left this one.",
  },
  {
    table: "meta.access_review_templates",
    reason: "unwritten_table",
    owner: "access-reviews",
    consequence:
      "meta.access_review_campaigns.template_id is a nullable foreign key into it, so a persisted campaign can never name the template that generated it, and the recurrence declared on a template has nothing to schedule from.",
    note: "Beside a live store (campaigns/items/decisions) and in PLATFORM_RECORD_TABLES, so the Article 17 erasure protects a table nothing writes.",
  },
  {
    table: "meta.access_review_exceptions",
    reason: "unwritten_table",
    owner: "access-reviews",
    consequence:
      "A time-boxed exception with a per-reason duration cap cannot be recorded, so the only expressible outcome of a review item is an attestation or a revocation.",
    note: "The same live store writes its three siblings; also in PLATFORM_RECORD_TABLES.",
  },
  {
    table: "meta.feature_flag_targeting_rules",
    reason: "unwritten_table",
    owner: "feature-flags",
    consequence:
      "`FlagDefinition.targetingRuleIds` is persisted by PostgresFeatureFlagStore as a `ftr_…` id list and the rules those ids name are stored nowhere, so a flag read back from the database cannot be evaluated against its own targeting — the ten rule kinds and the sticky FNV-1a bucketing work only on rules held in memory.",
    note: "feature-flags-pg writes meta.feature_flags (ADR-0300) and meta.feature_flag_kill_switches. This table is the one its rows point at.",
  },
  {
    table: "meta.feature_flag_evaluations",
    reason: "unwritten_table",
    owner: "feature-flags",
    consequence:
      "None of the seventeen evaluation reasons is ever recorded, so there is no way to answer `which variant did this tenant get, and why` after the fact.",
    note: "Named in feature-flags-pg/src/records.ts as the precedent for a TEXT `flag_id` with a `^ff_…$` check — cited and never written.",
  },
  {
    table: "meta.feature_flag_changes",
    reason: "unwritten_table",
    owner: "feature-flags",
    consequence:
      "The 23-kind append-only change audit has no rows, so a flag's history — including who armed a kill switch — is not reconstructible from the database.",
    note: "The flag store rewrites a flag row in place with no change row beside it.",
  },
  {
    table: "meta.crypto_audit",
    reason: "unwritten_table",
    owner: "crypto",
    consequence:
      "`auditKeyManagement` is a pure function whose findings are never persisted, so a key rotation or revocation leaves a row in meta.crypto_keys and no record of the act.",
    note: "crypto-pg writes meta.crypto_keys. The grant reasoning in kernel-pg/src/connection.ts and crypto-pg/src/tenant-context.ts turns on this table (`record` and not `key`), which is why it reads as present.",
  },
  {
    table: "meta.rate_limit_policies",
    reason: "unwritten_table",
    owner: "rate-limiting",
    consequence:
      "meta.rate_limit_decisions.policy_id is a RESTRICT foreign key into it, and api-gateway-pg's checker hardcodes that column to NULL for exactly this reason — so every persisted rate-limit decision is unable to name the policy it applied.",
    note: "A live store (meta.rate_limit_decisions) writes a row that points here, which is what makes this a skipped table rather than an unbuilt subsystem.",
  },
  {
    table: "meta.quota_definitions",
    reason: "unwritten_table",
    owner: "rate-limiting",
    consequence:
      "The same shape one column over: `quota_definition_id` is also a RESTRICT foreign key hardcoded to NULL, so a quota denial does not record which quota was exceeded. Entitlement limits are enforced from the plan catalog instead, which has no `rld_` audit trail.",
    note: "Sits on `app.platform_config_write` because a hard limit decides what the deployment permits (ADR-0332) — a write arm with no caller.",
  },
  {
    table: "meta.quota_usage",
    reason: "unwritten_table",
    owner: "rate-limiting",
    consequence:
      "Per-period quota consumption is counted nowhere, so an overage handling other than `hard_deny` has no counter to act on.",
    note: "In DELIBERATELY_ERASED_BILLING_TABLES as `operational metering`, so the erasure names a table nothing writes.",
  },
  {
    table: "meta.rate_limit_exceptions",
    reason: "unwritten_table",
    owner: "rate-limiting",
    consequence:
      "A duration-capped exemption cannot be granted, so the only way to lift a limit is to change configuration and restart.",
    note: "Its `policy_id` is a NOT NULL RESTRICT reference into the unwritten policy table, so this one could not be written before that one is.",
  },
  {
    table: "meta.throttle_events",
    reason: "unwritten_table",
    owner: "rate-limiting",
    consequence:
      "A soft throttle is applied and not recorded, so the `throttled_soft_delayed` outcome is observable only in the decision row the gateway happens to write.",
    note: "The gateway writes meta.rate_limit_decisions on the same request path.",
  },
  {
    table: "meta.forensic_evidence",
    reason: "unwritten_table",
    owner: "forensics",
    consequence:
      "Evidence cannot be sealed, retained or destroyed through the platform, so the sealed/retention/destruction lifecycle exists only as a state machine over values in memory.",
    note: "forensics-pg writes the hash chain and its checkpoints — the one half of the package that is live.",
  },
  {
    table: "meta.chain_of_custody",
    reason: "unwritten_table",
    owner: "forensics",
    consequence:
      "A sha256-verified transfer of custody cannot be recorded, which is the part of the chain a court-admissible attestation rests on.",
    note: "Beside the live chain store.",
  },
  {
    table: "meta.legal_holds",
    reason: "unwritten_table",
    owner: "forensics",
    consequence:
      "A legal hold cannot be issued or released, so nothing stops a GDPR Article 17 deletion from erasing data under hold — the separation-of-duties rule on release has no row to enforce it against.",
    note: "Beside the live chain store. Its separation-of-duties rule (`releasedBy !== issuedBy`) is one of the four-eyes invariants CLAUDE.md lists as enforced by superRefine, and it has never been enforced against a row.",
  },
  {
    table: "meta.ediscovery_requests",
    reason: "unwritten_table",
    owner: "forensics",
    consequence: "An e-discovery request has no handle, so its scope and fulfilment are untracked.",
    note: "Beside the live chain store.",
  },
  {
    table: "meta.tenant_lifecycle_events",
    reason: "unwritten_table",
    owner: "tenant-lifecycle",
    consequence:
      "The seven-state transition log is empty, so — in PLATFORM_RECORD_TABLES' own words — `without it nothing in the database distinguishes a tenant that was deleted from one that never existed`. The deletion pipeline writes the tombstone and the audit row and not this.",
    note: "tenant-lifecycle-pg writes meta.tenant_tombstones and meta.gdpr_deletion_requests, both of which were this same class until ADR-0318 and ADR-0321.",
  },
  {
    table: "meta.tenant_data_exports",
    reason: "unwritten_table",
    owner: "tenant-lifecycle",
    consequence:
      "A TTL-bounded data export cannot be issued, so Article 15 portability has no implementation and the erasure's reasoning about erasing exports covers nothing.",
    note: "Named in shared-table-erasure.ts as erased rather than retained, which is the right decision about a table with no rows.",
  },
  {
    table: "meta.tenant_credits",
    reason: "unwritten_table",
    owner: "billing",
    consequence:
      "A credit note cannot be stored, which matters because STATUTORY_RETENTION_TABLES retains it under `tax_records_7y` precisely so that retaining meta.invoices does not leave a record overstating the tax charged — the correction it exists to preserve is never written.",
    note: "billing-runtime-pg writes meta.invoices, meta.billing_usage_records and meta.billing_subscriptions. shared-table-erasure.ts already names the hazard this table will create once it has rows: `issued_by` is a RESTRICT reference into meta.users, which carries no tenant_id, so a retained credit note would make its issuer undeletable — ADR-0318 exactly, and `retained_table_blocks_erasure` cannot see it.",
  },
  {
    table: "meta.billing_events",
    reason: "unwritten_table",
    owner: "billing",
    consequence: "The billing engine's operational log is empty, so a rating or close is not replayable.",
    note: "In DELIBERATELY_ERASED_BILLING_TABLES with a stated Art 5(1)(c) reason, beside a live billing store.",
  },
  {
    table: "meta.tenant_storage_usage",
    reason: "unwritten_table",
    owner: "billing",
    consequence:
      "`tenant_storage_usage` is one of the five USAGE_SOURCES the metering engine rates, and nothing measures it — so storage is billed at zero on every deployment.",
    note: "billing-runtime-pg writes meta.billing_usage_records for the sources that are measured.",
  },
  {
    table: "meta.ai_provider_calls",
    reason: "unwritten_table",
    owner: "ai-providers",
    consequence:
      "Another of the five USAGE_SOURCES: per-call provider cost is tracked in meta.architect_tenant_cost as a monthly total and never per call, so a cost anomaly cannot be attributed to a request.",
    note: "ai-architect-runtime-pg writes the monthly ledger and the estimator's inflation mark (ADR-0330).",
  },
  {
    table: "meta.tenant_ai_settings",
    reason: "unwritten_table",
    owner: "ai-architect",
    consequence:
      "Per-tenant AI policy — provider preference, residency filter, budget — is configuration-wide only, so two tenants on one deployment cannot have different AI settings.",
    note: "Beside the live architect stores.",
  },
  {
    table: "meta.job_costs",
    reason: "unwritten_table",
    owner: "jobs",
    consequence:
      "The third unmeasured USAGE_SOURCE: a job run's cost ledger is declared per run and never written, so background compute is billed at zero.",
    note: "workflow-runtime-pg writes meta.job_runs and, since this increment's Lane D, meta.dead_letter_jobs.",
  },
  {
    table: "meta.pack_reviews",
    reason: "unwritten_table",
    owner: "marketplace",
    consequence:
      "A per-tenant review of an installed pack cannot be stored, so the listing's rating has no source.",
    note: "marketplace-runtime-pg writes meta.pack_versions and meta.pack_installations.",
  },
  {
    table: "meta.backup_records",
    reason: "unwritten_table",
    owner: "dr",
    consequence:
      "No backup is recorded, so `assessDrReadiness` scores replication lag and drill recency with nothing to say about whether a restorable backup exists.",
    note: "dr-runtime-pg writes failovers, drills and readiness snapshots.",
  },
  {
    table: "meta.compliance_attestations",
    reason: "unwritten_table",
    owner: "compliance",
    consequence:
      "A signed framework attestation by a named attester cannot be stored, and certification-runtime's sealed report commits to attestations it can never resolve. PLATFORM_RECORD_TABLES retains this table across a tenant deletion for exactly that reason, so that protection is vacuous today.",
    note: "certification-runtime-pg writes meta.certification_reports, which is the record that depends on this one.",
  },

  /* ----------------------------------------------------- unbuilt_subsystem (40) */
  {
    table: "meta.sso_providers",
    reason: "unbuilt_subsystem",
    owner: "sso",
    consequence:
      "Federated login does not exist: no SAML or OIDC provider can be configured, which is why meta.users has no writer either. Four catalogued tables carry a RESTRICT foreign key into this one.",
    note: "`sso` is contracts-only — there is no sso-runtime and no sso-pg.",
  },
  {
    table: "meta.sso_logins",
    reason: "unbuilt_subsystem",
    owner: "sso",
    consequence: "The login audit has no rows, so a federated sign-in is unrecorded.",
    note: "Contracts-only package; `provider_id` references the unwritten provider table.",
  },
  {
    table: "meta.sso_sessions",
    reason: "unbuilt_subsystem",
    owner: "sso",
    consequence: "Session lifecycle is modelled and not stored, so nothing can be revoked centrally.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.scim_clients",
    reason: "unbuilt_subsystem",
    owner: "sso",
    consequence:
      "SCIM 2.0 provisioning has no client registry, so the JIT user policy and claim transforms have no caller — this is the mechanism that would populate meta.users.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.scim_provisioning",
    reason: "unbuilt_subsystem",
    owner: "sso",
    consequence: "A provisioning run leaves no record.",
    note: "Contracts-only package; references both unwritten SSO tables.",
  },
  {
    table: "meta.ml_consent",
    reason: "unbuilt_subsystem",
    owner: "ml-training",
    consequence:
      "Opt-in training consent cannot be recorded, so the FORBIDDEN_TRAINING_DATA_CLASSES rule is enforced only against values in memory and no deployment can prove a tenant consented.",
    note: "`ml-training` is contracts-only.",
  },
  {
    table: "meta.ml_datasets",
    reason: "unbuilt_subsystem",
    owner: "ml-training",
    consequence: "A frozen, content-addressed dataset has nowhere to live.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.ml_evalsets",
    reason: "unbuilt_subsystem",
    owner: "ml-training",
    consequence:
      "The eval sets whose safety-refusal must pass 100% cannot be stored, so that gate has no persisted definition.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.ml_training_runs",
    reason: "unbuilt_subsystem",
    owner: "ml-training",
    consequence: "No training run is recorded.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.ml_evaluations",
    reason: "unbuilt_subsystem",
    owner: "ml-training",
    consequence: "No evaluation result is recorded.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.ml_models",
    reason: "unbuilt_subsystem",
    owner: "ml-training",
    consequence:
      "The shadow → canary → production registry has no rows, so a model promotion is not auditable.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.lineage_nodes",
    reason: "unbuilt_subsystem",
    owner: "data-lineage",
    consequence:
      "The GDPR Article 15 provenance graph is not stored, so a subject access request cannot be answered from the database — the fourteen node kinds and the pii→public anonymisation rule apply only to a graph built in memory.",
    note: "`data-lineage` is contracts-only; two tables reference this one.",
  },
  {
    table: "meta.lineage_edges",
    reason: "unbuilt_subsystem",
    owner: "data-lineage",
    consequence: "The ten edge kinds, including `anonymized_from`, have nowhere to be recorded.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.provenance_records",
    reason: "unbuilt_subsystem",
    owner: "data-lineage",
    consequence: "Where a field's value came from is not recorded.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.data_subjects",
    reason: "unbuilt_subsystem",
    owner: "data-lineage",
    consequence:
      "The sha256-only subject registry has no rows, which is why ADR-0327's `subjectIdentifier` is `recorded and not acted on` — a single data subject inside a multi-user tenant cannot be located, let alone erased.",
    note: "Contracts-only package; two tables reference this one.",
  },
  {
    table: "meta.subject_node_occurrences",
    reason: "unbuilt_subsystem",
    owner: "data-lineage",
    consequence: "Which nodes hold a subject's data is not recorded.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.subject_access_requests",
    reason: "unbuilt_subsystem",
    owner: "data-lineage",
    consequence:
      "An Article 15 request has no handle, in contrast to the Article 17 request, which got one in ADR-0321.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.aa_topology",
    reason: "unbuilt_subsystem",
    owner: "active-active",
    consequence:
      "Multi-region active-active is design-only: the topology a consistency level is resolved against is never stored. ADR-0077 Q6 gates this on demand, so the gap is deliberate.",
    note: "`active-active` is contracts-only; CLAUDE.md records P6 as `deliberately thin`.",
  },
  {
    table: "meta.aa_conflicts",
    reason: "unbuilt_subsystem",
    owner: "active-active",
    consequence: "A detected CRDT conflict and its resolution are not recorded.",
    note: "Contracts-only package; same deliberate gap.",
  },
  {
    table: "meta.aa_split_brain_events",
    reason: "unbuilt_subsystem",
    owner: "active-active",
    consequence: "A split-brain episode and its healing leave no row.",
    note: "Contracts-only package; same deliberate gap.",
  },
  {
    table: "meta.cost_attribution",
    reason: "unbuilt_subsystem",
    owner: "finops",
    consequence:
      "Per-tenant cost attribution across the seventeen categories is computed and never stored, so unit economics cannot be trended.",
    note: "`finops` is contracts-only — no finops-runtime, no finops-pg.",
  },
  {
    table: "meta.cost_budgets",
    reason: "unbuilt_subsystem",
    owner: "finops",
    consequence: "A budget with a breach action cannot be declared, so nothing can breach.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.budget_breaches",
    reason: "unbuilt_subsystem",
    owner: "finops",
    consequence: "And so no breach is recorded.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.tenant_unit_economics",
    reason: "unbuilt_subsystem",
    owner: "finops",
    consequence: "LTV/CAC and contribution margin are not persisted per tenant.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.chargeback_statements",
    reason: "unbuilt_subsystem",
    owner: "finops",
    consequence: "A chargeback statement cannot be issued.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.import_sources",
    reason: "unbuilt_subsystem",
    owner: "migration",
    consequence:
      "Data onboarding is contract-only: none of the twelve source kinds can be registered, so the inferred schema and its field mappings are never stored and a migration cannot be resumed.",
    note: "`migration` is contracts-only.",
  },
  {
    table: "meta.backfill_jobs",
    reason: "unbuilt_subsystem",
    owner: "migration",
    consequence: "A backfill has no durable job record.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.backfill_ledger",
    reason: "unbuilt_subsystem",
    owner: "migration",
    consequence:
      "The idempotent backfill ledger is empty, so re-running an import cannot be made idempotent — which is the one guarantee the ledger exists for.",
    note: "Contracts-only package; named in DELIBERATELY_ERASED_BILLING_TABLES as `migration bookkeeping`.",
  },
  {
    table: "meta.onboarding_runs",
    reason: "unbuilt_subsystem",
    owner: "migration",
    consequence: "The staged onboarding flow has no progress record.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.report_runs",
    reason: "unbuilt_subsystem",
    owner: "reporting",
    consequence:
      "The seven report kinds are rendered on request and never recorded, so `report_runs` as a quota target counts nothing.",
    note: "`reporting` is contracts-only; operate-web's reports are computed by operate-runtime on the fly.",
  },
  {
    table: "meta.scheduled_exports",
    reason: "unbuilt_subsystem",
    owner: "reporting",
    consequence:
      "A scheduled export cannot be declared, so the `scheduled_exports` quota in the plan catalog limits a feature that does not exist.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.cdc_checkpoints",
    reason: "unbuilt_subsystem",
    owner: "reporting",
    consequence:
      "There is no CDC pipeline, so the ClickHouse audit sink and the pipeline-health contracts have no producer.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.webhook_endpoints",
    reason: "unbuilt_subsystem",
    owner: "sdk",
    consequence:
      "Outbound webhooks cannot be subscribed: the HMAC-SHA256 delivery signing and the event catalog have no endpoint to deliver to. The *inbound* direction is live (workflow-signal-bridge, the bounce webhook).",
    note: "`sdk` is contracts-only.",
  },
  {
    table: "meta.webhook_deliveries",
    reason: "unbuilt_subsystem",
    owner: "sdk",
    consequence:
      "And so no delivery attempt is recorded, which makes `webhook_deliveries` a quota target over nothing.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.sdk_client_releases",
    reason: "unbuilt_subsystem",
    owner: "sdk-clients",
    consequence:
      "Client generation is a contract: no release, security advisory or compatibility matrix is stored, so the ten target languages are declared and unreleased.",
    note: "`sdk-clients` is contracts-only.",
  },
  {
    table: "meta.sdk_client_installations",
    reason: "unbuilt_subsystem",
    owner: "sdk-clients",
    consequence: "Client telemetry with W3C trace context has nowhere to land.",
    note: "Contracts-only package.",
  },
  {
    table: "meta.files",
    reason: "unbuilt_subsystem",
    owner: "files",
    consequence:
      "File handling does not exist: nothing can be uploaded, scanned, quarantined or signed for, so the manifest's file-type declarations validate against a subsystem with no storage. OCR and embedding status are likewise unreachable.",
    note: "`files` is contracts-only, and the kernel's manifest validation imports its declaration schema — so the contract is load-bearing while the table is not.",
  },
  {
    table: "meta.integration_calls",
    reason: "unbuilt_subsystem",
    owner: "integrations",
    consequence:
      "No outbound or inbound integration call is audited, and `integration_calls` is the fourth unmeasured USAGE_SOURCE, so integration volume is billed at zero.",
    note: "`integrations` is contracts-only (`thin`, in CLAUDE.md's terms).",
  },
  {
    table: "meta.deployments",
    reason: "unbuilt_subsystem",
    owner: "deploy",
    consequence:
      "A release is not recorded, so meta.feature_flags.related_deployment_id (a TEXT column, not a foreign key) can never be resolved to anything and a flag cannot be tied to the deploy that introduced it.",
    note: "`deploy` is contracts-only; the compose stack and Helm/Terraform packaging are files, not rows.",
  },
  {
    table: "meta.autoscaling_events",
    reason: "unbuilt_subsystem",
    owner: "edge",
    consequence:
      "An autoscaling decision leaves no record, so the per-route latency budgets have no feedback loop.",
    note: "`edge` is contracts-only.",
  },
]);
