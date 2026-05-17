import { z } from "zod";

export const CONFIRMATION_GATES = [
  "destructive_manifest_change",
  "compliance_pack_deactivation",
  "residency_profile_change",
  "bulk_operation",
  "cross_pack_conflicting_permission",
  "external_provider_opt_in",
  "shared_catalog_opt_in",
  "data_migration_sql",
  "low_confidence_apply",
] as const;
export type ConfirmationGate = (typeof CONFIRMATION_GATES)[number];

export const ConfirmationGateSchema = z.enum(CONFIRMATION_GATES);

export interface GateProperties {
  readonly requiresSecondaryAcknowledgement: boolean;
  readonly requiresReason: boolean;
  readonly cooldownDays: number;
  readonly minPrincipalRole: "tenant_admin" | "compliance_officer";
}

export const GATE_PROPERTIES: Readonly<Record<ConfirmationGate, GateProperties>> = Object.freeze({
  destructive_manifest_change: {
    requiresSecondaryAcknowledgement: true,
    requiresReason: false,
    cooldownDays: 0,
    minPrincipalRole: "tenant_admin",
  },
  compliance_pack_deactivation: {
    requiresSecondaryAcknowledgement: true,
    requiresReason: true,
    cooldownDays: 90,
    minPrincipalRole: "tenant_admin",
  },
  residency_profile_change: {
    requiresSecondaryAcknowledgement: true,
    requiresReason: true,
    cooldownDays: 7,
    minPrincipalRole: "tenant_admin",
  },
  bulk_operation: {
    requiresSecondaryAcknowledgement: true,
    requiresReason: false,
    cooldownDays: 0,
    minPrincipalRole: "tenant_admin",
  },
  cross_pack_conflicting_permission: {
    requiresSecondaryAcknowledgement: true,
    requiresReason: true,
    cooldownDays: 0,
    minPrincipalRole: "compliance_officer",
  },
  external_provider_opt_in: {
    requiresSecondaryAcknowledgement: true,
    requiresReason: false,
    cooldownDays: 0,
    minPrincipalRole: "tenant_admin",
  },
  shared_catalog_opt_in: {
    requiresSecondaryAcknowledgement: true,
    requiresReason: false,
    cooldownDays: 0,
    minPrincipalRole: "tenant_admin",
  },
  data_migration_sql: {
    requiresSecondaryAcknowledgement: true,
    requiresReason: true,
    cooldownDays: 0,
    minPrincipalRole: "tenant_admin",
  },
  low_confidence_apply: {
    requiresSecondaryAcknowledgement: true,
    requiresReason: false,
    cooldownDays: 0,
    minPrincipalRole: "tenant_admin",
  },
});

export interface BulkOperationScope {
  readonly deleteRecords?: number;
  readonly updateRecords?: number;
  readonly cancelOrchestrations?: number;
}

export const BULK_OPERATION_THRESHOLDS = Object.freeze({
  deleteRecords: 100,
  updateRecords: 1000,
  cancelOrchestrations: 10,
});

export function requiresBulkConfirmation(scope: BulkOperationScope): boolean {
  if ((scope.deleteRecords ?? 0) > BULK_OPERATION_THRESHOLDS.deleteRecords) return true;
  if ((scope.updateRecords ?? 0) > BULK_OPERATION_THRESHOLDS.updateRecords) return true;
  if ((scope.cancelOrchestrations ?? 0) > BULK_OPERATION_THRESHOLDS.cancelOrchestrations) {
    return true;
  }
  return false;
}

export const ConfirmationRecordSchema = z.object({
  gate: ConfirmationGateSchema,
  tenantId: z.string().min(1),
  confirmedByUserId: z.string().min(1),
  confirmedAt: z.string().datetime({ offset: true }),
  reason: z.string().min(1).optional(),
  acknowledgement: z.string().min(1),
  citationsRead: z.array(z.string().min(1)).default([]),
  ipAddress: z.string().min(1).optional(),
});
export type ConfirmationRecord = z.infer<typeof ConfirmationRecordSchema>;

export function validateConfirmation(
  gate: ConfirmationGate,
  record: ConfirmationRecord,
): void {
  if (record.gate !== gate) {
    throw new Error(`confirmation gate mismatch: expected '${gate}', got '${record.gate}'`);
  }
  const properties = GATE_PROPERTIES[gate];
  if (properties.requiresReason && record.reason === undefined) {
    throw new Error(`gate '${gate}' requires an explicit reason`);
  }
}
