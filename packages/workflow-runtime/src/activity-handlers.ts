import type { ActivityKind } from "@crossengin/workflow-engine";

export interface ActivityInvocation {
  readonly activityId: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly definitionId: string;
  readonly definitionActivityKey: string;
  readonly kind: ActivityKind;
  readonly attemptNumber: number;
  readonly input: Record<string, unknown>;
  readonly variables: Readonly<Record<string, unknown>>;
}

export type ActivityOutcome =
  | {
      readonly status: "succeeded";
      readonly output?: Record<string, unknown>;
      readonly outputSha256?: string;
    }
  | {
      readonly status: "failed";
      readonly errorCode: string;
      readonly errorMessage: string;
      readonly retryable: boolean;
    }
  | {
      readonly status: "timed_out";
      readonly errorMessage: string;
    };

export type ActivityHandler = (
  invocation: ActivityInvocation,
) => Promise<ActivityOutcome> | ActivityOutcome;

interface RegistryKey {
  readonly definitionId?: string;
  readonly activityKey?: string;
  readonly kind: ActivityKind;
}

function specificKey(definitionId: string, activityKey: string): string {
  return `def:${definitionId}|key:${activityKey}`;
}

function kindKey(kind: ActivityKind): string {
  return `kind:${kind}`;
}

export class ActivityRegistry {
  private readonly specific: Map<string, ActivityHandler> = new Map();
  private readonly byKind: Map<string, ActivityHandler> = new Map();

  registerForActivity(definitionId: string, activityKey: string, handler: ActivityHandler): this {
    this.specific.set(specificKey(definitionId, activityKey), handler);
    return this;
  }

  registerForKind(kind: ActivityKind, handler: ActivityHandler): this {
    this.byKind.set(kindKey(kind), handler);
    return this;
  }

  resolve(key: RegistryKey): ActivityHandler | null {
    if (key.definitionId !== undefined && key.activityKey !== undefined) {
      const specific = this.specific.get(specificKey(key.definitionId, key.activityKey));
      if (specific !== undefined) return specific;
    }
    return this.byKind.get(kindKey(key.kind)) ?? null;
  }

  has(key: RegistryKey): boolean {
    return this.resolve(key) !== null;
  }

  size(): number {
    return this.specific.size + this.byKind.size;
  }
}

export const noopAuditHandler: ActivityHandler = () => ({ status: "succeeded" });

export const echoTransformationHandler: ActivityHandler = (inv) => ({
  status: "succeeded",
  output: inv.input,
});

export const unsupportedHandler: ActivityHandler = (inv) => ({
  status: "failed",
  errorCode: "UNSUPPORTED_ACTIVITY",
  errorMessage: `no handler registered for activity ${inv.definitionActivityKey} (kind=${inv.kind})`,
  retryable: false,
});

export function createDefaultRegistry(): ActivityRegistry {
  const r = new ActivityRegistry();
  r.registerForKind("audit_emit", noopAuditHandler);
  r.registerForKind("transformation", echoTransformationHandler);
  return r;
}
