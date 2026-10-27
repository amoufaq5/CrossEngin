import { describe, expect, it } from "vitest";
import {
  ARTICLE_12_ANSWER_INSTANT,
  ARTICLE_12_ANSWER_INSTANTS,
  ARTICLE_12_MAX_DEADLINE_MS,
  DEADLINE_EXTENSION_REFUSALS,
  DEADLINE_STANDINGS,
  DEADLINE_STANDING_FACTS,
  DEFAULT_DEADLINE_WARNING_DAYS,
  DELETION_REQUEST_STATUSES,
  GDPR_LEGAL_BASES,
  GdprDeletionRequestSchema,
  RETENTION_OBLIGATIONS,
  UNANSWERED_DELETION_REQUEST_STATUSES,
  answeredAfterDeadline,
  article12Answer,
  assessDeadline,
  canTransitionDeletionRequest,
  daysUntilDeadline,
  hasRetainedData,
  isDeadlineFinding,
  isOverdue,
  planDeadlineExtension,
  type DeadlineStanding,
  type GdprDeletionRequest,
} from "./gdpr-deletion.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("GDPR_LEGAL_BASES has 6 entries", () => {
    expect(GDPR_LEGAL_BASES).toContain("article_17_right_to_erasure");
    expect(GDPR_LEGAL_BASES).toContain("consent_withdrawn");
  });

  it("RETENTION_OBLIGATIONS covers tax/medical/audit/financial/aml/none", () => {
    expect(RETENTION_OBLIGATIONS).toContain("tax_records_7y");
    expect(RETENTION_OBLIGATIONS).toContain("medical_records_10y");
    expect(RETENTION_OBLIGATIONS).toContain("none");
  });

  it("DELETION_REQUEST_STATUSES has 6 entries", () => {
    expect(DELETION_REQUEST_STATUSES).toContain("verified");
    expect(DELETION_REQUEST_STATUSES).toContain("deferred");
  });
});

describe("canTransitionDeletionRequest", () => {
  it("submitted -> verified", () => {
    expect(canTransitionDeletionRequest("submitted", "verified")).toBe(true);
  });

  it("verified -> in_progress", () => {
    expect(canTransitionDeletionRequest("verified", "in_progress")).toBe(true);
  });

  it("in_progress -> completed", () => {
    expect(canTransitionDeletionRequest("in_progress", "completed")).toBe(true);
  });

  it("completed is terminal", () => {
    expect(canTransitionDeletionRequest("completed", "in_progress")).toBe(false);
  });

  it("deferred can resume", () => {
    expect(canTransitionDeletionRequest("deferred", "in_progress")).toBe(true);
  });
});

describe("GdprDeletionRequestSchema", () => {
  const base: GdprDeletionRequest = {
    id: "del-1",
    tenantId: "t-1",
    subjectIdentifier: "user@example.com",
    legalBasis: "article_17_right_to_erasure",
    status: "completed",
    submittedAt: "2026-05-01T00:00:00Z",
    submittedBy: "user@example.com",
    deadlineAt: "2026-05-31T00:00:00Z",
    verificationMethod: "email_link",
    verifiedAt: "2026-05-02T00:00:00Z",
    verifiedBy: "support-1",
    inProgressAt: "2026-05-03T00:00:00Z",
    completedAt: "2026-05-15T00:00:00Z",
    completionSha256: SHA,
    rejectedAt: null,
    deferredUntil: null,
    deadlineExtendedAt: null,
    retentionObligations: ["none"],
    retainedDataCategories: [],
    tombstoneId: "tomb_aaaabbbbccccdddd",
  };

  it("accepts a valid completed request", () => {
    expect(() => GdprDeletionRequestSchema.parse(base)).not.toThrow();
  });

  it("requires a completed request to name the tombstone that completed it", () => {
    // completionSha256 commits to the proof and cannot find it — a digest is not a lookup key — so
    // without the id a completed request and the deletion it asked for cannot be joined.
    expect(() => GdprDeletionRequestSchema.parse({ ...base, tombstoneId: null })).toThrow(
      /must name the tombstone/,
    );
  });

  it("refuses a tombstone on a request that is not completed", () => {
    for (const status of ["submitted", "verified", "in_progress", "rejected", "deferred"] as const) {
      // Naming a proof it has not been completed by is claiming a proof it does not have.
      expect(() =>
        GdprDeletionRequestSchema.parse({ ...base, status, tombstoneId: "tomb_aaaabbbbccccdddd" }),
      ).toThrow(/must not name a tombstone/);
    }
  });

  it("defaults tombstoneId to null for a request that has not completed", () => {
    const parsed = GdprDeletionRequestSchema.parse({
      ...base,
      status: "verified",
      completedAt: null,
      completionSha256: null,
      tombstoneId: undefined,
    });
    expect(parsed.tombstoneId).toBeNull();
  });

  it("rejects deadline > 3 months after submission", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        deadlineAt: "2026-09-01T00:00:00Z",
      }),
    ).toThrow(/Article 12\(3\) caps deadlineAt at 3 months/);
  });

  it("rejects deadline <= submission", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        deadlineAt: "2026-05-01T00:00:00Z",
      }),
    ).toThrow(/after submittedAt/);
  });

  it("rejects completed without completionSha256", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({ ...base, completionSha256: null }),
    ).toThrow(/completionSha256/);
  });

  it("accepts a completion after the deadline, because the breach is a fact that happened", () => {
    // The schema used to refuse this, which prevented no breach and made the record of one
    // unreadable: the pg store commits the `completed` row and parses it afterwards, so a late
    // deletion destroyed the data, wrote the tombstone, committed the row, and then threw for ever.
    const parsed = GdprDeletionRequestSchema.parse({
      ...base,
      completedAt: "2026-07-01T00:00:00Z",
    });
    expect(parsed.completedAt).toBe("2026-07-01T00:00:00Z");
    expect(answeredAfterDeadline(parsed)).toBe(true);
  });

  it("still enforces every other completed-status rule on a late completion", () => {
    // Representable is not unvalidated: dropping the deadline refusal must not have widened the
    // branch it lived in.
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        completedAt: "2026-07-01T00:00:00Z",
        completionSha256: null,
      }),
    ).toThrow(/completionSha256/);
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        completedAt: "2026-07-01T00:00:00Z",
        tombstoneId: null,
      }),
    ).toThrow(/must name the tombstone/);
  });

  it("rejects verified without verifiedBy", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({ ...base, verifiedBy: null }),
    ).toThrow(/verifiedBy/);
  });

  it("rejects rejected without rejectedReason", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        status: "rejected",
        rejectedAt: "2026-05-10T00:00:00Z",
        completionSha256: null,
        completedAt: null,
      }),
    ).toThrow(/rejectedReason/);
  });

  it("rejects deferred without deferredUntil + reason", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        status: "deferred",
        completionSha256: null,
        completedAt: null,
      }),
    ).toThrow(/deferredUntil/);
  });

  it("rejects retention obligation without retained data categories", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        retentionObligations: ["tax_records_7y"],
        retainedDataCategories: [],
      }),
    ).toThrow(/must list retainedDataCategories/);
  });

  it("rejects retained categories without an obligation", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        retainedDataCategories: ["billing_records"],
      }),
    ).toThrow(/without a stated obligation/);
  });

  it("rejects duplicate retention obligations", () => {
    expect(() =>
      GdprDeletionRequestSchema.parse({
        ...base,
        retentionObligations: ["tax_records_7y", "tax_records_7y"],
        retainedDataCategories: ["billing"],
      }),
    ).toThrow(/duplicate obligation/);
  });
});

describe("helpers", () => {
  const base: GdprDeletionRequest = {
    id: "x",
    tenantId: "t-1",
    subjectIdentifier: "user@example.com",
    legalBasis: "article_17_right_to_erasure",
    status: "in_progress",
    submittedAt: "2026-05-01T00:00:00Z",
    submittedBy: "user@example.com",
    deadlineAt: "2026-05-31T00:00:00Z",
    verificationMethod: "email_link",
    verifiedAt: "2026-05-02T00:00:00Z",
    verifiedBy: "support-1",
    inProgressAt: "2026-05-03T00:00:00Z",
    completedAt: null,
    completionSha256: null,
    rejectedAt: null,
    deferredUntil: null,
    deadlineExtendedAt: null,
    retentionObligations: ["none"],
    retainedDataCategories: [],
    tombstoneId: null,
  };

  it("isOverdue true after deadline if not completed", () => {
    expect(isOverdue(base, new Date("2026-06-15T00:00:00Z"))).toBe(true);
  });

  it("isOverdue false if completed", () => {
    expect(
      isOverdue(
        {
          ...base,
          status: "completed",
          completedAt: "2026-05-20T00:00:00Z",
          completionSha256: SHA,
        },
        new Date("2026-06-15T00:00:00Z"),
      ),
    ).toBe(false);
  });

  const completed = (completedAt: string | null): GdprDeletionRequest => ({
    ...base,
    status: "completed",
    completedAt,
    completionSha256: SHA,
    tombstoneId: "tomb_aaaabbbbccccdddd",
  });

  it("answeredAfterDeadline true when the deletion finished past the deadline", () => {
    expect(answeredAfterDeadline(completed("2026-06-15T00:00:00Z"))).toBe(true);
  });

  it("answeredAfterDeadline false when the deletion finished before the deadline", () => {
    expect(answeredAfterDeadline(completed("2026-05-20T00:00:00Z"))).toBe(false);
  });

  it("answeredAfterDeadline false exactly at the deadline", () => {
    // `>`, not `>=`: the deadline is the last moment that is on time.
    expect(answeredAfterDeadline(completed("2026-05-31T00:00:00Z"))).toBe(false);
    expect(answeredAfterDeadline(completed("2026-05-31T00:00:01Z"))).toBe(true);
  });

  it("answeredAfterDeadline is null while nobody has answered, whatever the clock says", () => {
    // A `deferred` request sitting past its deadline is `isOverdue`'s finding, not this one's.
    // Reporting it here would attribute a late *answer* to a request nobody has answered.
    for (const status of ["submitted", "verified", "in_progress", "deferred"] as const) {
      expect(answeredAfterDeadline({ ...completed("2026-06-15T00:00:00Z"), status })).toBeNull();
    }
    // `rejected` is the one that changed: a refusal recorded past the deadline is late, because
    // Article 12(4) puts it under the same clock. This predicate replaced a `completed`-only one
    // that answered `false` here.
    expect(
      answeredAfterDeadline({
        ...completed(null),
        status: "rejected",
        rejectedAt: "2026-06-15T00:00:00Z",
        rejectedReason: "not a data subject",
      }),
    ).toBe(true);
  });

  it("answeredAfterDeadline is null for a completed request that states no completion time", () => {
    // Unreachable past `GdprDeletionRequestSchema`, which requires `completedAt` on `completed`.
    // `false` would read as compliance and `true` would assert a breach from a record carrying no
    // completion time at all, so the only honest answer is that no comparison was possible.
    expect(answeredAfterDeadline(completed(null))).toBeNull();
  });

  it("isOverdue and answeredAfterDeadline are total over a deadline breach", () => {
    // The pair is the whole point. `isOverdue` answers `false` for every answered request, so on
    // its own a late completion read exactly like a compliant one.
    const late = completed("2026-06-15T00:00:00Z");
    expect(isOverdue(late, new Date("2026-07-01T00:00:00Z"))).toBe(false);
    expect(answeredAfterDeadline(late)).toBe(true);

    const onTime = completed("2026-05-20T00:00:00Z");
    expect(isOverdue(onTime, new Date("2026-07-01T00:00:00Z"))).toBe(false);
    expect(answeredAfterDeadline(onTime)).toBe(false);
  });

  it("daysUntilDeadline counts down", () => {
    expect(daysUntilDeadline(base, new Date("2026-05-21T00:00:00Z"))).toBe(10);
  });

  it("hasRetainedData reflects retainedDataCategories", () => {
    expect(hasRetainedData(base)).toBe(false);
    expect(
      hasRetainedData({
        ...base,
        retentionObligations: ["tax_records_7y"],
        retainedDataCategories: ["billing"],
      }),
    ).toBe(true);
  });
});

/**
 * A request in any status, built so a test varies only what it is about.
 *
 * Every status needs its own required fields (the four non-`submitted` ones need the verification
 * triple, `completed` needs a digest and a tombstone, `rejected` a reason, `deferred` a deferral),
 * so this parses rather than asserting a literal: a fixture that typechecks and the schema refuses
 * is a test about nothing.
 */
function requestIn(
  status: GdprDeletionRequest["status"],
  over: Record<string, unknown> = {},
): GdprDeletionRequest {
  const verified = {
    verificationMethod: "email_link",
    verifiedAt: "2026-05-02T00:00:00.000Z",
    verifiedBy: "support-1",
  };
  const byStatus: Record<GdprDeletionRequest["status"], Record<string, unknown>> = {
    submitted: {},
    verified,
    in_progress: { ...verified, inProgressAt: "2026-05-03T00:00:00.000Z" },
    completed: {
      ...verified,
      inProgressAt: "2026-05-03T00:00:00.000Z",
      completedAt: "2026-05-20T00:00:00.000Z",
      completionSha256: SHA,
      tombstoneId: "tomb_aaaabbbbccccdddd",
    },
    rejected: { rejectedAt: "2026-05-20T00:00:00.000Z", rejectedReason: "not a data subject" },
    deferred: {
      ...verified,
      deferredUntil: "2026-06-01T00:00:00.000Z",
      deferralReason: "complexity",
    },
  };
  return GdprDeletionRequestSchema.parse({
    id: "dreq_abcdefgh1234",
    tenantId: "t-1",
    subjectIdentifier: "user@example.com",
    legalBasis: "article_17_right_to_erasure",
    status,
    submittedAt: "2026-05-01T00:00:00.000Z",
    submittedBy: "user@example.com",
    deadlineAt: "2026-05-31T00:00:00.000Z",
    ...byStatus[status],
    ...over,
  });
}

describe("ARTICLE_12_ANSWER_INSTANT", () => {
  it("answers for every status", () => {
    for (const status of DELETION_REQUEST_STATUSES) {
      expect(ARTICLE_12_ANSWER_INSTANTS).toContain(ARTICLE_12_ANSWER_INSTANT[status]);
    }
    expect(Object.keys(ARTICLE_12_ANSWER_INSTANT).sort()).toEqual(
      [...DELETION_REQUEST_STATUSES].sort(),
    );
  });

  it("is exactly one status per terminal instant, which is what pins the two audit queries", () => {
    // `completedWithTombstone` filters `status = 'completed'` and `rejectedAfterDeadline` filters
    // `status = 'rejected'`, both as SQL literals. A seventh status answering through either column
    // would be covered by neither query, and this is the assertion that names it.
    const by = (instant: string): string[] =>
      DELETION_REQUEST_STATUSES.filter((s) => ARTICLE_12_ANSWER_INSTANT[s] === instant);
    expect(by("completed_at")).toEqual(["completed"]);
    expect(by("rejected_at")).toEqual(["rejected"]);
  });

  it("UNANSWERED_DELETION_REQUEST_STATUSES is the derived complement", () => {
    expect([...UNANSWERED_DELETION_REQUEST_STATUSES].sort()).toEqual([
      "deferred",
      "in_progress",
      "submitted",
      "verified",
    ]);
    // The two the register found read by no query in the workspace. They are in the sweep's bound
    // parameter array by derivation, so neither can drop out of it by omission.
    expect(UNANSWERED_DELETION_REQUEST_STATUSES).toContain("submitted");
    expect(UNANSWERED_DELETION_REQUEST_STATUSES).toContain("deferred");
  });

  it("agrees with isOverdue over every status", () => {
    // `isOverdue` used to name `completed` and `rejected` inline. Two spellings of one complement is
    // how they come to disagree, so this asserts the one it reads now is the one the sweep binds.
    const past = new Date("2026-07-01T00:00:00Z");
    for (const status of DELETION_REQUEST_STATUSES) {
      const unanswered = ARTICLE_12_ANSWER_INSTANT[status] === "unanswered";
      expect(isOverdue(requestIn(status), past)).toBe(unanswered);
    }
  });
});

describe("article12Answer", () => {
  it("is unanswered for every waiting status", () => {
    for (const status of UNANSWERED_DELETION_REQUEST_STATUSES) {
      expect(article12Answer(requestIn(status)).kind).toBe("unanswered");
    }
  });

  it("reads the completion instant for completed and the rejection instant for rejected", () => {
    expect(article12Answer(requestIn("completed"))).toEqual({
      kind: "answered",
      at: "2026-05-20T00:00:00.000Z",
      from: "completed_at",
    });
    expect(article12Answer(requestIn("rejected"))).toEqual({
      kind: "answered",
      at: "2026-05-20T00:00:00.000Z",
      from: "rejected_at",
    });
  });

  it("separates a terminal record that states no instant from one still waiting", () => {
    // The schema refuses this pairing, so the only way to hold it is to build it past validation —
    // which is exactly what a hand-edited row reaches `rowToDeletionRequest` as.
    const silent: GdprDeletionRequest = { ...requestIn("completed"), completedAt: null };
    expect(article12Answer(silent)).toEqual({
      kind: "answer_instant_absent",
      from: "completed_at",
    });
    expect(article12Answer(requestIn("verified")).kind).toBe("unanswered");
  });
});

describe("answeredAfterDeadline", () => {
  it("reports a late rejection, which nothing in the workspace could see", () => {
    // Article 12(4) puts a refusal under the same clock as an erasure, and `isOverdue` excused
    // `rejected` on the ground that a refused request "was answered rather than answered late".
    expect(answeredAfterDeadline(requestIn("rejected", { rejectedAt: "2026-06-15T00:00:00.000Z" })))
      .toBe(true);
    expect(answeredAfterDeadline(requestIn("rejected"))).toBe(false);
  });

  it("is null when there is no comparison to make", () => {
    expect(answeredAfterDeadline(requestIn("verified"))).toBeNull();
    expect(
      answeredAfterDeadline({ ...requestIn("rejected"), rejectedAt: null }),
    ).toBeNull();
  });

  it("is on time exactly at the deadline", () => {
    expect(answeredAfterDeadline(requestIn("completed", { completedAt: "2026-05-31T00:00:00.000Z" })))
      .toBe(false);
    expect(answeredAfterDeadline(requestIn("completed", { completedAt: "2026-05-31T00:00:01.000Z" })))
      .toBe(true);
  });

  it("answers for both terminal statuses and for neither waiting one", () => {
    // The breadth that retired the `completed`-only predicate this replaced: over every status, a
    // late answer is reported iff the status answers the subject at all. Before this, `rejected`
    // was excused and a refusal recorded past the deadline was a breach nothing could see.
    for (const status of DELETION_REQUEST_STATUSES) {
      const late = requestIn(status, {
        ...(status === "completed" ? { completedAt: "2026-06-15T00:00:00.000Z" } : {}),
        ...(status === "rejected" ? { rejectedAt: "2026-06-15T00:00:00.000Z" } : {}),
      });
      const answers = ARTICLE_12_ANSWER_INSTANT[status] !== "unanswered";
      expect(answeredAfterDeadline(late)).toBe(answers ? true : null);
    }
  });
});

describe("DEADLINE_STANDING_FACTS", () => {
  it("answers for every standing", () => {
    expect(Object.keys(DEADLINE_STANDING_FACTS).sort()).toEqual([...DEADLINE_STANDINGS].sort());
  });

  it("a missed deadline can never still be met", () => {
    for (const standing of DEADLINE_STANDINGS) {
      const f = DEADLINE_STANDING_FACTS[standing];
      expect(f.breached && f.deadlineCanStillBeMet).toBe(false);
    }
  });

  it("exactly one standing can still be met, and it is the escalation axis", () => {
    const meetable = DEADLINE_STANDINGS.filter(
      (s) => DEADLINE_STANDING_FACTS[s].deadlineCanStillBeMet,
    );
    expect(meetable).toEqual(["approaching"]);
  });

  it("every breach is reported, and two standings are not findings", () => {
    for (const standing of DEADLINE_STANDINGS) {
      if (DEADLINE_STANDING_FACTS[standing].breached) expect(isDeadlineFinding(standing)).toBe(true);
    }
    const quiet = DEADLINE_STANDINGS.filter((s) => !isDeadlineFinding(s));
    expect([...quiet].sort()).toEqual(["answered_in_time", "within_deadline"]);
  });

  it("reports a record that cannot say when it answered, without calling it either thing", () => {
    // Neither a breach nor meetable, and still a finding. A derived `reported` would have had to
    // special-case exactly this member, which is why it is a declared field.
    expect(DEADLINE_STANDING_FACTS.answer_time_unstated).toEqual({
      breached: false,
      deadlineCanStillBeMet: false,
      reported: true,
    });
  });
});

describe("assessDeadline", () => {
  const warningDays = DEFAULT_DEADLINE_WARNING_DAYS;

  it("breaches a submitted request nobody verified", () => {
    // The register's likeliest real breach path: `submitted` was read by no query in the workspace,
    // so such a request sat past its deadline with nothing looking at it.
    const a = assessDeadline(requestIn("submitted"), {
      now: new Date("2026-06-15T00:00:00Z"),
      warningDays,
    });
    expect(a.standing).toBe("breached");
    expect(a.answeredAt).toBeNull();
    expect(a.msPastDeadline).toBe(15 * 86_400_000);
    expect(DEADLINE_STANDING_FACTS[a.standing].breached).toBe(true);
  });

  it("warns inside the horizon and is quiet outside it", () => {
    const req = requestIn("verified");
    expect(
      assessDeadline(req, { now: new Date("2026-05-26T00:00:00Z"), warningDays }).standing,
    ).toBe("approaching");
    expect(
      assessDeadline(req, { now: new Date("2026-05-20T00:00:00Z"), warningDays }).standing,
    ).toBe("within_deadline");
  });

  it("is approaching exactly at the deadline, never breached", () => {
    // `isOverdue` is strictly `>`, so the instant the deadline falls on is still meetable — which is
    // the one standing where an act changes the outcome, so rounding it to `breached` would retire
    // the alarm at the moment it matters most.
    const a = assessDeadline(requestIn("verified"), {
      now: new Date("2026-05-31T00:00:00Z"),
      warningDays,
    });
    expect(a.standing).toBe("approaching");
    expect(a.msPastDeadline).toBe(0);
  });

  it("orders the overdue test before the horizon test", () => {
    // A passed deadline also satisfies `daysUntilDeadline <= warningDays`, so reversing the two
    // reports a breached request as one whose deadline can still be met. Mutation-checked.
    const a = assessDeadline(requestIn("verified"), {
      now: new Date("2026-06-01T00:00:00Z"),
      warningDays,
    });
    expect(a.standing).toBe("breached");
    expect(DEADLINE_STANDING_FACTS[a.standing].deadlineCanStillBeMet).toBe(false);
  });

  it("reports a late rejection as answered_late", () => {
    const a = assessDeadline(requestIn("rejected", { rejectedAt: "2026-06-15T00:00:00.000Z" }), {
      now: new Date("2027-01-01T00:00:00Z"),
      warningDays,
    });
    expect(a.standing).toBe("answered_late");
    expect(a.answeredAt).toBe("2026-06-15T00:00:00.000Z");
    expect(a.msPastDeadline).toBe(15 * 86_400_000);
  });

  it("does not drift with the clock once the subject has been answered", () => {
    // Both operands are stored, so the standing of an answered request is a settled historical fact.
    const req = requestIn("completed", { completedAt: "2026-06-15T00:00:00.000Z" });
    const early = assessDeadline(req, { now: new Date("2026-06-16T00:00:00Z"), warningDays });
    const late = assessDeadline(req, { now: new Date("2030-01-01T00:00:00Z"), warningDays });
    expect(early).toEqual(late);
  });

  it("carries no delta for a record that does not state when it answered", () => {
    const a = assessDeadline(
      { ...requestIn("completed"), completedAt: null },
      { now: new Date("2026-06-15T00:00:00Z"), warningDays },
    );
    expect(a.standing).toBe("answer_time_unstated");
    // `0` would read as "answered exactly at the deadline" and `NaN` would propagate into figures.
    expect(a.msPastDeadline).toBeNull();
  });

  it("carries the extension, so a reader knows the deadline in force moved", () => {
    const a = assessDeadline(
      requestIn("verified", {
        deadlineAt: "2026-07-20T00:00:00.000Z",
        deadlineExtendedAt: "2026-05-10T00:00:00.000Z",
        deadlineExtensionReason: "complexity of the request",
      }),
      { now: new Date("2026-06-15T00:00:00Z"), warningDays },
    );
    expect(a.standing).toBe("within_deadline");
    expect(a.extendedAt).toBe("2026-05-10T00:00:00.000Z");
    expect(a.deadlineAt).toBe("2026-07-20T00:00:00.000Z");
  });

  it("every status yields a standing whose facts are declared", () => {
    const seen = new Set<DeadlineStanding>();
    for (const status of DELETION_REQUEST_STATUSES) {
      const a = assessDeadline(requestIn(status), {
        now: new Date("2026-06-15T00:00:00Z"),
        warningDays,
      });
      expect(DEADLINE_STANDINGS).toContain(a.standing);
      expect(a.status).toBe(status);
      seen.add(a.standing);
    }
    // Non-vacuity: the six statuses really do reach more than one standing.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("reads the horizon it was given and reports it back", () => {
    const req = requestIn("verified");
    const now = new Date("2026-05-20T00:00:00Z");
    expect(assessDeadline(req, { now, warningDays: 7 }).standing).toBe("within_deadline");
    expect(assessDeadline(req, { now, warningDays: 30 }).standing).toBe("approaching");
    expect(assessDeadline(req, { now, warningDays: 30 }).warningDays).toBe(30);
  });
});

describe("the extension", () => {
  const at = "2026-05-10T00:00:00.000Z";
  const reason = "complexity of the request";

  it("the schema and the plan read one cap", () => {
    // 93 days, the figure the schema has always enforced. Two spellings is how the validator and
    // the act come to disagree about which extensions are lawful.
    expect(ARTICLE_12_MAX_DEADLINE_MS).toBe(30 * 86_400_000 * 3.1);
    const atCap = new Date(
      new Date("2026-05-01T00:00:00.000Z").getTime() + ARTICLE_12_MAX_DEADLINE_MS,
    ).toISOString();
    expect(planDeadlineExtension(requestIn("verified"), { deadlineAt: atCap, deadlineExtendedAt: at, deadlineExtensionReason: reason }).ok).toBe(true);
    const past = new Date(Date.parse(atCap) + 1).toISOString();
    expect(planDeadlineExtension(requestIn("verified"), { deadlineAt: past, deadlineExtendedAt: at, deadlineExtensionReason: reason })).toEqual({
      ok: false,
      refusal: "exceeds_article_12_cap",
      detail: "GDPR Article 12(3) caps the deadline at 3 months from submission",
    });
    // And the schema agrees about the same boundary, from the same constant.
    expect(() => requestIn("verified", { deadlineAt: past })).toThrow(/Article 12\(3\) caps/);
  });

  it("extends a waiting request", () => {
    expect(
      planDeadlineExtension(requestIn("verified"), {
        deadlineAt: "2026-07-20T00:00:00.000Z",
        deadlineExtendedAt: at,
        deadlineExtensionReason: reason,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses to move the line an answered request is judged against", () => {
    for (const status of DELETION_REQUEST_STATUSES) {
      const plan = planDeadlineExtension(requestIn(status), {
        deadlineAt: "2026-07-20T00:00:00.000Z",
        deadlineExtendedAt: at,
        deadlineExtensionReason: reason,
      });
      const answered = ARTICLE_12_ANSWER_INSTANT[status] !== "unanswered";
      expect(plan.ok).toBe(!answered);
      if (answered) {
        expect(plan).toMatchObject({ refusal: "request_already_answered" });
      }
    }
  });

  it("grants one extension, not several", () => {
    expect(
      planDeadlineExtension(
        requestIn("verified", {
          deadlineAt: "2026-06-20T00:00:00.000Z",
          deadlineExtendedAt: at,
          deadlineExtensionReason: reason,
        }),
        {
          deadlineAt: "2026-07-20T00:00:00.000Z",
          deadlineExtendedAt: "2026-05-12T00:00:00.000Z",
          deadlineExtensionReason: reason,
        },
      ),
    ).toMatchObject({ refusal: "already_extended" });
  });

  it("refuses a deadline that is not later than the one in force", () => {
    for (const to of ["2026-05-31T00:00:00.000Z", "2026-05-20T00:00:00.000Z"]) {
      expect(
        planDeadlineExtension(requestIn("verified"), {
          deadlineAt: to,
          deadlineExtendedAt: at,
          deadlineExtensionReason: reason,
        }),
      ).toMatchObject({
        refusal: "not_an_extension",
      });
    }
  });

  it("refuses a reason that states nothing, including whitespace", () => {
    // The hole this closed: `""` passed the plan, the store's UPDATE committed all three columns,
    // and the RETURNING row was refused by `GdprDeletionRequestSchema` for ever — so `read()` threw
    // from then on and `transition()` threw before building any SQL, making the Article 17 erasure
    // for that data subject unreachable through the store. Whitespace is included because `.min(1)`
    // does not trim, so `"   "` was accepted end to end and stored as the Article 12(3) reason.
    for (const why of ["", " ", "   ", "\t", "\n"]) {
      expect(
        planDeadlineExtension(requestIn("verified"), {
          deadlineAt: "2026-07-20T00:00:00.000Z",
          deadlineExtendedAt: at,
          deadlineExtensionReason: why,
        }),
        JSON.stringify(why),
      ).toMatchObject({ refusal: "reason_not_stated" });
    }
  });

  it("refuses the reason before it reads the request's state", () => {
    // An input that cannot be represented is not worth comparing against state, so an
    // already-answered request with a blank reason reports the reason. The mirror of the ordering
    // test above, and the lesser cost: this caller can see their own argument.
    expect(
      planDeadlineExtension(requestIn("completed"), {
        deadlineAt: "2026-07-20T00:00:00.000Z",
        deadlineExtendedAt: at,
        deadlineExtensionReason: "",
      }),
    ).toMatchObject({ refusal: "reason_not_stated" });
  });

  it("admits nothing the stored record cannot represent", () => {
    // The converse of `every refusal has a producer`, which nothing asserted: that fence proves no
    // member is unreachable, and this one proves no *admitted* input produces a row the schema
    // refuses — which is the direction the blank reason escaped through. Every field the extension
    // writes is applied to the record and the result re-parsed.
    const request = requestIn("verified");
    const inputs: { readonly deadlineExtensionReason: string }[] = [
      { deadlineExtensionReason: "complexity of the request" },
      { deadlineExtensionReason: "x" },
      { deadlineExtensionReason: " padded but stating something " },
    ];
    for (const partial of inputs) {
      const input = {
        deadlineAt: "2026-07-20T00:00:00.000Z",
        deadlineExtendedAt: at,
        ...partial,
      };
      expect(planDeadlineExtension(request, input), partial.deadlineExtensionReason).toEqual({
        ok: true,
      });
      // The row the store's UPDATE would commit, re-parsed exactly as its RETURNING is.
      expect(() =>
        GdprDeletionRequestSchema.parse({
          ...request,
          deadlineAt: input.deadlineAt,
          deadlineExtendedAt: input.deadlineExtendedAt,
          deadlineExtensionReason: input.deadlineExtensionReason,
        }),
      ).not.toThrow();
    }
  });

  it("refuses an extension recorded before the request arrived", () => {
    expect(
      planDeadlineExtension(requestIn("verified"), {
        deadlineAt: "2026-07-20T00:00:00.000Z",
        deadlineExtendedAt: "2026-04-01T00:00:00.000Z",
        deadlineExtensionReason: reason,
      }),
    ).toMatchObject({ refusal: "recorded_before_submission" });
  });

  it("refuses in the order a caller can act on", () => {
    // An answered request that is also already extended must say the first, because extending it at
    // all is the thing that cannot happen; `already_extended` would read as "try a different value".
    const plan = planDeadlineExtension(
      requestIn("completed", {
        deadlineAt: "2026-06-20T00:00:00.000Z",
        deadlineExtendedAt: at,
        deadlineExtensionReason: reason,
      }),
      { deadlineAt: "2026-07-20T00:00:00.000Z", deadlineExtendedAt: at, deadlineExtensionReason: reason },
    );
    expect(plan).toMatchObject({ refusal: "request_already_answered" });
  });

  it("every refusal has a producer", () => {
    // A vocabulary member nothing can emit reads as coverage it does not provide.
    const produced = new Set<string>();
    const cases: {
      request: GdprDeletionRequest;
      to: string;
      at: string;
      why?: string;
    }[] = [
      { request: requestIn("verified"), to: "2026-07-20T00:00:00.000Z", at, why: "  " },
      { request: requestIn("completed"), to: "2026-07-20T00:00:00.000Z", at },
      {
        request: requestIn("verified", {
          deadlineAt: "2026-06-20T00:00:00.000Z",
          deadlineExtendedAt: at,
          deadlineExtensionReason: reason,
        }),
        to: "2026-07-20T00:00:00.000Z",
        at,
      },
      { request: requestIn("verified"), to: "2026-05-20T00:00:00.000Z", at },
      { request: requestIn("verified"), to: "2027-01-01T00:00:00.000Z", at },
      { request: requestIn("verified"), to: "2026-07-20T00:00:00.000Z", at: "2026-04-01T00:00:00.000Z" },
    ];
    for (const c of cases) {
      const plan = planDeadlineExtension(c.request, {
        deadlineAt: c.to,
        deadlineExtendedAt: c.at,
        deadlineExtensionReason: c.why ?? reason,
      });
      if (!plan.ok) produced.add(plan.refusal);
    }
    expect([...produced].sort()).toEqual([...DEADLINE_EXTENSION_REFUSALS].sort());
  });

  it("the schema requires the extension's two halves together", () => {
    expect(() => requestIn("verified", { deadlineExtendedAt: at })).toThrow(
      /must state the reason Article 12\(3\) requires/,
    );
    expect(() => requestIn("verified", { deadlineExtensionReason: reason })).toThrow(
      /states a reason for nothing/,
    );
  });

  it("the schema refuses an extension granted before the request arrived", () => {
    expect(() =>
      requestIn("verified", {
        deadlineExtendedAt: "2026-04-01T00:00:00.000Z",
        deadlineExtensionReason: reason,
      }),
    ).toThrow(/must not precede submittedAt/);
  });

  it("the schema admits an extension recorded late, because it happened", () => {
    // ADR-0372's rule: a contract that refuses to represent a fact that happened does not prevent
    // the fact, it destroys the evidence. Article 12(3)'s inform-within-one-month obligation is not
    // represented here at all — there is no mail channel — so nothing may refuse on its behalf.
    const parsed = requestIn("verified", {
      deadlineAt: "2026-07-20T00:00:00.000Z",
      deadlineExtendedAt: "2026-06-25T00:00:00.000Z",
      deadlineExtensionReason: reason,
    });
    expect(parsed.deadlineExtendedAt).toBe("2026-06-25T00:00:00.000Z");
  });

  it("an unextended request parses with neither half, so no stored row changed meaning", () => {
    const parsed = requestIn("verified");
    expect(parsed.deadlineExtendedAt).toBeNull();
    expect(parsed.deadlineExtensionReason).toBeUndefined();
  });
});
