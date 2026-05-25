import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });

export const INCIDENT_ROLES = [
  "incident_commander",
  "scribe",
  "comms_lead",
  "technical_lead",
  "subject_matter_expert",
  "executive_sponsor",
  "customer_liaison",
] as const;
export type IncidentRole = (typeof INCIDENT_ROLES)[number];
export const IncidentRoleSchema = z.enum(INCIDENT_ROLES);

export const REQUIRED_ROLES: ReadonlyArray<IncidentRole> = Object.freeze([
  "incident_commander",
  "scribe",
  "comms_lead",
]);

export const SEV1_REQUIRED_ROLES: ReadonlyArray<IncidentRole> = Object.freeze([
  "incident_commander",
  "scribe",
  "comms_lead",
  "technical_lead",
  "executive_sponsor",
]);

export const RoleAssignmentSchema = z
  .object({
    role: IncidentRoleSchema,
    userId: z.string().min(1),
    assignedAt: Iso8601,
    handedOffAt: Iso8601.nullable().default(null),
    handedOffToUserId: z.string().min(1).nullable().default(null),
    handedOffReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.handedOffAt !== null) {
      if (v.handedOffToUserId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["handedOffToUserId"],
          message: "handedOffAt requires handedOffToUserId",
        });
      }
      if (v.handedOffReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["handedOffReason"],
          message: "handedOffAt requires handedOffReason",
        });
      }
      if (v.handedOffToUserId !== null && v.handedOffToUserId === v.userId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["handedOffToUserId"],
          message: "cannot hand off to yourself",
        });
      }
      const assignedMs = new Date(v.assignedAt).getTime();
      const handoffMs = new Date(v.handedOffAt).getTime();
      if (handoffMs <= assignedMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["handedOffAt"],
          message: "handedOffAt must be after assignedAt",
        });
      }
    }
  });
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

export const RoleAssignmentSetSchema = z.array(RoleAssignmentSchema).superRefine((entries, ctx) => {
  const activePerRole = new Map<IncidentRole, number>();
  entries.forEach((e, i) => {
    if (e.handedOffAt === null) {
      const count = (activePerRole.get(e.role) ?? 0) + 1;
      activePerRole.set(e.role, count);
      if (count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "role"],
          message: `role '${e.role}' has more than one active assignment`,
        });
      }
    }
  });
});
export type RoleAssignmentSet = z.infer<typeof RoleAssignmentSetSchema>;

export function activeAssignmentFor(
  assignments: readonly RoleAssignment[],
  role: IncidentRole,
): RoleAssignment | null {
  return assignments.find((a) => a.role === role && a.handedOffAt === null) ?? null;
}

export function rolesMissingRequired(
  assignments: readonly RoleAssignment[],
  required: ReadonlyArray<IncidentRole>,
): readonly IncidentRole[] {
  const active = new Set<IncidentRole>();
  for (const a of assignments) {
    if (a.handedOffAt === null) active.add(a.role);
  }
  return required.filter((r) => !active.has(r));
}

export function handoffChainFor(
  assignments: readonly RoleAssignment[],
  role: IncidentRole,
): readonly RoleAssignment[] {
  return [...assignments]
    .filter((a) => a.role === role)
    .sort((a, b) => new Date(a.assignedAt).getTime() - new Date(b.assignedAt).getTime());
}
