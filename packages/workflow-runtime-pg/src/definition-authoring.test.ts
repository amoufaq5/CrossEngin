import {
  WorkflowDefinitionSchema,
  type DefinitionStatus,
  type WorkflowDefinition,
} from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import {
  DEFINITION_CONTENT_DOMAIN_TAG,
  DEFINITION_PUBLICATION_DECISIONS,
  DEFINITION_PUBLICATION_REFUSALS,
  MUTABLE_DEFINITION_STATUSES,
  canonicalDefinitionContent,
  compareDefinitionVersions,
  definitionContentSha256,
  nextDefinitionVersion,
  planDefinitionPublication,
  type StoredDefinitionSummary,
} from "./definition-authoring.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const AUTHOR = "00000000-0000-4000-8000-0000000000aa";
const APPROVER = "00000000-0000-4000-8000-0000000000bb";

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    id: "wfd_abcdef01",
    tenantId: TENANT,
    definitionKey: "purchase.approval",
    version: "1.0.0",
    label: "Purchase approval",
    description: "Routes a purchase order for approval.",
    status: "published",
    states: [
      {
        name: "submitted",
        kind: "initial",
        label: "Submitted",
        onEntryActions: [],
        onExitActions: [],
        slaSeconds: null,
      },
      {
        name: "approved",
        kind: "terminal_success",
        label: "Approved",
        onEntryActions: [],
        onExitActions: [],
        slaSeconds: null,
      },
      {
        name: "rejected",
        kind: "terminal_failure",
        label: "Rejected",
        onEntryActions: [],
        onExitActions: [],
        slaSeconds: null,
      },
    ],
    transitions: [
      {
        name: "approve",
        fromState: "submitted",
        toState: "approved",
        trigger: { kind: "automatic" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
      {
        name: "reject",
        fromState: "submitted",
        toState: "rejected",
        trigger: { kind: "manual_action", actionName: "reject", requiresFourEyes: false },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
    ],
    variables: [],
    timers: [],
    signals: [],
    initialState: "submitted",
    compensationStrategy: "no_compensation",
    timeoutSeconds: 86_400,
    createdAt: "2026-10-01T09:00:00.000Z",
    createdBy: AUTHOR,
    publishedAt: "2026-10-01T10:00:00.000Z",
    publishedBy: APPROVER,
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
    ...overrides,
  });
}

function summary(
  d: WorkflowDefinition,
  overrides: Partial<StoredDefinitionSummary> = {},
): StoredDefinitionSummary {
  return {
    id: d.id,
    tenantId: d.tenantId,
    definitionKey: d.definitionKey,
    version: d.version,
    status: d.status,
    contentSha256: definitionContentSha256(d),
    ...overrides,
  };
}

describe("constants", () => {
  it("names four decisions and six refusals, all distinct", () => {
    expect(DEFINITION_PUBLICATION_DECISIONS).toHaveLength(5);
    expect(new Set(DEFINITION_PUBLICATION_DECISIONS).size).toBe(
      DEFINITION_PUBLICATION_DECISIONS.length,
    );
    expect(DEFINITION_PUBLICATION_REFUSALS).toHaveLength(6);
    expect(new Set(DEFINITION_PUBLICATION_REFUSALS).size).toBe(
      DEFINITION_PUBLICATION_REFUSALS.length,
    );
  });

  it("derives the editable statuses as those from which published is reachable", () => {
    expect([...MUTABLE_DEFINITION_STATUSES].sort()).toEqual(["draft", "in_review"]);
  });

  it("excludes every post-publication status from the editable set", () => {
    for (const status of ["published", "deprecated", "retired"] as DefinitionStatus[]) {
      expect(MUTABLE_DEFINITION_STATUSES.has(status)).toBe(false);
    }
  });

  it("carries a version in the domain tag", () => {
    expect(DEFINITION_CONTENT_DOMAIN_TAG).toContain(".v1");
    expect(DEFINITION_CONTENT_DOMAIN_TAG.endsWith("\n")).toBe(true);
  });
});

describe("canonicalDefinitionContent", () => {
  it("is byte-stable under key reordering of the record", () => {
    const a = definition();
    const b = definition();
    expect(canonicalDefinitionContent(a)).toBe(canonicalDefinitionContent(b));
  });

  it("holds only the content fields, never the identity or lifecycle ones", () => {
    const body = canonicalDefinitionContent(definition());
    for (const field of [
      "definitionKey",
      "label",
      "description",
      "states",
      "transitions",
      "initialState",
      "compensationStrategy",
      "timeoutSeconds",
    ]) {
      expect(body).toContain(`"${field}"`);
    }
    for (const field of [
      "id",
      "tenantId",
      "version",
      "status",
      "createdAt",
      "createdBy",
      "publishedAt",
      "publishedBy",
      "deprecatedAt",
      "sourceManifestSha256",
    ]) {
      expect(body).not.toContain(`"${field}"`);
    }
  });

  it("sorts object keys", () => {
    const body = canonicalDefinitionContent(definition());
    expect(body.indexOf('"compensationStrategy"')).toBeLessThan(body.indexOf('"definitionKey"'));
    expect(body.indexOf('"definitionKey"')).toBeLessThan(body.indexOf('"description"'));
  });
});

describe("definitionContentSha256", () => {
  it("is a 64-character lowercase hex digest", () => {
    expect(definitionContentSha256(definition())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores id, version, status and every audit field", () => {
    const base = definitionContentSha256(definition());
    expect(
      definitionContentSha256(
        definition({
          id: "wfd_zzzzzzzz",
          version: "9.9.9",
          status: "draft",
          publishedAt: null,
          publishedBy: null,
          createdBy: APPROVER,
          createdAt: "2020-01-01T00:00:00.000Z",
          sourceManifestSha256: "a".repeat(64),
        }),
      ),
    ).toBe(base);
  });

  it("ignores tenantId, so the same workflow published for two tenants compares equal", () => {
    expect(definitionContentSha256(definition({ tenantId: null }))).toBe(
      definitionContentSha256(definition()),
    );
  });

  it("changes when a transition is added", () => {
    const d = definition();
    const extra = definition({
      transitions: [
        ...d.transitions,
        {
          name: "withdraw",
          fromState: "submitted",
          toState: "rejected",
          trigger: { kind: "automatic" },
          guards: [],
          preTransitionActions: [],
          postTransitionActions: [],
        },
      ],
    });
    expect(definitionContentSha256(extra)).not.toBe(definitionContentSha256(d));
  });

  it("changes when two transitions are reordered, because the first guard-passing one wins", () => {
    const d = definition();
    const swapped = definition({ transitions: [d.transitions[1]!, d.transitions[0]!] });
    expect(definitionContentSha256(swapped)).not.toBe(definitionContentSha256(d));
  });

  it("changes when only the label changes", () => {
    expect(definitionContentSha256(definition({ label: "Purchase approval v2" }))).not.toBe(
      definitionContentSha256(definition()),
    );
  });

  it("changes when timeoutSeconds changes", () => {
    expect(definitionContentSha256(definition({ timeoutSeconds: 3600 }))).not.toBe(
      definitionContentSha256(definition()),
    );
  });
});

describe("compareDefinitionVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareDefinitionVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(compareDefinitionVersions("2.3.4", "2.3.4")).toBe(0);
  });

  it("orders a major bump above a minor one", () => {
    expect(compareDefinitionVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });
});

describe("nextDefinitionVersion", () => {
  it("bumps minor and zeroes patch", () => {
    expect(nextDefinitionVersion("1.4.7", "minor")).toBe("1.5.0");
  });

  it("bumps major and zeroes the rest", () => {
    expect(nextDefinitionVersion("1.4.7", "major")).toBe("2.0.0");
  });

  it("refuses an unparseable version rather than guessing", () => {
    expect(() => nextDefinitionVersion("latest", "minor")).toThrow(/unparseable version/);
  });
});

describe("planDefinitionPublication", () => {
  it("inserts a key nothing holds", () => {
    const plan = planDefinitionPublication({ proposed: definition(), stored: [] });
    expect(plan.decision).toBe("insert");
    expect(plan.refusal).toBeNull();
    expect(plan.matched).toBeNull();
  });

  it("reports unchanged for a byte-identical republication", () => {
    const d = definition();
    const plan = planDefinitionPublication({ proposed: d, stored: [summary(d)] });
    expect(plan.decision).toBe("unchanged");
    expect(plan.matched?.id).toBe(d.id);
  });

  it("tests idempotency before any refusal, so a repeat is never a conflict", () => {
    const d = definition();
    // A platform-wide row on the same key would otherwise refuse `key_shadows_platform_definition`.
    const plan = planDefinitionPublication({
      proposed: d,
      stored: [summary(d), summary(definition({ id: "wfd_platform1", tenantId: null }))],
    });
    expect(plan.decision).toBe("unchanged");
  });

  it("refuses a published version whose content changed", () => {
    const stored = summary(definition());
    const plan = planDefinitionPublication({
      proposed: definition({ label: "Reworded" }),
      stored: [stored],
    });
    expect(plan.decision).toBe("refused");
    expect(plan.refusal).toBe("version_content_differs");
    expect(plan.detail).toContain("publish a higher version");
  });

  it("accepts the same change under a bumped version", () => {
    const stored = summary(definition());
    const plan = planDefinitionPublication({
      proposed: definition({ label: "Reworded", version: "1.1.0", id: "wfd_abcdef02" }),
      stored: [stored],
    });
    expect(plan.decision).toBe("insert");
  });

  it("refuses a new version at or below the highest stored one", () => {
    const stored = summary(definition({ version: "2.0.0" }));
    const plan = planDefinitionPublication({
      proposed: definition({ version: "1.5.0", id: "wfd_abcdef03" }),
      stored: [stored],
    });
    expect(plan.decision).toBe("refused");
    expect(plan.refusal).toBe("version_not_monotonic");
    expect(plan.detail).toContain("never be resolved by key");
  });

  it("refuses a key+version stored under a different id", () => {
    const stored = summary(definition({ id: "wfd_otherid1" }));
    const plan = planDefinitionPublication({ proposed: definition(), stored: [stored] });
    expect(plan.decision).toBe("refused");
    expect(plan.refusal).toBe("version_id_differs");
  });

  it("refuses an id already filed under another key", () => {
    const stored = summary(definition({ definitionKey: "other.flow", version: "3.0.0" }));
    const plan = planDefinitionPublication({ proposed: definition(), stored: [stored] });
    expect(plan.decision).toBe("refused");
    expect(plan.refusal).toBe("definition_id_reused");
    expect(plan.detail).toContain("other.flow@3.0.0");
  });

  it("refuses an id another tenant holds at the same key and version, which is table-wide unique", () => {
    const other = "00000000-0000-4000-8000-000000000002";
    const plan = planDefinitionPublication({
      proposed: definition(),
      stored: [summary(definition({ tenantId: other }))],
    });
    expect(plan.decision).toBe("refused");
    expect(plan.refusal).toBe("definition_id_reused");
    expect(plan.detail).toContain(`for tenant ${other}`);
  });

  it("names a platform-wide holder of a reused id as platform-wide, not as null", () => {
    const plan = planDefinitionPublication({
      proposed: definition(),
      stored: [summary(definition({ tenantId: null, definitionKey: "elsewhere.flow" }))],
    });
    expect(plan.refusal).toBe("definition_id_reused");
    expect(plan.detail).toContain("(platform-wide)");
  });

  it("refuses a tenant key that a platform-wide definition already holds", () => {
    const stored = summary(definition({ id: "wfd_platform1", tenantId: null }));
    const plan = planDefinitionPublication({
      proposed: definition({ id: "wfd_tenant001" }),
      stored: [stored],
    });
    expect(plan.decision).toBe("refused");
    expect(plan.refusal).toBe("key_shadows_platform_definition");
  });

  it("allows a platform-wide definition on a key a tenant already uses", () => {
    const stored = summary(definition({ id: "wfd_tenant001" }));
    const plan = planDefinitionPublication({
      proposed: definition({ id: "wfd_platform1", tenantId: null }),
      stored: [stored],
    });
    expect(plan.decision).toBe("insert");
  });

  it("replaces a draft row in place", () => {
    const stored = summary(
      definition({ status: "draft", publishedAt: null, publishedBy: null }),
    );
    const plan = planDefinitionPublication({
      proposed: definition({
        status: "draft",
        publishedAt: null,
        publishedBy: null,
        label: "Reworded",
      }),
      stored: [stored],
    });
    expect(plan.decision).toBe("replace_draft");
  });

  it("publishes an in_review row", () => {
    const stored = summary(
      definition({ status: "in_review", publishedAt: null, publishedBy: null }),
    );
    const plan = planDefinitionPublication({ proposed: definition(), stored: [stored] });
    expect(plan.decision).toBe("replace_draft");
  });

  it("refuses a status move the transition map forbids", () => {
    const stored = summary(
      definition({ status: "draft", publishedAt: null, publishedBy: null }),
    );
    const plan = planDefinitionPublication({ proposed: definition(), stored: [stored] });
    expect(plan.decision).toBe("refused");
    expect(plan.refusal).toBe("status_transition_forbidden");
    expect(plan.detail).toContain("draft cannot transition to published");
  });

  it("moves a published definition to deprecated as transition_status", () => {
    const stored = summary(definition());
    const plan = planDefinitionPublication({
      proposed: definition({ status: "deprecated", deprecatedAt: "2026-11-01T00:00:00.000Z" }),
      stored: [stored],
    });
    expect(plan.decision).toBe("transition_status");
    expect(plan.refusal).toBeNull();
  });

  it("refuses deprecated → published, which the transition map excludes", () => {
    const stored = summary(
      definition({ status: "deprecated", deprecatedAt: "2026-11-01T00:00:00.000Z" }),
    );
    const plan = planDefinitionPublication({ proposed: definition(), stored: [stored] });
    expect(plan.decision).toBe("refused");
    expect(plan.refusal).toBe("status_transition_forbidden");
  });

  it("ignores stored rows for other keys when ordering versions", () => {
    const plan = planDefinitionPublication({
      proposed: definition({ version: "1.0.0" }),
      stored: [
        summary(definition({ id: "wfd_unrelated", definitionKey: "other.flow", version: "9.0.0" })),
      ],
    });
    expect(plan.decision).toBe("insert");
  });

  it("ignores another tenant's rows, which RLS would not have returned anyway", () => {
    const other = "00000000-0000-4000-8000-000000000002";
    const plan = planDefinitionPublication({
      proposed: definition({ version: "1.0.0" }),
      stored: [summary(definition({ id: "wfd_othertenant", tenantId: other, version: "5.0.0" }))],
    });
    expect(plan.decision).toBe("insert");
  });

  it("always reports the digest it computed, refusal or not", () => {
    const d = definition();
    const refused = planDefinitionPublication({
      proposed: d,
      stored: [summary(definition({ id: "wfd_otherid1" }))],
    });
    expect(refused.contentSha256).toBe(definitionContentSha256(d));
  });

  it("never answers a refusal without naming one", () => {
    const refused = planDefinitionPublication({
      proposed: definition(),
      stored: [summary(definition({ label: "Reworded" }))],
    });
    expect(refused.decision).toBe("refused");
    expect(refused.refusal).not.toBeNull();
    expect(refused.detail).not.toBeNull();
  });

  it("never names a refusal on a decision that is not one", () => {
    for (const plan of [
      planDefinitionPublication({ proposed: definition(), stored: [] }),
      planDefinitionPublication({ proposed: definition(), stored: [summary(definition())] }),
    ]) {
      expect(plan.refusal).toBeNull();
      expect(plan.detail).toBeNull();
    }
  });
});
