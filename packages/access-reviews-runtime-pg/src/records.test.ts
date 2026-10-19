import { describe, expect, it } from "vitest";
import { readRowsWithUnreadable } from "@crossengin/kernel-pg";

import {
  recordsOrRefuse,
  requireIso,
  requireNumeric,
  rowKey,
  rowToCampaign,
  rowToEvidence,
  rowToDecision,
  rowToItem,
  toIso,
  UnreadableRowsError,
  type CampaignRow,
  type DecisionRow,
  type ItemRow,
} from "./records.js";
import { evidenceRowFor, makeSealedEvidence } from "./test-fakes.js";
import { UUIDS } from "./test-fakes.js";

describe("toIso / requireIso", () => {
  it("converts a Date to an ISO string", () => {
    expect(toIso(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
  });

  it("passes a string through unchanged", () => {
    expect(toIso("2026-01-02T03:04:05.000Z")).toBe("2026-01-02T03:04:05.000Z");
  });

  it("maps null/undefined to null", () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });

  it("requireIso throws on a missing value", () => {
    expect(() => requireIso(null, "created_at")).toThrow(/created_at/);
  });
});

const campaignRow: CampaignRow = {
  campaign_id: "arc_00000001",
  tenant_id: UUIDS.tenant,
  label: "Q review",
  description: "desc",
  frequency: "quarterly",
  framework: "soc2_type2",
  status: "in_progress",
  scope: { kind: "all_users_with_role", roleSlug: "member", includeInherited: true },
  reviewer_assignment: {
    policy: "principal_manager",
    fallbackReviewerUserId: UUIDS.reviewer,
    reviewerPoolUserIds: [],
    specificReviewerUserId: null,
    roleBasedReviewerRoleSlug: null,
    escalationChainUserIds: [],
    escalationTimeoutHours: 72,
  },
  auto_revoke_policy: "auto_revoke_on_deadline",
  related_incident_id: null,
  scheduled_start_at: "2026-01-01T00:00:00.000Z",
  deadline_at: "2026-01-15T00:00:00.000Z",
  grace_period_hours: 24,
  remediation_deadline_at: null,
  created_at: new Date("2025-12-01T00:00:00.000Z"),
  created_by: UUIDS.creator,
  started_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
  archived_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  template_id: null,
  total_items: 3,
  decided_items: 1,
  auto_revoked_items: 0,
  exception_items: 0,
};

describe("rowToCampaign", () => {
  it("maps snake_case columns to the contract record", () => {
    const c = rowToCampaign(campaignRow);
    expect(c.id).toBe("arc_00000001");
    expect(c.tenantId).toBe(UUIDS.tenant);
    expect(c.autoRevokePolicy).toBe("auto_revoke_on_deadline");
    expect(c.createdAt).toBe("2025-12-01T00:00:00.000Z");
    expect(c.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(c.totalItems).toBe(3);
  });
});

const itemRow: ItemRow = {
  item_id: "ari_00000001",
  tenant_id: UUIDS.tenant,
  campaign_natural_id: "arc_00000001",
  principal_id: UUIDS.principal,
  principal_type: "user",
  principal_label: "alice",
  grant_kind: "role",
  grant_id: "grant-1",
  grant_label: "admin",
  grant_attributes: {},
  granted_at: "2024-01-01T00:00:00.000Z",
  granted_by: UUIDS.creator,
  last_used_at: null,
  risk_level: "high",
  status: "in_review",
  current_reviewer_user_id: UUIDS.reviewer,
  current_reviewer_kind: "human_user",
  reviewer_assigned_at: "2026-01-02T00:00:00.000Z",
  reminder_count: 2,
  last_reminder_at: "2026-01-03T00:00:00.000Z",
  escalation_level: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  opened_for_review_at: "2026-01-02T00:00:00.000Z",
  decided_at: null,
  decision_id: null,
  auto_revoked_at: null,
  auto_revoke_reason: null,
  due_at: "2026-01-10T00:00:00.000Z",
  notes: null,
};

describe("rowToItem", () => {
  it("reconstructs a nested currentReviewer from flat columns", () => {
    const it_ = rowToItem(itemRow);
    expect(it_.campaignId).toBe("arc_00000001");
    expect(it_.currentReviewer).toEqual({
      reviewerUserId: UUIDS.reviewer,
      reviewerKind: "human_user",
      assignedAt: "2026-01-02T00:00:00.000Z",
      reminderCount: 2,
      lastReminderAt: "2026-01-03T00:00:00.000Z",
      escalationLevel: 1,
    });
    expect("notes" in it_).toBe(false);
  });

  it("returns a null currentReviewer when the reviewer columns are null", () => {
    const it_ = rowToItem({
      ...itemRow,
      current_reviewer_user_id: null,
      current_reviewer_kind: null,
      reviewer_assigned_at: null,
      status: "pending",
    });
    expect(it_.currentReviewer).toBeNull();
  });
});

const decisionRow: DecisionRow = {
  decision_id: "ard_00000001",
  item_natural_id: "ari_00000001",
  campaign_natural_id: "arc_00000001",
  tenant_id: UUIDS.tenant,
  decided_by_user_id: UUIDS.system,
  decided_at: "2026-02-01T00:00:00.000Z",
  kind: "revoke",
  reason: "no_response_auto_default",
  comment: "auto",
  time_bound_extend_until: null,
  modified_grant_attributes: null,
  attestation_kind: "click_through_acknowledgement",
  attestation_phrase: null,
  attestation_signature_sha256: null,
  attestation_signing_key_fingerprint: null,
  co_attesting_user_id: null,
  co_attested_at: null,
  ip_address: "127.0.0.1",
  user_agent: "runtime",
  supersedes_decision_id: null,
  related_exception_id: null,
  applied_at: null,
  application_failed_at: null,
  application_failure_reason: null,
};

describe("rowToDecision", () => {
  it("rebuilds the nested attestation, deriving attestedBy/attestedAt from decided_*", () => {
    const d = rowToDecision(decisionRow);
    expect(d.itemId).toBe("ari_00000001");
    expect(d.campaignId).toBe("arc_00000001");
    expect(d.attestation.attestedByUserId).toBe(UUIDS.system);
    expect(d.attestation.attestedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(d.attestation.ipAddress).toBe("127.0.0.1");
  });

  it("omits attestationPhrase when the column is NULL, rather than carrying undefined", () => {
    const d = rowToDecision(decisionRow);
    // `canonicalAttestationBytes` hashes `attestationPhrase` and `canonicalStringify` skips
    // `undefined`, so an absent key and a present-but-undefined one are the same bytes — but only
    // the absent form survives a JSON hop, which is what an evidence pack is.
    expect("attestationPhrase" in d.attestation).toBe(false);
  });

  it("reads a typed attestation phrase back from its own column", () => {
    const d = rowToDecision({
      ...decisionRow,
      attestation_kind: "typed_attestation_phrase",
      attestation_phrase: "I attest this access is appropriate.",
    });
    expect(d.attestation.attestationPhrase).toBe("I attest this access is appropriate.");
  });

  it("refuses a typed_attestation_phrase row whose phrase column is NULL", () => {
    // The two halves of this increment interlocking, and the reason neither ships alone: the
    // contract now requires a non-empty phrase for this kind, and that clause is only reachable
    // from a read because the column exists. Without the column every such row would read back as
    // a record the contract refuses; without the clause a lost phrase would read back clean.
    expect(() =>
      rowToDecision({ ...decisionRow, attestation_kind: "typed_attestation_phrase" }),
    ).toThrow(/attestationPhrase/);
  });

  it("refuses a stored phrase past the contract's 500-character bound", () => {
    expect(() =>
      rowToDecision({ ...decisionRow, attestation_phrase: "x".repeat(501) }),
    ).toThrow();
    // The bound itself, derived rather than restated: one character fewer parses.
    expect(
      rowToDecision({ ...decisionRow, attestation_phrase: "x".repeat(500) }).attestation
        .attestationPhrase,
    ).toHaveLength(500);
  });

  /*
   * Every case below returned a happily-wrong record before this mapper gained its `.parse`: the
   * function was a bare object literal *typed* as `AccessReviewDecision`, so all eleven of the
   * schema's `superRefine` clauses were checked on the write path and on no read.
   */
  it("now throws on a co-attestor equal to the attestor — the first read-side four-eyes check", () => {
    expect(() =>
      rowToDecision({
        ...decisionRow,
        attestation_kind: "two_person_attestation",
        co_attesting_user_id: UUIDS.system, // === decided_by_user_id, so === attestedByUserId
        co_attested_at: "2026-02-01T00:00:00.000Z",
      }),
    ).toThrow(/co-attestor must differ/);
  });

  it("cannot be made to violate the OTHER four-eyes clause, because it reconstructs it", () => {
    // `decidedByUserId === attestation.attestedByUserId` is unviolatable from a row by
    // construction: both sides are read from `decided_by_user_id`, since no `attestation_*` actor
    // column exists. So the parse enforces it vacuously here and non-vacuously on everything the
    // writer round-trips — which is the reason the derivation is sound, not a reason to drop it.
    const d = rowToDecision({ ...decisionRow, decided_by_user_id: UUIDS.reviewer });
    expect(d.attestation.attestedByUserId).toBe(d.decidedByUserId);
  });

  it("now throws on two_person_attestation with no co-attestor", () => {
    expect(() =>
      rowToDecision({ ...decisionRow, attestation_kind: "two_person_attestation" }),
    ).toThrow(/two_person_attestation requires/);
  });

  it("now throws on e_signature_digital with no signature", () => {
    expect(() =>
      rowToDecision({ ...decisionRow, attestation_kind: "e_signature_digital" }),
    ).toThrow(/signatureSha256/);
  });

  it("now throws on a kind/reason pair the contract calls inconsistent", () => {
    expect(() =>
      rowToDecision({ ...decisionRow, kind: "keep", reason: "security_concern_revoked" }),
    ).toThrow(/inconsistent/);
  });

  it("now throws on time_bound_extend with no extension date", () => {
    expect(() => rowToDecision({ ...decisionRow, kind: "time_bound_extend" })).toThrow(
      /timeBoundExtendUntil/,
    );
  });

  it("now throws on an extension that does not outlast the decision", () => {
    expect(() =>
      rowToDecision({
        ...decisionRow,
        kind: "time_bound_extend",
        reason: "business_justification_attested",
        time_bound_extend_until: decisionRow.decided_at,
      }),
    ).toThrow(/must be after decidedAt/);
  });

  it("now throws on an application that precedes its own decision", () => {
    expect(() =>
      rowToDecision({ ...decisionRow, applied_at: "2026-01-01T00:00:00.000Z" }),
    ).toThrow(/cannot precede decidedAt/);
  });

  it("now throws on a recorded application failure with no reason", () => {
    expect(() =>
      rowToDecision({ ...decisionRow, application_failed_at: "2026-02-02T00:00:00.000Z" }),
    ).toThrow(/applicationFailureReason/);
  });

  it("still accepts the row the writer actually produces", () => {
    expect(() => rowToDecision(decisionRow)).not.toThrow();
  });
});

describe("requireNumeric", () => {
  it("passes a number through", () => {
    expect(requireNumeric(0.6667, "completion_rate")).toBe(0.6667);
  });

  it("parses the string node-postgres returns for NUMERIC", () => {
    expect(requireNumeric("0.6667", "completion_rate")).toBe(0.6667);
    expect(requireNumeric("1.0000", "keep_rate")).toBe(1);
  });

  it("refuses null rather than coercing it to 0, which would read as a 0% rate", () => {
    expect(() => requireNumeric(null, "completion_rate")).toThrow(/completion_rate/);
  });

  it("refuses an unparseable value and names the column", () => {
    expect(() => requireNumeric("not-a-number", "overdue_rate")).toThrow(/overdue_rate/);
  });

  it("refuses an empty string, which Number() also turns into 0", () => {
    expect(() => requireNumeric("", "keep_rate")).toThrow(/keep_rate/);
  });

  it("refuses a non-finite number", () => {
    expect(() => requireNumeric(Number.POSITIVE_INFINITY, "revoke_rate")).toThrow(/revoke_rate/);
  });

  /**
   * The message is `unreadableDetail`'s non-zod arm, which passes an `Error`'s own text through
   * verbatim — so a guard that interpolates the column's value puts a row value into a finding
   * (ADR-0367). It used to render `JSON.stringify(value)`, and the sibling guards beside it never
   * did. Asserted on the value rather than on the message's wording, so it holds however the
   * sentence is reworded.
   */
  it("names the column and never the value it refused, which reaches a finding verbatim", () => {
    for (const value of ["000-11-2222", "MRN-1", { ssn: "000-11-2222" }, Number.NaN]) {
      let message = "";
      try {
        requireNumeric(value, "completion_rate");
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("completion_rate");
      expect(message).not.toContain("000-11-2222");
      expect(message).not.toContain("MRN-1");
      expect(message).not.toContain("NaN");
    }
  });
});

describe("rowToEvidence", () => {
  it("round-trips a sealed record through the row spelling", () => {
    const sealed = makeSealedEvidence();
    expect(rowToEvidence(evidenceRowFor(sealed) as never)).toEqual(sealed);
  });

  it("parses a JSONB array arriving as text", () => {
    const sealed = makeSealedEvidence();
    const row = { ...evidenceRowFor(sealed), campaign_ids: JSON.stringify(sealed.campaignIds) };
    expect(rowToEvidence(row as never).campaignIds).toEqual(sealed.campaignIds);
  });

  it("refuses a JSONB column that is not a string array", () => {
    const row = { ...evidenceRowFor(makeSealedEvidence()), control_mappings: [1, 2] };
    expect(() => rowToEvidence(row as never)).toThrow(/control_mappings/);
  });

  it("refuses a sealed row with no digest, which only the superRefine catches", () => {
    const row = { ...evidenceRowFor(makeSealedEvidence()), sealed_sha256: null };
    expect(() => rowToEvidence(row as never)).toThrow();
  });
});

describe("readRowsWithUnreadable", () => {
  interface Row {
    readonly key: string | null;
    readonly value: number;
  }
  const map = (row: Row): number => {
    if (row.value < 0) throw new Error("value must not be negative");
    return row.value;
  };
  const identify = (row: Row): string | null => rowKey(row.key);

  it("keeps every row the mapper accepts", () => {
    const read = readRowsWithUnreadable([{ key: "a", value: 1 }, { key: "b", value: 2 }], map, identify);
    expect(read.records).toEqual([1, 2]);
    expect(read.unreadable).toEqual([]);
  });

  it("reports the refused row and returns the rest, which a .map took with it", () => {
    const read = readRowsWithUnreadable(
      [{ key: "a", value: 1 }, { key: "bad", value: -1 }, { key: "c", value: 3 }],
      map,
      identify,
    );
    expect(read.records).toEqual([1, 3]);
    expect(read.unreadable).toEqual([
      { identity: "bad", detail: "value must not be negative" },
    ]);
  });

  it("reports an unidentified row rather than losing the rows behind it", () => {
    // `identify` runs inside the catch, so its own throw costs this row's handle and nothing else.
    const read = readRowsWithUnreadable(
      [{ key: null, value: -1 }, { key: "c", value: 3 }],
      map,
      (row) => {
        if (row.key === null) throw new Error("no key");
        return row.key;
      },
    );
    expect(read.records).toEqual([3]);
    expect(read.unreadable).toEqual([{ identity: null, detail: "value must not be negative" }]);
  });

  it("names the field path and the issue code for a zod refusal, and no value the row held", () => {
    // Shared with the primitive rather than restated, which is the half that must not diverge: a
    // `ZodError`'s own message quotes the stored value for an enum miss.
    const row = { ...evidenceRowFor(makeSealedEvidence()), framework: "iso_9001" } as never;
    const read = readRowsWithUnreadable([row], rowToEvidence, (r) => rowKey(r.evidence_id));
    expect(read.records).toEqual([]);
    expect(read.unreadable[0]?.detail).toBe("framework: invalid_enum_value");
    expect(read.unreadable[0]?.detail).not.toContain("iso_9001");
  });
});

describe("recordsOrRefuse", () => {
  it("hands back the records when nothing was withheld", () => {
    expect(recordsOrRefuse("subject", { records: [1, 2], unreadable: [] })).toEqual([1, 2]);
  });

  it("refuses rather than return a short list, naming every withheld row", () => {
    // The other legitimate answer: a scheduler counting these rows must not be handed a subset.
    let caught: unknown = null;
    try {
      recordsOrRefuse("items of campaign arc_1", {
        records: [1],
        unreadable: [
          { identity: "ari_1", detail: "due_at: invalid_type" },
          { identity: null, detail: "row is missing required timestamp: created_at" },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnreadableRowsError);
    const err = caught as UnreadableRowsError;
    expect(err.unreadable).toHaveLength(2);
    expect(err.message).toContain("ari_1");
    expect(err.message).toContain("<unidentified>");
    expect(err.message).toContain("items of campaign arc_1");
  });
});

describe("rowKey", () => {
  it("answers null for everything that is not a non-empty string", () => {
    // `null` says *this row does not name one* rather than inventing a handle, and an empty string
    // is not a handle either — a `WHERE campaign_id = ''` sends an operator nowhere.
    expect(rowKey("arc_1")).toBe("arc_1");
    expect(rowKey("")).toBeNull();
    expect(rowKey(null)).toBeNull();
    expect(rowKey(undefined)).toBeNull();
    expect(rowKey(7)).toBeNull();
  });
});
