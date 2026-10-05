import type { WorkflowDefinition, WorkflowEvent } from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import {
  SIGNAL_PROVENANCE_DEFECTS,
  SignalProvenanceUnresolved,
  projectPersistableSignals,
  resolveSignalProvenance,
} from "./signal-provenance.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: "wfd_def00001",
    tenantId: null,
    definitionKey: "purchase.approval",
    version: "1.0.0",
    label: "Purchase approval",
    description: "",
    status: "published",
    states: [
      { name: "draft", kind: "initial", label: "D", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "awaiting", kind: "waiting", label: "W", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "approved", kind: "terminal_success", label: "A", onEntryActions: [], onExitActions: [], slaSeconds: null },
    ],
    transitions: [
      {
        name: "approve",
        fromState: "awaiting",
        toState: "approved",
        trigger: { kind: "signal_received", signalName: "approve" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
    ],
    variables: [],
    timers: [],
    signals: [
      {
        name: "approve",
        correlationVariable: "poNumber",
        payloadSchemaSha256: null,
        deliveryGuarantee: "exactly_once_idempotent",
        idempotencyKey: "approvalId",
      },
    ],
    initialState: "draft",
    compensationStrategy: "no_compensation",
    timeoutSeconds: 86_400,
    createdAt: "2026-05-01T00:00:00.000Z",
    createdBy: "00000000-0000-4000-8000-000000000099",
    publishedAt: "2026-05-01T00:00:00.000Z",
    publishedBy: "00000000-0000-4000-8000-000000000099",
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
    ...overrides,
  };
}

function baseEvent(overrides: Partial<WorkflowEvent>): WorkflowEvent {
  return {
    id: "wfe_event0001",
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    sequenceNumber: 0,
    kind: "instance_started",
    occurredAt: "2026-05-16T12:00:00.000Z",
    actorPrincipalId: null,
    actorSystemId: "workflow-engine",
    previousState: null,
    newState: null,
    activityId: null,
    signalId: null,
    timerId: null,
    childInstanceId: null,
    variableName: null,
    payload: {},
    correlationId: null,
    causationEventId: null,
    ...overrides,
  };
}

function startedEvent(): WorkflowEvent {
  return baseEvent({
    payload: {
      definitionId: "wfd_def00001",
      definitionKey: "purchase.approval",
      definitionVersion: "1.0.0",
      initialState: "draft",
      variables: {},
      timeoutAt: "2026-05-17T12:00:00.000Z",
    },
  });
}

function receivedEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return baseEvent({
    id: "wfe_event0002",
    sequenceNumber: 1,
    kind: "signal_received",
    occurredAt: "2026-05-16T12:00:01.000Z",
    signalId: "wfs_sig00001",
    actorSystemId: "procurement-gateway",
    payload: { signalName: "approve", correlationKey: "po-1" },
    ...overrides,
  });
}

function consumedEvent(): WorkflowEvent {
  return baseEvent({
    id: "wfe_event0003",
    sequenceNumber: 2,
    kind: "signal_consumed",
    occurredAt: "2026-05-16T12:00:02.000Z",
    signalId: "wfs_sig00001",
    payload: { signalName: "approve" },
  });
}

describe("SIGNAL_PROVENANCE_DEFECTS", () => {
  it("names the four ways provenance cannot be read", () => {
    expect([...SIGNAL_PROVENANCE_DEFECTS]).toEqual([
      "definition_unavailable",
      "signal_undeclared",
      "receipt_event_absent",
      "source_system_unrecorded",
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(SIGNAL_PROVENANCE_DEFECTS).size).toBe(SIGNAL_PROVENANCE_DEFECTS.length);
  });
});

describe("resolveSignalProvenance", () => {
  it("takes the guarantee from the definition's SignalDefinition", () => {
    const provenance = resolveSignalProvenance({
      signalId: "wfs_sig00001",
      signalName: "approve",
      definition: definition(),
      receipt: receivedEvent(),
    });
    expect(provenance.deliveryGuarantee).toBe("exactly_once_idempotent");
  });

  it("takes the source system from the receipt event's actorSystemId", () => {
    const provenance = resolveSignalProvenance({
      signalId: "wfs_sig00001",
      signalName: "approve",
      definition: definition(),
      receipt: receivedEvent(),
    });
    expect(provenance.sourceSystem).toBe("procurement-gateway");
    expect(provenance.sourcePrincipalId).toBeNull();
  });

  it("carries the principal through when the receipt names one", () => {
    const provenance = resolveSignalProvenance({
      signalId: "wfs_sig00001",
      signalName: "approve",
      definition: definition(),
      receipt: receivedEvent({ actorPrincipalId: PRINCIPAL }),
    });
    expect(provenance.sourcePrincipalId).toBe(PRINCIPAL);
  });

  it("reads a different declared guarantee rather than a fixed one", () => {
    const def = definition({
      signals: [
        {
          name: "approve",
          correlationVariable: "poNumber",
          payloadSchemaSha256: null,
          deliveryGuarantee: "at_most_once",
          idempotencyKey: null,
        },
      ],
    });
    expect(
      resolveSignalProvenance({
        signalId: "wfs_sig00001",
        signalName: "approve",
        definition: def,
        receipt: receivedEvent(),
      }).deliveryGuarantee,
    ).toBe("at_most_once");
  });

  it("refuses when the definition is not in the map", () => {
    try {
      resolveSignalProvenance({
        signalId: "wfs_sig00001",
        signalName: "approve",
        definition: undefined,
        receipt: receivedEvent(),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SignalProvenanceUnresolved);
      expect((err as SignalProvenanceUnresolved).defect).toBe("definition_unavailable");
      expect((err as SignalProvenanceUnresolved).signalId).toBe("wfs_sig00001");
    }
  });

  it("refuses when the definition declares no signal by that name", () => {
    try {
      resolveSignalProvenance({
        signalId: "wfs_sig00001",
        signalName: "approve",
        definition: definition({ signals: [] }),
        receipt: receivedEvent(),
      });
      expect.unreachable();
    } catch (err) {
      expect((err as SignalProvenanceUnresolved).defect).toBe("signal_undeclared");
    }
  });

  it("refuses when no signal_received event carries the id", () => {
    try {
      resolveSignalProvenance({
        signalId: "wfs_sig00001",
        signalName: "approve",
        definition: definition(),
        receipt: undefined,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as SignalProvenanceUnresolved).defect).toBe("receipt_event_absent");
    }
  });

  it("refuses an unrecorded source system rather than substituting one", () => {
    try {
      resolveSignalProvenance({
        signalId: "wfs_sig00001",
        signalName: "approve",
        definition: definition(),
        receipt: receivedEvent({ actorSystemId: null, actorPrincipalId: PRINCIPAL }),
      });
      expect.unreachable();
    } catch (err) {
      expect((err as SignalProvenanceUnresolved).defect).toBe("source_system_unrecorded");
    }
  });

  it("names the signal and never the payload in the message", () => {
    const err = new SignalProvenanceUnresolved({
      defect: "signal_undeclared",
      signalId: "wfs_sig00001",
      signalName: "approve",
      detail: "definition wfd_def00001 declares no signal by that name",
    });
    expect(err.message).toContain("wfs_sig00001");
    expect(err.message).toContain("approve");
    expect(err.name).toBe("SignalProvenanceUnresolved");
  });
});

describe("projectPersistableSignals", () => {
  it("produces a row carrying every column the table requires", () => {
    const rows = projectPersistableSignals(
      [startedEvent(), receivedEvent()],
      definition(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "wfs_sig00001",
      instanceId: "wfi_inst0001",
      tenantId: TENANT,
      signalName: "approve",
      correlationKey: "po-1",
      deliveryGuarantee: "exactly_once_idempotent",
      sourceSystem: "procurement-gateway",
      sourcePrincipalId: null,
      status: "matched_to_instance",
      receivedAt: "2026-05-16T12:00:01.000Z",
      matchedAt: "2026-05-16T12:00:01.000Z",
      consumedAt: null,
    });
  });

  it("keeps the receipt's provenance after the signal is consumed", () => {
    const rows = projectPersistableSignals(
      [startedEvent(), receivedEvent(), consumedEvent()],
      definition(),
    );
    expect(rows[0]?.status).toBe("consumed");
    expect(rows[0]?.consumedAt).toBe("2026-05-16T12:00:02.000Z");
    expect(rows[0]?.sourceSystem).toBe("procurement-gateway");
  });

  it("is empty — and so never needs a definition — when no signal was received", () => {
    expect(projectPersistableSignals([startedEvent()], undefined)).toEqual([]);
  });

  it("refuses the whole batch when one signal's guarantee is unreadable", () => {
    expect(() =>
      projectPersistableSignals(
        [startedEvent(), receivedEvent()],
        definition({ signals: [] }),
      ),
    ).toThrow(SignalProvenanceUnresolved);
  });

  it("takes the first receipt for an id, not a later restatement", () => {
    const rows = projectPersistableSignals(
      [
        startedEvent(),
        receivedEvent(),
        receivedEvent({
          id: "wfe_event0009",
          sequenceNumber: 9,
          actorSystemId: "someone-else",
        }),
      ],
      definition(),
    );
    expect(rows[0]?.sourceSystem).toBe("procurement-gateway");
  });

  it("resolves each signal independently when several arrive", () => {
    const def = definition({
      signals: [
        {
          name: "approve",
          correlationVariable: "poNumber",
          payloadSchemaSha256: null,
          deliveryGuarantee: "exactly_once_idempotent",
          idempotencyKey: "approvalId",
        },
        {
          name: "cancel",
          correlationVariable: "poNumber",
          payloadSchemaSha256: null,
          deliveryGuarantee: "at_least_once",
          idempotencyKey: null,
        },
      ],
    });
    const rows = projectPersistableSignals(
      [
        startedEvent(),
        receivedEvent(),
        receivedEvent({
          id: "wfe_event0004",
          sequenceNumber: 4,
          signalId: "wfs_sig00002",
          actorSystemId: "ops-console",
          payload: { signalName: "cancel", correlationKey: "po-1" },
        }),
      ],
      def,
    );
    expect(rows.map((r) => [r.signalName, r.deliveryGuarantee, r.sourceSystem])).toEqual([
      ["approve", "exactly_once_idempotent", "procurement-gateway"],
      ["cancel", "at_least_once", "ops-console"],
    ]);
  });
});
