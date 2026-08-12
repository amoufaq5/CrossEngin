import { z } from "zod";
import type { ComplianceFramework } from "@crossengin/access-reviews";
import {
  controlsForFramework,
  frameworkRefsFor,
  EVIDENCE_SOURCE_KINDS,
  type ControlDefinition,
  DEFAULT_CONTROL_CATALOG,
} from "./controls.js";
import type { ControlEvidence } from "./evidence.js";

export const CONTROL_STATUSES = [
  "satisfied",
  "deficient",
  "not_assessed",
] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];

export const ControlAssessmentSchema = z
  .object({
    controlId: z.string().min(1),
    domain: z.string().min(1),
    title: z.string().min(1),
    status: z.enum(CONTROL_STATUSES),
    frameworkRefs: z.array(z.string().min(1)),
    requiredEvidence: z.enum(EVIDENCE_SOURCE_KINDS),
    evidenceCount: z.number().int().nonnegative(),
    findings: z.array(z.string().min(1)),
  })
  .strict();
export type ControlAssessment = z.infer<typeof ControlAssessmentSchema>;

export function assessControl(
  control: ControlDefinition,
  framework: ComplianceFramework,
  evidence: readonly ControlEvidence[],
): ControlAssessment {
  const relevant = evidence.filter(
    (e) =>
      e.controlId === control.id &&
      e.sourceKind === control.requiredEvidence,
  );
  const findings: string[] = [];
  let status: ControlStatus;
  if (relevant.length === 0) {
    status = "not_assessed";
    findings.push(`no ${control.requiredEvidence} evidence supplied`);
  } else if (relevant.some((e) => !e.satisfied)) {
    status = "deficient";
    for (const e of relevant) {
      for (const f of e.findings) findings.push(f);
    }
  } else {
    status = "satisfied";
  }
  return ControlAssessmentSchema.parse({
    controlId: control.id,
    domain: control.domain,
    title: control.title,
    status,
    frameworkRefs: [...frameworkRefsFor(control, framework)],
    requiredEvidence: control.requiredEvidence,
    evidenceCount: relevant.length,
    findings,
  });
}

export const FrameworkAssessmentSchema = z
  .object({
    framework: z.string().min(1),
    controls: z.array(ControlAssessmentSchema),
    counts: z.object({
      total: z.number().int().nonnegative(),
      satisfied: z.number().int().nonnegative(),
      deficient: z.number().int().nonnegative(),
      notAssessed: z.number().int().nonnegative(),
    }),
    certifiable: z.boolean(),
  })
  .strict();
export type FrameworkAssessment = z.infer<typeof FrameworkAssessmentSchema>;

export function assessFramework(
  framework: ComplianceFramework,
  evidence: readonly ControlEvidence[],
  catalog: readonly ControlDefinition[] = DEFAULT_CONTROL_CATALOG,
): FrameworkAssessment {
  const scoped = controlsForFramework(framework, catalog);
  const controls = scoped.map((c) => assessControl(c, framework, evidence));
  const satisfied = controls.filter((c) => c.status === "satisfied").length;
  const deficient = controls.filter((c) => c.status === "deficient").length;
  const notAssessed = controls.filter((c) => c.status === "not_assessed").length;
  return FrameworkAssessmentSchema.parse({
    framework,
    controls,
    counts: {
      total: controls.length,
      satisfied,
      deficient,
      notAssessed,
    },
    certifiable: controls.length > 0 && deficient === 0 && notAssessed === 0,
  });
}
