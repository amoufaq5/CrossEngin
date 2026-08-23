import { sha256 } from "@crossengin/crypto";
import { NotificationDispatchSchema } from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import {
  DESIGN_NOTIFICATION_TEMPLATES,
  DESIGN_NOTIFICATION_TEMPLATE_VERSION,
  buildDesignDecisionDispatch,
  designDecisionIdempotencyKey,
  designNotificationVariables,
  type DesignDecisionNotice,
} from "./design-notifications.js";

const TENANT_ID = "6f1b1a1e-0f5a-4d7a-9a1c-2b3c4d5e6f70";
const REVIEWER_ID = "11111111-2222-4333-8444-555555555555";

const APPROVED: DesignDecisionNotice = {
  tenantId: TENANT_ID,
  proposalId: "prop_01HZY8Q9K3N4P5R6S7T8V9W0X1",
  proposalName: "Clinic scheduling",
  decision: "approved",
  reviewedBy: REVIEWER_ID,
  notes: "Looks good, PHI is on auditable entities.",
  decidedAt: "2026-08-23T10:15:00.000Z",
};

const REJECTED: DesignDecisionNotice = {
  ...APPROVED,
  decision: "rejected",
  notes: "Patient entity is missing the auditable trait.",
};

describe("design notification constants", () => {
  it("names one template per decision", () => {
    expect(DESIGN_NOTIFICATION_TEMPLATES.approved).toBe("design_review.approved");
    expect(DESIGN_NOTIFICATION_TEMPLATES.rejected).toBe("design_review.rejected");
  });

  it("declares a semver template version", () => {
    expect(DESIGN_NOTIFICATION_TEMPLATE_VERSION).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
  });
});

describe("designDecisionIdempotencyKey", () => {
  it("uses the documented design_review:<proposalId>:<decision> format", () => {
    expect(designDecisionIdempotencyKey("prop_1", "approved")).toBe(
      "design_review:prop_1:approved",
    );
  });

  it("is stable across calls for the same proposal and decision", () => {
    expect(designDecisionIdempotencyKey("prop_1", "approved")).toBe(
      designDecisionIdempotencyKey("prop_1", "approved"),
    );
  });

  it("differs per decision so an approve and a later reject are distinct rows", () => {
    expect(designDecisionIdempotencyKey("prop_1", "approved")).not.toBe(
      designDecisionIdempotencyKey("prop_1", "rejected"),
    );
  });
});

describe("buildDesignDecisionDispatch", () => {
  it("produces a record that parses as a NotificationDispatch when approved", () => {
    expect(() =>
      NotificationDispatchSchema.parse(buildDesignDecisionDispatch(APPROVED)),
    ).not.toThrow();
  });

  it("produces a record that parses as a NotificationDispatch when rejected", () => {
    expect(() =>
      NotificationDispatchSchema.parse(buildDesignDecisionDispatch(REJECTED)),
    ).not.toThrow();
  });

  it("mints a disp_ id matching the dispatch id pattern", () => {
    expect(buildDesignDecisionDispatch(APPROVED).id).toMatch(
      /^disp_[A-Za-z0-9_-]{8,40}$/,
    );
  });

  it("derives the id deterministically from the idempotency key", () => {
    const first = buildDesignDecisionDispatch(APPROVED);
    const second = buildDesignDecisionDispatch(APPROVED);
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(
      `disp_${sha256(designDecisionIdempotencyKey(APPROVED.proposalId, "approved")).slice(0, 32)}`,
    );
  });

  it("mints a different id for the other decision on the same proposal", () => {
    expect(buildDesignDecisionDispatch(APPROVED).id).not.toBe(
      buildDesignDecisionDispatch(REJECTED).id,
    );
  });

  it("keeps the id stable when only the notes change, since the key is unchanged", () => {
    const rewritten = buildDesignDecisionDispatch({ ...APPROVED, notes: "Different note" });
    expect(rewritten.id).toBe(buildDesignDecisionDispatch(APPROVED).id);
    expect(rewritten.idempotencyKey).toBe(
      buildDesignDecisionDispatch(APPROVED).idempotencyKey,
    );
  });

  it("correlates the dispatch back to the proposal", () => {
    expect(buildDesignDecisionDispatch(APPROVED).correlationId).toBe(APPROVED.proposalId);
  });

  it("selects the template for the decision", () => {
    expect(buildDesignDecisionDispatch(APPROVED).templateId).toBe(
      DESIGN_NOTIFICATION_TEMPLATES.approved,
    );
    expect(buildDesignDecisionDispatch(REJECTED).templateId).toBe(
      DESIGN_NOTIFICATION_TEMPLATES.rejected,
    );
  });

  it("queues an in_app transactional notice at high priority", () => {
    const dispatch = buildDesignDecisionDispatch(APPROVED);
    expect(dispatch.channel).toBe("in_app");
    expect(dispatch.category).toBe("transactional");
    expect(dispatch.priority).toBe("high");
    expect(dispatch.status).toBe("queued");
  });

  it("shapes a queued record: no start or completion, only a recipient count", () => {
    const dispatch = buildDesignDecisionDispatch(APPROVED);
    expect(dispatch.startedAt).toBeNull();
    expect(dispatch.completedAt).toBeNull();
    expect(dispatch.cancelledReason).toBeNull();
    expect(dispatch.recipientCount).toBeGreaterThan(0);
    expect(dispatch.deliveredCount).toBe(0);
    expect(dispatch.failedCount).toBe(0);
    expect(dispatch.suppressedCount).toBe(0);
  });

  it("queues at the decision time and names the emitting system", () => {
    const dispatch = buildDesignDecisionDispatch(APPROVED);
    expect(dispatch.queuedAt).toBe(APPROVED.decidedAt);
    expect(dispatch.requestingSystem).toBe("operate-server.design-review");
  });

  it("describes the audience structurally rather than by address", () => {
    expect(buildDesignDecisionDispatch(APPROVED).audienceJson).toEqual({
      kind: "tenant_admins",
      tenantId: TENANT_ID,
    });
  });

  it("never attributes requestedBy, even for a uuid reviewer", () => {
    expect(buildDesignDecisionDispatch(APPROVED).requestedBy).toBeNull();
  });

  it("leaves requestedBy null for a non-uuid reviewer and still parses", () => {
    const dispatch = buildDesignDecisionDispatch({
      ...APPROVED,
      reviewedBy: "platform-reviewer-7",
    });
    expect(dispatch.requestedBy).toBeNull();
    expect(() => NotificationDispatchSchema.parse(dispatch)).not.toThrow();
  });

  it("keeps the reviewer identity out of the dispatch entirely", () => {
    const serialized = JSON.stringify(buildDesignDecisionDispatch(APPROVED));
    expect(serialized).not.toContain(REVIEWER_ID);
  });

  it("defaults the locale to en", () => {
    expect(buildDesignDecisionDispatch(APPROVED).locale).toBe("en");
  });

  it("honours an explicit locale", () => {
    expect(
      buildDesignDecisionDispatch({ ...APPROVED, locale: "fr-FR" }).locale,
    ).toBe("fr-FR");
  });

  it("falls back to en for a malformed locale instead of failing the parse", () => {
    const dispatch = buildDesignDecisionDispatch({ ...APPROVED, locale: "not a locale" });
    expect(dispatch.locale).toBe("en");
    expect(() => NotificationDispatchSchema.parse(dispatch)).not.toThrow();
  });

  it("truncates an over-long proposal id to the correlationId limit", () => {
    const dispatch = buildDesignDecisionDispatch({
      ...APPROVED,
      proposalId: "p".repeat(200),
    });
    expect(dispatch.correlationId).toHaveLength(128);
    expect(() => NotificationDispatchSchema.parse(dispatch)).not.toThrow();
  });
});

describe("designNotificationVariables", () => {
  it("carries the proposal name, decision and notes", () => {
    const variables = designNotificationVariables(APPROVED);
    expect(variables["proposalName"]).toBe("Clinic scheduling");
    expect(variables["decision"]).toBe("approved");
    expect(variables["notes"]).toBe(APPROVED.notes);
    expect(variables["proposalId"]).toBe(APPROVED.proposalId);
  });

  it("renders absent notes and reviewer as empty strings", () => {
    const variables = designNotificationVariables({
      ...APPROVED,
      notes: null,
      reviewedBy: null,
    });
    expect(variables["notes"]).toBe("");
    expect(variables["reviewedBy"]).toBe("");
  });
});

describe("variablesSha256", () => {
  it("is 64 lowercase hex characters", () => {
    expect(buildDesignDecisionDispatch(APPROVED).variablesSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("is deterministic for the same notice", () => {
    expect(buildDesignDecisionDispatch(APPROVED).variablesSha256).toBe(
      buildDesignDecisionDispatch(APPROVED).variablesSha256,
    );
  });

  it("changes when the notes change, so a re-decision is a distinct payload", () => {
    expect(
      buildDesignDecisionDispatch({ ...APPROVED, notes: "Now approved with caveats" })
        .variablesSha256,
    ).not.toBe(buildDesignDecisionDispatch(APPROVED).variablesSha256);
  });

  it("changes when the proposal name changes", () => {
    expect(
      buildDesignDecisionDispatch({ ...APPROVED, proposalName: "Renamed" })
        .variablesSha256,
    ).not.toBe(buildDesignDecisionDispatch(APPROVED).variablesSha256);
  });

  it("is independent of variable key insertion order", () => {
    const variables = designNotificationVariables(APPROVED);
    const shuffled: Record<string, string> = {};
    for (const key of Object.keys(variables).reverse()) {
      shuffled[key] = variables[key] ?? "";
    }
    const canonical = JSON.stringify(
      Object.fromEntries(
        Object.keys(shuffled)
          .sort()
          .map((key) => [key, shuffled[key] ?? ""]),
      ),
    );
    expect(sha256(canonical)).toBe(buildDesignDecisionDispatch(APPROVED).variablesSha256);
  });

  it("never carries the message text itself, only its hash", () => {
    const dispatch = buildDesignDecisionDispatch(APPROVED);
    expect(JSON.stringify(dispatch)).not.toContain(APPROVED.proposalName);
    expect(JSON.stringify(dispatch)).not.toContain(APPROVED.notes);
  });
});
