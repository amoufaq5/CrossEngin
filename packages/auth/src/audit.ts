import type { TenantId, UserId } from "@crossengin/types";
import type { PrincipalKind } from "./types.js";

export interface AuditActor {
  readonly kind: PrincipalKind;
  readonly userId: UserId | null;
  readonly sessionId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface AuditESignature {
  readonly method: string;
  readonly challengeId: string;
  readonly signedAt: string;
}

export interface AuditLogEntry {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
  readonly actor: AuditActor;
  readonly operation: string;
  readonly entity: string;
  readonly entityId: string | null;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly diff: Readonly<Record<string, unknown>> | null;
  readonly reason?: string;
  readonly eSignature?: AuditESignature;
  readonly regoDecisionTrace?: string;
}

export interface AuditEmitter {
  emit(entry: AuditLogEntry): Promise<void>;
}
