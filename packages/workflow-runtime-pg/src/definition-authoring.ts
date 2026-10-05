import { sha256 } from "@crossengin/crypto";
import {
  DEFINITION_TRANSITIONS,
  canTransitionDefinition,
  type DefinitionStatus,
  type WorkflowDefinition,
} from "@crossengin/workflow-engine";

/*
 * Pure, in the impure package, deliberately: these are the *store's* rules — what counts as the
 * same definition, which version may land, which status move is legal — and `definition-store.ts`
 * re-asserts every one of them inside a SQL predicate. Across a package boundary the planner and
 * the predicate would resolve through `dist/`, so a changed rule and a stale build would disagree
 * silently, which is the failure CLAUDE.md records from ADR-0329. Nothing in `workflow-runtime`
 * uses them.
 */

/**
 * The domain tag the content digest commits under.
 *
 * Its own tag rather than a bare `sha256(json)`, following `crossengin.tombstone.content.v1`: the
 * digest decides whether a re-publication is the same workflow, so the day a field joins the
 * content set the bytes must move to `.v2` rather than being edited in place — otherwise two
 * definitions that differ in the new field would keep comparing equal under stored digests computed
 * before it existed.
 */
export const DEFINITION_CONTENT_DOMAIN_TAG = "crossengin.workflow.definition.content.v1\n";

/**
 * The fields the digest commits to: everything that decides how a definition *behaves*, plus what
 * it is called.
 *
 * `label` and `description` are in deliberately. They change no execution, but a published
 * definition is an immutable artifact and the text beside it is part of what was published — so a
 * reworded label bumps the version instead of silently replacing a published row's text, which is
 * the only other thing it could do.
 *
 * Everything identity- or lifecycle-shaped is out: `id`, `tenantId`, `version`, `status`, the five
 * audit timestamps and actors, `supersededByDefinitionId`, `sourceManifestSha256`. Those are how a
 * definition is *filed*, and including them would make every digest unique, which is the same as
 * having no digest.
 */
const CONTENT_FIELDS = [
  "definitionKey",
  "label",
  "description",
  "states",
  "transitions",
  "variables",
  "timers",
  "signals",
  "initialState",
  "compensationStrategy",
  "timeoutSeconds",
] as const satisfies readonly (keyof WorkflowDefinition)[];

/**
 * Canonical JSON: object keys sorted, **array order preserved**.
 *
 * The preserved order is the load-bearing half. `chooseTransition` returns the *first* candidate
 * whose guards all pass, so reordering two transitions out of one state changes which one fires —
 * a behaviour change that must bump the version. Sorting the arrays the way a tombstone's scope
 * sorts its table list would make that change invisible, and the digest's whole job is to decide
 * what "unchanged" means.
 */
function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-finite numbers cannot be canonicalized");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      parts.push(JSON.stringify(key) + ":" + canonicalStringify(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

/** The digest body. Pinned byte-for-byte by a fixture test, as every stored comparison uses it. */
export function canonicalDefinitionContent(definition: WorkflowDefinition): string {
  const subset: Record<string, unknown> = {};
  for (const field of CONTENT_FIELDS) {
    subset[field] = definition[field];
  }
  return canonicalStringify(subset);
}

export function definitionContentSha256(definition: WorkflowDefinition): string {
  return sha256(DEFINITION_CONTENT_DOMAIN_TAG + canonicalDefinitionContent(definition));
}

/**
 * Orders `a.b.c` versions numerically.
 *
 * Duplicated from `workflow-runtime`'s module-private helper in `engine.ts` rather than imported,
 * because the engine resolving a child by key and the planner refusing a version below the current
 * maximum have to agree: a definition the engine's "highest published wins" can never reach is one
 * that will never run. Same five lines, one meaning — and the engine's copy is the one to delete
 * when it is next touched.
 */
export function compareDefinitionVersions(left: string, right: string): number {
  const l = left.split(".").map((p) => Number.parseInt(p, 10));
  const r = right.split(".").map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    const a = Number.isFinite(l[i]) ? (l[i] as number) : 0;
    const b = Number.isFinite(r[i]) ? (r[i] as number) : 0;
    if (a !== b) return a - b;
  }
  return 0;
}

/**
 * A stored definition as the planner needs to see it: identity, scope, status and content digest.
 *
 * The whole record is deliberately not here. The planner decides whether a proposal may land, and
 * the only questions it asks of a stored row are "is this the same content", "is it mine", "what
 * status is it in" and "how does its version order" — so a summary is what the store's list query
 * selects, and a planner that cannot read a definition's states cannot accidentally merge two.
 */
export interface StoredDefinitionSummary {
  readonly id: string;
  readonly tenantId: string | null;
  readonly definitionKey: string;
  readonly version: string;
  readonly status: DefinitionStatus;
  readonly contentSha256: string;
}

/**
 * The statuses whose row may still be rewritten in place: those from which `published` is still
 * reachable through `DEFINITION_TRANSITIONS`.
 *
 * Derived rather than listed, and the derivation is the rule itself — *a definition is editable
 * until it has been published*. `draft` and `in_review` reach `published`; `published`,
 * `deprecated` and `retired` do not, so a row in any of them is an artifact that instances and
 * audit records point at and a rewrite would change history. A sixth status added to the contract
 * lands on whichever side its own transitions put it, rather than defaulting into the editable set.
 */
export const MUTABLE_DEFINITION_STATUSES: ReadonlySet<DefinitionStatus> = (() => {
  const reaches = (from: DefinitionStatus): boolean => {
    const seen = new Set<DefinitionStatus>([from]);
    const queue: DefinitionStatus[] = [from];
    while (queue.length > 0) {
      for (const next of DEFINITION_TRANSITIONS[queue.shift() as DefinitionStatus]) {
        if (next === "published") return true;
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return false;
  };
  return new Set(
    (Object.keys(DEFINITION_TRANSITIONS) as DefinitionStatus[]).filter(reaches),
  );
})();

export const DEFINITION_PUBLICATION_DECISIONS = [
  /** No row holds this key at this version: insert it. */
  "insert",
  /** A row that has not been published holds it, and the proposal rewrites that row. */
  "replace_draft",
  /**
   * A published row holds it, the content is byte-identical, and only the status moves — the
   * `published → deprecated → retired` lifecycle. Distinct from `replace_draft` because what a
   * caller may do next differs: a draft rewrite changes the workflow, a status move does not.
   */
  "transition_status",
  /** The stored row already *is* this definition. Nothing is written and nothing is wrong. */
  "unchanged",
  "refused",
] as const;
export type DefinitionPublicationDecision =
  (typeof DEFINITION_PUBLICATION_DECISIONS)[number];

export const DEFINITION_PUBLICATION_REFUSALS = [
  /** The proposal's `wfd_…` id is already filed under a different key or version. */
  "definition_id_reused",
  /** A row holds this key+version under a *different* id, so landing this would fork the id. */
  "version_id_differs",
  /** A row holds this key+version with different content, and that row is no longer a draft. */
  "version_content_differs",
  /**
   * A new version that does not exceed the highest version already stored for the key. The engine
   * resolves a child workflow to the *highest* published version of a key, so such a definition is
   * unreachable by key for the rest of its life.
   */
  "version_not_monotonic",
  /**
   * A tenant-scoped proposal whose key a platform-wide definition already uses. The engine's
   * key→definition resolution scans the whole map, so both would be candidates and a version tie
   * would be broken by whichever the map iteration reached first.
   */
  "key_shadows_platform_definition",
  /**
   * The proposal's status cannot be reached from the stored row's status. A publication is not a
   * free-form overwrite: `DEFINITION_TRANSITIONS` is the only path between statuses.
   */
  "status_transition_forbidden",
] as const;
export type DefinitionPublicationRefusal =
  (typeof DEFINITION_PUBLICATION_REFUSALS)[number];

export interface DefinitionPublicationInput {
  readonly proposed: WorkflowDefinition;
  /**
   * Every stored definition the proposal's reader can see, across all statuses — the tenant's own
   * rows *and* the platform-wide ones, which is exactly what the table's RLS policy exposes to a
   * tenant-scoped read. Rows for other keys are kept rather than filtered by the caller, because
   * `definition_id_reused` is a question about the whole id space and not about one key.
   */
  readonly stored: readonly StoredDefinitionSummary[];
}

export interface DefinitionPublicationPlan {
  readonly decision: DefinitionPublicationDecision;
  readonly refusal: DefinitionPublicationRefusal | null;
  readonly detail: string | null;
  /** The digest the proposal would be filed under, so a caller can store or log it. */
  readonly contentSha256: string;
  /** The stored row this decision is about, when one exists. */
  readonly matched: StoredDefinitionSummary | null;
}

function refuse(
  refusal: DefinitionPublicationRefusal,
  detail: string,
  contentSha256: string,
  matched: StoredDefinitionSummary | null,
): DefinitionPublicationPlan {
  return { decision: "refused", refusal, detail, contentSha256, matched };
}

/**
 * Decides whether a proposed definition may be written, and as what.
 *
 * Every outcome is named. There is no "skip" and no silent success: a definition that cannot be
 * published is a workflow that will never run, and the one thing worse than refusing it is
 * accepting it into a state where nothing says so.
 *
 * The idempotency test comes **first**, before any refusal, so re-publishing the same definition is
 * `unchanged` rather than being reported as a conflict with itself — `planInstanceCancellation`'s
 * ordering, for the same reason: a repeat of a request that already took effect is not an error.
 */
export function planDefinitionPublication(
  input: DefinitionPublicationInput,
): DefinitionPublicationPlan {
  const { proposed } = input;
  const contentSha256 = definitionContentSha256(proposed);
  const scope = input.stored.filter(
    (s) => s.tenantId === proposed.tenantId && s.definitionKey === proposed.definitionKey,
  );
  const atVersion = scope.find((s) => s.version === proposed.version) ?? null;

  if (
    atVersion !== null &&
    atVersion.id === proposed.id &&
    atVersion.contentSha256 === contentSha256 &&
    atVersion.status === proposed.status
  ) {
    return {
      decision: "unchanged",
      refusal: null,
      detail: null,
      contentSha256,
      matched: atVersion,
    };
  }

  // Anything holding this id that is not the row being targeted. The tenant comparison is part of
  // it: `definition_id` is unique **table-wide**, so one tenant's row and another's can collide on
  // id while sharing a key and version — and without the tenant test that case fell past every
  // refusal to `insert`, where the INSERT raised a raw `23505` instead of naming the reason.
  const idElsewhere = input.stored.find(
    (s) =>
      s.id === proposed.id &&
      !(
        s.tenantId === proposed.tenantId &&
        s.definitionKey === proposed.definitionKey &&
        s.version === proposed.version
      ),
  );
  if (idElsewhere !== undefined) {
    return refuse(
      "definition_id_reused",
      `${proposed.id} is already filed as ${idElsewhere.definitionKey}@${idElsewhere.version}` +
        (idElsewhere.tenantId === proposed.tenantId
          ? ""
          : ` for tenant ${idElsewhere.tenantId ?? "(platform-wide)"}`),
      contentSha256,
      idElsewhere,
    );
  }

  if (proposed.tenantId !== null) {
    const platform = input.stored.find(
      (s) => s.tenantId === null && s.definitionKey === proposed.definitionKey,
    );
    if (platform !== undefined) {
      return refuse(
        "key_shadows_platform_definition",
        `key ${proposed.definitionKey} is held platform-wide by ${platform.id}; a tenant-scoped definition on the same key is ambiguous to resolve by key`,
        contentSha256,
        platform,
      );
    }
  }

  if (atVersion !== null) {
    if (atVersion.id !== proposed.id) {
      return refuse(
        "version_id_differs",
        `${proposed.definitionKey}@${proposed.version} is stored as ${atVersion.id}, not ${proposed.id}`,
        contentSha256,
        atVersion,
      );
    }
    const editable = MUTABLE_DEFINITION_STATUSES.has(atVersion.status);
    if (!editable && atVersion.contentSha256 !== contentSha256) {
      return refuse(
        "version_content_differs",
        `${proposed.definitionKey}@${proposed.version} is ${atVersion.status} and its content differs; publish a higher version instead`,
        contentSha256,
        atVersion,
      );
    }
    if (
      atVersion.status !== proposed.status &&
      !canTransitionDefinition(atVersion.status, proposed.status)
    ) {
      return refuse(
        "status_transition_forbidden",
        `${atVersion.status} cannot transition to ${proposed.status}`,
        contentSha256,
        atVersion,
      );
    }
    return {
      decision: editable ? "replace_draft" : "transition_status",
      refusal: null,
      detail: null,
      contentSha256,
      matched: atVersion,
    };
  }

  const highest = [...scope].sort((a, b) =>
    compareDefinitionVersions(b.version, a.version),
  )[0];
  if (
    highest !== undefined &&
    compareDefinitionVersions(proposed.version, highest.version) <= 0
  ) {
    return refuse(
      "version_not_monotonic",
      `${proposed.definitionKey} already holds ${highest.version}; ${proposed.version} would never be resolved by key`,
      contentSha256,
      highest,
    );
  }

  return { decision: "insert", refusal: null, detail: null, contentSha256, matched: null };
}

/**
 * The next version for a changed definition, bumping the component the change warrants.
 *
 * `patch` is absent on purpose. A definition's content set holds nothing cosmetic — a label change
 * is the smallest thing in it and still alters what was published — so offering a patch bump would
 * invite callers to classify a change as "no behaviour difference", which is a judgement the digest
 * already makes and makes better.
 */
export function nextDefinitionVersion(
  current: string,
  bump: "major" | "minor",
): string {
  const [major = 0, minor = 0] = current.split(".").map((p) => Number.parseInt(p, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    throw new Error(`cannot bump unparseable version: ${JSON.stringify(current)}`);
  }
  return bump === "major" ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
}
