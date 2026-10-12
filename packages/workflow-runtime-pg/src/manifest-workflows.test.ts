import { WorkflowSchema, type Workflow } from "@crossengin/kernel/workflow";
import { WorkflowDefinitionSchema } from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import {
  MANIFEST_WORKFLOW_MECHANISM,
  MANIFEST_WORKFLOW_VERDICTS,
  surveyManifestWorkflows,
} from "./manifest-workflows.js";

const LIFECYCLE: Workflow = WorkflowSchema.parse({
  kind: "entityLifecycle",
  entity: "Invoice",
  stateField: "status",
  states: [{ name: "draft" }, { name: "posted", category: "terminal" }],
  initialState: "draft",
  transitions: [{ name: "post", from: "draft", to: "posted" }],
});

const ORCHESTRATION: Workflow = WorkflowSchema.parse({ kind: "orchestration" });
const SCHEDULED: Workflow = WorkflowSchema.parse({ kind: "scheduled", action: {} });

describe("constants", () => {
  it("names four verdicts, all distinct", () => {
    expect(MANIFEST_WORKFLOW_VERDICTS).toHaveLength(4);
    expect(new Set(MANIFEST_WORKFLOW_VERDICTS).size).toBe(4);
  });

  it("maps every manifest workflow kind, with no kind unmapped", () => {
    expect(Object.keys(MANIFEST_WORKFLOW_MECHANISM).sort()).toEqual([
      "entityLifecycle",
      "orchestration",
      "scheduled",
    ]);
  });

  it("routes only entityLifecycle to the lifecycle handlers", () => {
    expect(MANIFEST_WORKFLOW_MECHANISM.entityLifecycle).toBe("lifecycle_handlers");
    expect(MANIFEST_WORKFLOW_MECHANISM.orchestration).toBe("authored_definition");
    expect(MANIFEST_WORKFLOW_MECHANISM.scheduled).toBe("authored_definition");
  });
});

describe("surveyManifestWorkflows", () => {
  it("answers an empty survey for a manifest with no workflows", () => {
    const survey = surveyManifestWorkflows({
      workflows: undefined,
      publishedDefinitionKeys: [],
    });
    expect(survey.findings).toEqual([]);
    expect(survey.unreachable).toEqual([]);
  });

  it("classifies an entity lifecycle as served elsewhere, not as missing", () => {
    const survey = surveyManifestWorkflows({
      workflows: { invoice_lifecycle: LIFECYCLE },
      publishedDefinitionKeys: [],
    });
    expect(survey.findings[0]?.verdict).toBe("served_by_lifecycle_handlers");
    expect(survey.unreachable).toEqual([]);
  });

  it("names the entity and state field a lifecycle workflow drives", () => {
    const survey = surveyManifestWorkflows({
      workflows: { invoice_lifecycle: LIFECYCLE },
      publishedDefinitionKeys: [],
    });
    expect(survey.findings[0]?.detail).toContain("Invoice.status");
    expect(survey.findings[0]?.detail).toContain("operate-runtime");
  });

  it("reports an orchestration workflow with no definition as unreachable", () => {
    const survey = surveyManifestWorkflows({
      workflows: { ap_three_way_match: ORCHESTRATION },
      publishedDefinitionKeys: [],
    });
    expect(survey.findings[0]?.verdict).toBe("definition_missing");
    expect(survey.unreachable).toEqual(["ap_three_way_match"]);
  });

  it("explains why a manifest orchestration cannot simply be compiled", () => {
    const survey = surveyManifestWorkflows({
      workflows: { ap_three_way_match: ORCHESTRATION },
      publishedDefinitionKeys: [],
    });
    expect(survey.findings[0]?.detail).toContain("unknown");
    expect(survey.findings[0]?.detail).toContain("authored");
  });

  it("reports a scheduled workflow the same way", () => {
    const survey = surveyManifestWorkflows({
      workflows: { nightly_revaluation: SCHEDULED },
      publishedDefinitionKeys: [],
    });
    expect(survey.findings[0]?.verdict).toBe("definition_missing");
    expect(survey.findings[0]?.kind).toBe("scheduled");
  });

  it("clears an orchestration workflow once a definition is published for its key", () => {
    const survey = surveyManifestWorkflows({
      workflows: { ap_three_way_match: ORCHESTRATION },
      publishedDefinitionKeys: ["ap_three_way_match"],
    });
    expect(survey.findings[0]?.verdict).toBe("definition_published");
    expect(survey.unreachable).toEqual([]);
  });

  it("matches keys exactly and does not normalise", () => {
    const survey = surveyManifestWorkflows({
      workflows: { ap_three_way_match: ORCHESTRATION },
      publishedDefinitionKeys: ["ap.three.way.match"],
    });
    expect(survey.findings[0]?.verdict).toBe("definition_missing");
  });

  it("reports a manifest key that could never be a definitionKey", () => {
    const survey = surveyManifestWorkflows({
      workflows: { apThreeWayMatch: ORCHESTRATION },
      publishedDefinitionKeys: ["apThreeWayMatch"],
    });
    expect(survey.findings[0]?.verdict).toBe("definition_key_unrepresentable");
    expect(survey.unreachable).toEqual(["apThreeWayMatch"]);
  });

  it("rejects a leading digit and a leading underscore", () => {
    for (const name of ["3way_match", "_internal"]) {
      const survey = surveyManifestWorkflows({
        workflows: { [name]: ORCHESTRATION },
        publishedDefinitionKeys: [name],
      });
      expect(survey.findings[0]?.verdict).toBe("definition_key_unrepresentable");
    }
  });

  it("rejects a key past the contract's length cap", () => {
    const name = "a".repeat(121);
    const survey = surveyManifestWorkflows({
      workflows: { [name]: ORCHESTRATION },
      publishedDefinitionKeys: [name],
    });
    expect(survey.findings[0]?.verdict).toBe("definition_key_unrepresentable");
  });

  it("accepts a key at exactly the cap", () => {
    const name = "a".repeat(120);
    const survey = surveyManifestWorkflows({
      workflows: { [name]: ORCHESTRATION },
      publishedDefinitionKeys: [name],
    });
    expect(survey.findings[0]?.verdict).toBe("definition_published");
  });

  it("does not check the key shape of a lifecycle workflow, which needs no definition", () => {
    const survey = surveyManifestWorkflows({
      workflows: { invoiceLifecycle: LIFECYCLE },
      publishedDefinitionKeys: [],
    });
    expect(survey.findings[0]?.verdict).toBe("served_by_lifecycle_handlers");
  });

  it("keeps declaration order in findings and in the unreachable list", () => {
    const survey = surveyManifestWorkflows({
      workflows: {
        z_orchestration: ORCHESTRATION,
        a_lifecycle: LIFECYCLE,
        m_scheduled: SCHEDULED,
      },
      publishedDefinitionKeys: [],
    });
    expect(survey.findings.map((f) => f.name)).toEqual([
      "z_orchestration",
      "a_lifecycle",
      "m_scheduled",
    ]);
    expect(survey.unreachable).toEqual(["z_orchestration", "m_scheduled"]);
  });

  it("carries the kind on every finding", () => {
    const survey = surveyManifestWorkflows({
      workflows: { a: LIFECYCLE, b: ORCHESTRATION, c: SCHEDULED },
      publishedDefinitionKeys: [],
    });
    expect(survey.findings.map((f) => f.kind)).toEqual([
      "entityLifecycle",
      "orchestration",
      "scheduled",
    ]);
  });

  it("never leaves a finding without a detail", () => {
    const survey = surveyManifestWorkflows({
      workflows: { a: LIFECYCLE, b: ORCHESTRATION, cC: SCHEDULED },
      publishedDefinitionKeys: ["b"],
    });
    for (const finding of survey.findings) {
      expect(finding.detail.length).toBeGreaterThan(0);
    }
  });

  it("accepts every ERP pack workflow key shape, which is snake_case", () => {
    const keys = [
      "invoice_lifecycle",
      "purchase_order_lifecycle",
      "journal_entry_lifecycle",
      "leave_request_lifecycle",
    ];
    const workflows = Object.fromEntries(keys.map((k) => [k, ORCHESTRATION]));
    const survey = surveyManifestWorkflows({
      workflows,
      publishedDefinitionKeys: keys,
    });
    expect(survey.unreachable).toEqual([]);
  });
});

/** The smallest definition the contract accepts, parameterised only by its key. */
function definitionWithKey(definitionKey: string): unknown {
  return {
    id: "wfd_abcdef01",
    tenantId: null,
    definitionKey,
    version: "1.0.0",
    label: "Flow",
    description: "",
    status: "draft",
    states: [
      { name: "start", kind: "initial", label: "Start", slaSeconds: null },
      { name: "done", kind: "terminal_success", label: "Done", slaSeconds: null },
    ],
    transitions: [
      {
        name: "finish",
        fromState: "start",
        toState: "done",
        trigger: { kind: "automatic" },
      },
    ],
    initialState: "start",
    compensationStrategy: "no_compensation",
    timeoutSeconds: 60,
    createdAt: "2026-10-01T09:00:00.000Z",
    createdBy: "00000000-0000-4000-8000-0000000000aa",
    publishedAt: null,
    publishedBy: null,
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
  };
}

describe("the key regex this module restates", () => {
  it("agrees with the contract: a key it accepts parses as a definitionKey", () => {
    const survey = surveyManifestWorkflows({
      workflows: { "ap.three-way_match2": ORCHESTRATION },
      publishedDefinitionKeys: ["ap.three-way_match2"],
    });
    expect(survey.findings[0]?.verdict).toBe("definition_published");
    expect(
      WorkflowDefinitionSchema.safeParse(definitionWithKey("ap.three-way_match2")).success,
    ).toBe(true);
  });

  it("agrees with the contract: a key it rejects does not parse", () => {
    const survey = surveyManifestWorkflows({
      workflows: { apThreeWayMatch: ORCHESTRATION },
      publishedDefinitionKeys: ["apThreeWayMatch"],
    });
    expect(survey.findings[0]?.verdict).toBe("definition_key_unrepresentable");
    expect(WorkflowDefinitionSchema.safeParse(definitionWithKey("apThreeWayMatch")).success).toBe(
      false,
    );
  });

  it("agrees with the contract at the length cap", () => {
    expect(WorkflowDefinitionSchema.safeParse(definitionWithKey("a".repeat(120))).success).toBe(
      true,
    );
    expect(WorkflowDefinitionSchema.safeParse(definitionWithKey("a".repeat(121))).success).toBe(
      false,
    );
  });
});
