import { describe, expect, it } from "vitest";
import {
  ACTION_ITEM_PRIORITIES,
  ACTION_ITEM_STATUSES,
  ActionItemSchema,
  POSTMORTEM_STATUSES,
  PostmortemSchema,
  canTransitionPostmortem,
  openActionItems,
  overdueActionItems,
  preventsRecurrenceItems,
  type ActionItem,
  type Postmortem,
} from "./postmortems.js";

describe("constants", () => {
  it("POSTMORTEM_STATUSES has 4 entries", () => {
    expect(POSTMORTEM_STATUSES).toEqual(["drafting", "review", "published", "amended"]);
  });

  it("ACTION_ITEM_PRIORITIES has 4 entries", () => {
    expect(ACTION_ITEM_PRIORITIES).toContain("critical");
  });

  it("ACTION_ITEM_STATUSES has 5 entries", () => {
    expect(ACTION_ITEM_STATUSES).toContain("won_t_fix");
  });
});

describe("canTransitionPostmortem", () => {
  it("drafting -> review", () => {
    expect(canTransitionPostmortem("drafting", "review")).toBe(true);
  });

  it("review -> published", () => {
    expect(canTransitionPostmortem("review", "published")).toBe(true);
  });

  it("published -> amended", () => {
    expect(canTransitionPostmortem("published", "amended")).toBe(true);
  });

  it("drafting -> published not allowed (must review first)", () => {
    expect(canTransitionPostmortem("drafting", "published")).toBe(false);
  });
});

describe("ActionItemSchema", () => {
  const base: ActionItem = {
    id: "ai-2026-0001",
    title: "Add circuit breaker",
    description: "Add per-tenant circuit breaker on DB calls",
    owner: "u-1",
    priority: "high",
    status: "open",
    createdAt: "2026-05-14T12:00:00Z",
    dueAt: "2026-06-14T12:00:00Z",
    completedAt: null,
    preventsRecurrence: true,
  };

  it("accepts a valid action item", () => {
    expect(() => ActionItemSchema.parse(base)).not.toThrow();
  });

  it("rejects dueAt <= createdAt", () => {
    expect(() => ActionItemSchema.parse({ ...base, dueAt: "2026-05-14T12:00:00Z" })).toThrow(
      /after createdAt/,
    );
  });

  it("rejects completed without completedAt", () => {
    expect(() => ActionItemSchema.parse({ ...base, status: "completed" })).toThrow(/completedAt/);
  });

  it("rejects blocked without blockedReason", () => {
    expect(() => ActionItemSchema.parse({ ...base, status: "blocked" })).toThrow(/blockedReason/);
  });

  it("rejects won_t_fix without wontFixReason", () => {
    expect(() => ActionItemSchema.parse({ ...base, status: "won_t_fix" })).toThrow(/wontFixReason/);
  });

  it("rejects critical without preventsRecurrence", () => {
    expect(() =>
      ActionItemSchema.parse({
        ...base,
        priority: "critical",
        preventsRecurrence: false,
      }),
    ).toThrow(/preventsRecurrence=true/);
  });
});

describe("PostmortemSchema", () => {
  const base: Postmortem = {
    id: "PM-2026-0042",
    incidentId: "INC-2026-0042",
    title: "DB pool exhaustion",
    severity: "sev2",
    status: "published",
    summary: "Connection pool exhausted under load spike",
    rootCause: "Misconfigured maxConnections",
    contributingFactors: ["No autoscaling on DB tier"],
    detection: "Synthetic checks flagged elevated p99",
    response: "Restarted pool, restored service",
    impact: "30 min API outage for EU tenants",
    whatWentWell: ["Fast triage"],
    whatWentWrong: ["No alert before customer reported"],
    lessonsLearned: ["Add pool saturation alert"],
    actionItems: [],
    timelineSummary: "Detected at 10:05, resolved at 10:30",
    authorUserId: "u-author",
    reviewers: ["u-rev1", "u-rev2"],
    createdAt: "2026-05-15T10:00:00Z",
    publishedAt: "2026-05-20T10:00:00Z",
    amendedAt: null,
    blamelessAttested: true,
    confidentialityClass: "customer_facing",
  };

  it("accepts a valid published postmortem", () => {
    expect(() => PostmortemSchema.parse(base)).not.toThrow();
  });

  it("rejects without blameless attestation", () => {
    expect(() => PostmortemSchema.parse({ ...base, blamelessAttested: false })).toThrow(
      /blameless/,
    );
  });

  it("rejects published with < 2 reviewers", () => {
    expect(() => PostmortemSchema.parse({ ...base, reviewers: ["u-rev1"] })).toThrow(
      /at least 2 reviewers/,
    );
  });

  it("rejects author as their own reviewer", () => {
    expect(() =>
      PostmortemSchema.parse({
        ...base,
        reviewers: ["u-author", "u-rev1"],
      }),
    ).toThrow(/author cannot be a reviewer/);
  });

  it("rejects sev1 without action items", () => {
    expect(() =>
      PostmortemSchema.parse({
        ...base,
        severity: "sev1",
      }),
    ).toThrow(/at least one action item/);
  });

  it("rejects amended without amendedAt", () => {
    expect(() => PostmortemSchema.parse({ ...base, status: "amended" })).toThrow(/amendedAt/);
  });

  it("rejects duplicate reviewers", () => {
    expect(() =>
      PostmortemSchema.parse({
        ...base,
        reviewers: ["u-rev1", "u-rev1"],
      }),
    ).toThrow(/duplicate reviewer/);
  });

  it("rejects malformed postmortem id", () => {
    expect(() => PostmortemSchema.parse({ ...base, id: "PM-42" })).toThrow();
  });
});

describe("helpers", () => {
  const item = (
    id: string,
    status: ActionItem["status"],
    dueAt: string,
    prevent: boolean = false,
  ): ActionItem => ({
    id,
    title: "x",
    description: "x",
    owner: "u-1",
    priority: prevent ? "critical" : "medium",
    status,
    createdAt: "2026-05-14T12:00:00Z",
    dueAt,
    completedAt: status === "completed" ? "2026-05-20T12:00:00Z" : null,
    blockedReason: status === "blocked" ? "x" : undefined,
    wontFixReason: status === "won_t_fix" ? "x" : undefined,
    preventsRecurrence: prevent,
  });

  const pm: Postmortem = {
    id: "PM-2026-0042",
    incidentId: "INC-2026-0042",
    title: "x",
    severity: "sev2",
    status: "published",
    summary: "x",
    rootCause: "x",
    contributingFactors: [],
    detection: "x",
    response: "x",
    impact: "x",
    whatWentWell: [],
    whatWentWrong: ["x"],
    lessonsLearned: ["x"],
    actionItems: [
      item("ai-2026-0001", "open", "2026-06-14T12:00:00Z"),
      item("ai-2026-0002", "completed", "2026-06-14T12:00:00Z"),
      item("ai-2026-0003", "in_progress", "2026-05-01T12:00:00Z"),
      item("ai-2026-0004", "open", "2026-08-14T12:00:00Z", true),
    ],
    timelineSummary: "x",
    authorUserId: "u-author",
    reviewers: ["u-rev1", "u-rev2"],
    createdAt: "2026-05-15T10:00:00Z",
    publishedAt: "2026-05-20T10:00:00Z",
    amendedAt: null,
    blamelessAttested: true,
    confidentialityClass: "internal_only",
  };

  it("openActionItems excludes completed/won_t_fix", () => {
    expect(openActionItems(pm).map((a) => a.id)).toEqual([
      "ai-2026-0001",
      "ai-2026-0003",
      "ai-2026-0004",
    ]);
  });

  it("overdueActionItems filters past-due open items", () => {
    expect(overdueActionItems(pm, new Date("2026-06-01T00:00:00Z")).map((a) => a.id)).toEqual([
      "ai-2026-0003",
    ]);
  });

  it("preventsRecurrenceItems filters preventive items", () => {
    expect(preventsRecurrenceItems(pm).map((a) => a.id)).toEqual(["ai-2026-0004"]);
  });
});
