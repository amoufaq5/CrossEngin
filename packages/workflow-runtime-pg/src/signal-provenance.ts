import type {
  SignalDeliveryGuarantee,
  WorkflowDefinition,
  WorkflowEvent,
} from "@crossengin/workflow-engine";
import { projectSignals } from "@crossengin/workflow-runtime";

import type { SignalProjection } from "./signal-store.js";

/**
 * Why a signal's provenance could not be resolved from the log. Each is a refusal, never a
 * substituted value: `meta.workflow_signals.delivery_guarantee` and `source_system` are both
 * NOT NULL with no default, and a guessed guarantee claims a promise the definition did not make —
 * weaker if we guess `at_most_once`, stronger if we guess `exactly_once_idempotent`.
 */
export const SIGNAL_PROVENANCE_DEFECTS = [
  "definition_unavailable",
  "signal_undeclared",
  "receipt_event_absent",
  "source_system_unrecorded",
  "idempotency_key_absent",
] as const;
export type SignalProvenanceDefect = (typeof SIGNAL_PROVENANCE_DEFECTS)[number];

export class SignalProvenanceUnresolved extends Error {
  readonly defect: SignalProvenanceDefect;
  readonly signalId: string;
  readonly signalName: string;

  constructor(opts: {
    readonly defect: SignalProvenanceDefect;
    readonly signalId: string;
    readonly signalName: string;
    readonly detail: string;
  }) {
    super(
      `cannot persist signal ${opts.signalId} (${opts.signalName}): ${opts.defect} — ${opts.detail}`,
    );
    this.name = "SignalProvenanceUnresolved";
    this.defect = opts.defect;
    this.signalId = opts.signalId;
    this.signalName = opts.signalName;
  }
}

/**
 * The two facts `projectSignals` cannot produce, plus the principal beside them.
 *
 * Both are *recorded*, not chosen here. The guarantee is a required field on the
 * `SignalDefinition` the workflow declares — `WorkflowDefinitionSchema` refuses a
 * `signal_received` transition naming an undeclared signal, so the definition is the only place
 * in the contract where a guarantee exists, and the submitter is given no say in it. The source
 * system is whatever the engine already stamped on the `signal_received` event as
 * `actorSystemId` (`input.sourceSystem ?? systemActorId`): when the submitter named none, the
 * engine process *is* the system that put the signal in the log, so reading it back is reading
 * provenance rather than filling a hole.
 */
export interface SignalProvenance {
  readonly deliveryGuarantee: SignalDeliveryGuarantee;
  readonly sourceSystem: string;
  readonly sourcePrincipalId: string | null;
  /**
   * The submitter's key, read off the receipt beside the source system — a fact of arrival, not a
   * value chosen here. `null` is legal under the two weaker guarantees and refused under
   * `exactly_once_idempotent`, because the column is nullable and the contract is not.
   */
  readonly idempotencyKey: string | null;
}

/** The receipt's `idempotencyKey`, or `null` for a log written before the engine recorded it. */
function recordedIdempotencyKey(receipt: WorkflowEvent): string | null {
  const value = receipt.payload["idempotencyKey"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function receiptEvents(
  events: readonly WorkflowEvent[],
): ReadonlyMap<string, WorkflowEvent> {
  const byId = new Map<string, WorkflowEvent>();
  for (const event of events) {
    if (event.kind !== "signal_received") continue;
    if (event.signalId === null) continue;
    // First receipt wins: provenance is a fact of arrival, and a re-delivered id cannot restate it.
    if (byId.has(event.signalId)) continue;
    byId.set(event.signalId, event);
  }
  return byId;
}

export function resolveSignalProvenance(input: {
  readonly signalId: string;
  readonly signalName: string;
  readonly definition: WorkflowDefinition | undefined;
  readonly receipt: WorkflowEvent | undefined;
}): SignalProvenance {
  const { signalId, signalName } = input;
  if (input.definition === undefined) {
    throw new SignalProvenanceUnresolved({
      defect: "definition_unavailable",
      signalId,
      signalName,
      detail: "the instance's workflow definition is not in the engine's definition map",
    });
  }
  const declared = input.definition.signals.find((s) => s.name === signalName);
  if (declared === undefined) {
    throw new SignalProvenanceUnresolved({
      defect: "signal_undeclared",
      signalId,
      signalName,
      detail: `definition ${input.definition.id} declares no signal by that name`,
    });
  }
  if (input.receipt === undefined) {
    throw new SignalProvenanceUnresolved({
      defect: "receipt_event_absent",
      signalId,
      signalName,
      detail: "no signal_received event carries this signal id",
    });
  }
  if (input.receipt.actorSystemId === null) {
    throw new SignalProvenanceUnresolved({
      defect: "source_system_unrecorded",
      signalId,
      signalName,
      detail: "the signal_received event carries no actorSystemId",
    });
  }
  const idempotencyKey = recordedIdempotencyKey(input.receipt);
  // The last line of defence for the row `WorkflowSignalSchema` forbids and the CHECK permits.
  // `WorkflowEngine.submitSignal` refuses this before the receipt is even appended; this catches a
  // log written by an older build, where the key was never recorded at all — a resync of which
  // would otherwise quietly rewrite the same unparseable row.
  if (declared.deliveryGuarantee === "exactly_once_idempotent" && idempotencyKey === null) {
    throw new SignalProvenanceUnresolved({
      defect: "idempotency_key_absent",
      signalId,
      signalName,
      detail:
        "the definition declares exactly_once_idempotent but the signal_received event records no idempotencyKey",
    });
  }
  return {
    deliveryGuarantee: declared.deliveryGuarantee,
    sourceSystem: input.receipt.actorSystemId,
    sourcePrincipalId: input.receipt.actorPrincipalId,
    idempotencyKey,
  };
}

/**
 * `projectSignals` plus the provenance the table requires — the one input
 * `PostgresSignalStore.upsert` accepts, so no caller can assemble a row that the column
 * constraints will reject.
 */
export function projectPersistableSignals(
  events: readonly WorkflowEvent[],
  definition: WorkflowDefinition | undefined,
): readonly SignalProjection[] {
  const receipts = receiptEvents(events);
  return projectSignals(events).map((s): SignalProjection => {
    const provenance = resolveSignalProvenance({
      signalId: s.id,
      signalName: s.signalName,
      definition,
      receipt: receipts.get(s.id),
    });
    return {
      id: s.id,
      instanceId: s.instanceId,
      tenantId: s.tenantId,
      signalName: s.signalName,
      correlationKey: s.correlationKey,
      deliveryGuarantee: provenance.deliveryGuarantee,
      idempotencyKey: provenance.idempotencyKey,
      sourceSystem: provenance.sourceSystem,
      sourcePrincipalId: provenance.sourcePrincipalId,
      status: s.status,
      receivedAt: s.receivedAt,
      matchedAt: s.matchedAt,
      consumedAt: s.consumedAt,
    };
  });
}
