import type { Workflow } from "@crossengin/kernel/workflow";

/**
 * `WorkflowDefinition.definitionKey`'s regex, restated rather than imported.
 *
 * The contract spells it inline in a `z.string().regex(...)` with no exported constant, and this
 * module's whole job is to answer whether a manifest's key could ever *be* one — so a copy that can
 * drift is worse than no check, and a test pins the two together by parsing a definition built from
 * a key this accepts.
 */
const DEFINITION_KEY_RE = /^[a-z][a-z0-9_.-]*$/;
const DEFINITION_KEY_MAX = 120;

export const MANIFEST_WORKFLOW_VERDICTS = [
  /**
   * An `entityLifecycle` workflow. **Not** an orchestration definition and not missing one:
   * `operate-runtime` derives lifecycle transition operations, the UI schema's state field and the
   * list query's state column straight from this declaration, and executes it through its own
   * handlers. Compiling it into a `WorkflowDefinition` as well would give one state machine two
   * executors, two audit trails and two writers of the entity's state field.
   */
  "served_by_lifecycle_handlers",
  /** An orchestration or scheduled workflow with a published definition under the same key. */
  "definition_published",
  /**
   * An orchestration or scheduled workflow with no published definition. This workflow will never
   * run. Reported rather than skipped: a skipped workflow is one nothing would say anything about.
   */
  "definition_missing",
  /**
   * The manifest's key cannot be a `definitionKey` at all, so no definition could ever be matched
   * to it. Named rather than normalised — folding `invoiceLifecycle` to `invoice_lifecycle` would
   * let two manifest workflows pair with one definition and nothing would notice.
   */
  "definition_key_unrepresentable",
] as const;
export type ManifestWorkflowVerdict = (typeof MANIFEST_WORKFLOW_VERDICTS)[number];

export interface ManifestWorkflowFinding {
  /** The key the manifest's `workflows` record holds this workflow under. */
  readonly name: string;
  readonly kind: Workflow["kind"];
  readonly verdict: ManifestWorkflowVerdict;
  readonly detail: string;
}

export interface ManifestWorkflowSurvey {
  readonly findings: readonly ManifestWorkflowFinding[];
  /**
   * The names that will never run, in declaration order: `definition_missing` and
   * `definition_key_unrepresentable`. The one list a caller has to act on.
   */
  readonly unreachable: readonly string[];
}

export interface SurveyManifestWorkflowsInput {
  readonly workflows: Readonly<Record<string, Workflow>> | undefined;
  /** The `definitionKey`s of the **published** definitions the engine's map holds. */
  readonly publishedDefinitionKeys: Iterable<string>;
}

/**
 * Classifies a manifest's `workflows` against the definitions that actually exist.
 *
 * This exists because the answer to "where do `WorkflowDefinition` records come from" is *not* the
 * manifest, and that answer has a cost: a manifest may declare an orchestration workflow that
 * nothing will ever execute. Under a compiler the cost would have been a wrong definition; under
 * authoring it is an absent one, and the rule either way is the same — a workflow that will never
 * run is named with the reason, never passed over.
 *
 * Every one of the three manifest workflow kinds is classified, so a fourth kind added to
 * `WorkflowSchema` is a compile error in the switch rather than a declaration that falls through to
 * whichever branch the chain ended on.
 */
export function surveyManifestWorkflows(
  input: SurveyManifestWorkflowsInput,
): ManifestWorkflowSurvey {
  const published = new Set(input.publishedDefinitionKeys);
  const findings: ManifestWorkflowFinding[] = [];
  for (const [name, workflow] of Object.entries(input.workflows ?? {})) {
    findings.push(classify(name, workflow, published));
  }
  return {
    findings,
    unreachable: findings
      .filter(
        (f) =>
          f.verdict === "definition_missing" ||
          f.verdict === "definition_key_unrepresentable",
      )
      .map((f) => f.name),
  };
}

/**
 * Which mechanism serves each manifest workflow kind.
 *
 * A **total** map over the kind union, not an `if`-chain: a fourth member of `WorkflowSchema` is a
 * compile error here rather than a declaration that falls through to whichever branch the chain
 * ended on — ADR-0330's rule for the design-output shapes, which is the same mistake in a different
 * enum.
 */
export const MANIFEST_WORKFLOW_MECHANISM: Readonly<
  Record<Workflow["kind"], "lifecycle_handlers" | "authored_definition">
> = {
  entityLifecycle: "lifecycle_handlers",
  orchestration: "authored_definition",
  scheduled: "authored_definition",
};

function classify(
  name: string,
  workflow: Workflow,
  published: ReadonlySet<string>,
): ManifestWorkflowFinding {
  if (MANIFEST_WORKFLOW_MECHANISM[workflow.kind] === "lifecycle_handlers") {
    if (workflow.kind !== "entityLifecycle") {
      throw new Error(
        `workflow kind ${workflow.kind} is mapped to lifecycle handlers but carries no entity`,
      );
    }
    return {
      name,
      kind: workflow.kind,
      verdict: "served_by_lifecycle_handlers",
      detail: `entity lifecycle for ${workflow.entity}.${workflow.stateField}, executed by operate-runtime's lifecycle handlers`,
    };
  }
  if (!DEFINITION_KEY_RE.test(name) || name.length > DEFINITION_KEY_MAX) {
    return {
      name,
      kind: workflow.kind,
      verdict: "definition_key_unrepresentable",
      detail: `'${name}' is not a legal definitionKey (${DEFINITION_KEY_RE.source}, max ${DEFINITION_KEY_MAX}), so no published definition can ever match it`,
    };
  }
  if (published.has(name)) {
    return {
      name,
      kind: workflow.kind,
      verdict: "definition_published",
      detail: `a published WorkflowDefinition is keyed '${name}'`,
    };
  }
  return {
    name,
    kind: workflow.kind,
    verdict: "definition_missing",
    detail:
      `no published WorkflowDefinition is keyed '${name}'. A manifest ${workflow.kind} workflow ` +
      "carries no compilable content — its trigger, steps and action are `unknown` in " +
      "`WorkflowSchema` — so a definition has to be authored and published before it can run",
  };
}
