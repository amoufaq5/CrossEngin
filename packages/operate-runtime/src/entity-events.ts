import type { WriteEffect, WriteEffectInput } from "./write-effects.js";

/**
 * A domain event derived from a persisted entity write, ready to be turned into job runs. `name` is
 * the dotted event name (`<prefix?>.<entity>.<verb>`; the verb is `created`/`updated`/`deleted`, or
 * the lifecycle target state for a transition — e.g. `salesorder.placed`). `data` is the record after
 * the write; `idempotencyKey` is stable per write so an at-least-once re-delivery collapses.
 */
export interface EntityEvent {
  readonly name: string;
  readonly tenantId: string;
  readonly entity: string;
  readonly operation: "create" | "update" | "transition" | "delete";
  readonly recordId: string | null;
  readonly data: Record<string, unknown>;
  readonly toState?: string;
  readonly idempotencyKey: string;
}

/** Where entity events go — an operate-server implementation enqueues matching jobs. */
export interface EntityEventSink {
  emit(event: EntityEvent): Promise<void>;
}

export interface EntityEventEffectConfig {
  readonly sink: EntityEventSink;
  /** Optional namespace prefix (`retail` → `retail.salesorder.placed`). */
  readonly eventPrefix?: string;
  /** Notified if the sink throws — event emission is best-effort and never fails the write. */
  readonly onError?: (err: unknown) => void;
}

const VERB_BY_OP = { create: "created", update: "updated", delete: "deleted" } as const;

/** A dotted event-name segment: lowercased, non-alphanumerics → `_`, leading digit prefixed. */
function segment(value: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(s) ? s : `x_${s}`;
}

function verbFor(input: WriteEffectInput): string {
  if (input.operation === "transition") {
    return segment(input.transitionTo ?? "transitioned");
  }
  return VERB_BY_OP[input.operation];
}

function recordIdOf(input: WriteEffectInput): string | null {
  const fromRecord = input.after["id"];
  if (typeof fromRecord === "string" && fromRecord.length > 0) return fromRecord;
  return input.id;
}

/**
 * A `WriteEffect` that turns each persisted write into an `EntityEvent` and hands it to the sink —
 * the producer bridge from a served mutation to event-triggered jobs. The event name is
 * `<prefix?>.<entity>.<verb>` (verb = created/updated/deleted, or the transition's target state), and
 * the `idempotencyKey` is `<entity>:<operation>:<recordId>:<updated_at|verb>` so a re-delivery of the
 * same write collapses to one run while distinct writes do not. **Best-effort:** a sink failure is
 * routed to `onError` and swallowed — emitting an event must never fail the user's write (unlike the
 * financial effects, which throw by design).
 */
export function entityEventEffect(config: EntityEventEffectConfig): WriteEffect {
  const prefix = config.eventPrefix !== undefined ? segment(config.eventPrefix) : undefined;
  return async (input: WriteEffectInput): Promise<void> => {
    try {
      const verb = verbFor(input);
      const name = [prefix, segment(input.entity), verb].filter((p) => p !== undefined && p.length > 0).join(".");
      const recordId = recordIdOf(input);
      const updatedAt = typeof input.after["updated_at"] === "string" ? (input.after["updated_at"] as string) : "";
      const idempotencyKey = `${input.entity}:${input.operation}:${recordId ?? "new"}:${updatedAt.length > 0 ? updatedAt : verb}`;
      await config.sink.emit({
        name,
        tenantId: input.tenantId,
        entity: input.entity,
        operation: input.operation,
        recordId,
        data: input.after,
        ...(input.operation === "transition" && input.transitionTo !== undefined ? { toState: input.transitionTo } : {}),
        idempotencyKey,
      });
    } catch (err) {
      config.onError?.(err);
    }
  };
}
