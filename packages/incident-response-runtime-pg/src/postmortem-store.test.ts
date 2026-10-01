import { describe, expect, it } from "vitest";
import { PostmortemSchema, type Postmortem } from "@crossengin/incident-response";

import {
  POSTMORTEM_COLUMN_NAMES,
  POSTMORTEM_JSONB_COLUMNS,
  PostgresPostmortemStore,
  PostmortemNotFoundError,
  postmortemPlaceholders,
  postmortemRowValues,
  postmortemUpdateAssignments,
  rowToPostmortem,
} from "./postmortem-store.js";
import { EMPTY, mockConnection, respondTo, type Captured } from "./test-fakes.js";

const T0 = "2026-09-30T10:00:00.000Z";
const T1 = "2026-10-02T10:00:00.000Z";

const ACTION_ITEM = {
  id: "ai-2026-0001",
  title: "Add a burn-rate alert",
  description: "Multi-window burn-rate alert on the checkout SLO",
  owner: "sre-1",
  priority: "high",
  status: "open",
  createdAt: T0,
  dueAt: T1,
};

function postmortem(over: Record<string, unknown> = {}): Postmortem {
  return PostmortemSchema.parse({
    id: "PM-2026-0007",
    incidentId: "INC-2026-0007",
    title: "Checkout latency",
    severity: "sev3",
    status: "drafting",
    summary: "Checkout p95 exceeded its budget for 40 minutes.",
    rootCause: "An unindexed predicate on the cart table.",
    detection: "Burn-rate alert at 14.4x.",
    response: "Rolled back the release and added the index.",
    impact: "Degraded checkout for 12 tenants.",
    whatWentWrong: ["alerting fired 9 minutes late"],
    lessonsLearned: ["index changes need a query plan review"],
    timelineSummary: "10:00 declared, 10:40 mitigated.",
    authorUserId: "author-1",
    createdAt: T0,
    blamelessAttested: true,
    confidentialityClass: "internal_only",
    ...over,
  });
}

function published(over: Record<string, unknown> = {}): Postmortem {
  return postmortem({
    status: "published",
    publishedAt: T1,
    reviewers: ["reviewer-1", "reviewer-2"],
    ...over,
  });
}

/** The row a stored postmortem comes back as, built through the projection the store writes. */
function postmortemRow(record: Postmortem): Record<string, unknown> {
  const values = postmortemRowValues(record);
  const row: Record<string, unknown> = {};
  POSTMORTEM_COLUMN_NAMES.forEach((col, i) => {
    row[col] = values[i];
  });
  return row;
}

describe("column projection", () => {
  it("places the business key first, so an UPDATE can match on $1", () => {
    expect(POSTMORTEM_COLUMN_NAMES[0]).toBe("postmortem_id");
  });

  it("supplies exactly one value per column", () => {
    expect(postmortemRowValues(published())).toHaveLength(POSTMORTEM_COLUMN_NAMES.length);
  });

  it("casts only the JSONB columns", () => {
    const placeholders = postmortemPlaceholders().split(", ");
    placeholders.forEach((p, i) => {
      const col = POSTMORTEM_COLUMN_NAMES[i] ?? "";
      expect(p.endsWith("::jsonb")).toBe(POSTMORTEM_JSONB_COLUMNS.has(col));
    });
  });

  it("omits the key from the UPDATE assignments and starts them at $2", () => {
    const assignments = postmortemUpdateAssignments();
    expect(assignments).not.toContain("postmortem_id =");
    expect(assignments.startsWith("incident_id = $2")).toBe(true);
  });

  it("assigns every non-key column exactly once", () => {
    expect(postmortemUpdateAssignments().split(", ")).toHaveLength(
      POSTMORTEM_COLUMN_NAMES.length - 1,
    );
  });

  it("binds absent storage fields as NULL", () => {
    const values = postmortemRowValues(postmortem());
    expect(values[POSTMORTEM_COLUMN_NAMES.indexOf("storage_uri")]).toBeNull();
    expect(values[POSTMORTEM_COLUMN_NAMES.indexOf("storage_sha256")]).toBeNull();
  });

  it("refuses to project a record the contract rejects", () => {
    const bad = { ...published(), reviewers: ["reviewer-1"] } as Postmortem;
    expect(() => postmortemRowValues(bad)).toThrow(/at least 2 reviewers/);
  });
});

describe("insert", () => {
  it("writes every column with the derived placeholder list", async () => {
    const capture: Captured[] = [];
    const store = new PostgresPostmortemStore(mockConnection(capture));
    const record = published();
    expect(await store.insert(record)).toBe(record);
    expect(capture[0]?.sql).toContain("INSERT INTO meta.incident_postmortems");
    expect(capture[0]?.sql).toContain(POSTMORTEM_COLUMN_NAMES.join(", "));
    expect(capture[0]?.params).toHaveLength(POSTMORTEM_COLUMN_NAMES.length);
  });

  it("binds the contract id into postmortem_id, not the surrogate uuid", async () => {
    const capture: Captured[] = [];
    await new PostgresPostmortemStore(mockConnection(capture)).insert(postmortem());
    expect(capture[0]?.params?.[0]).toBe("PM-2026-0007");
  });

  it("refuses a postmortem whose author reviewed it, before any SQL runs", async () => {
    const capture: Captured[] = [];
    const store = new PostgresPostmortemStore(mockConnection(capture));
    const bad = { ...published(), reviewers: ["reviewer-1", "author-1"] } as Postmortem;
    await expect(store.insert(bad)).rejects.toThrow(/author cannot be a reviewer/);
    expect(capture).toHaveLength(0);
  });
});

describe("update", () => {
  it("matches on postmortem_id and assigns the remaining columns", async () => {
    const capture: Captured[] = [];
    await new PostgresPostmortemStore(mockConnection(capture)).update(published());
    expect(capture[0]?.sql).toContain("UPDATE meta.incident_postmortems SET");
    expect(capture[0]?.sql).toContain("WHERE postmortem_id = $1");
  });

  it("binds the same value list as an insert, with no extra guard parameter", async () => {
    const capture: Captured[] = [];
    const record = published();
    await new PostgresPostmortemStore(mockConnection(capture)).update(record);
    expect(capture[0]?.params).toEqual(postmortemRowValues(record));
  });

  it("treats a zero-row update as a missing row, named in the error", async () => {
    const conn = mockConnection(undefined, respondTo([["UPDATE", EMPTY]]));
    const store = new PostgresPostmortemStore(conn);
    await expect(store.update(published())).rejects.toThrow(PostmortemNotFoundError);
    await expect(store.update(published())).rejects.toThrow(/'PM-2026-0007'/);
  });

  it("refuses a publish with its publishedAt cleared, before any SQL runs", async () => {
    const capture: Captured[] = [];
    const store = new PostgresPostmortemStore(mockConnection(capture));
    const bad = { ...published(), publishedAt: null } as Postmortem;
    await expect(store.update(bad)).rejects.toThrow(/requires publishedAt/);
    expect(capture).toHaveLength(0);
  });
});

describe("load", () => {
  it("selects by postmortem_id and round-trips the record", async () => {
    const record = published();
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([["SELECT", { rows: [postmortemRow(record)], rowCount: 1 }]]),
    );
    const loaded = await new PostgresPostmortemStore(conn).load("PM-2026-0007");
    expect(loaded).toEqual(record);
    expect(capture[0]?.params).toEqual(["PM-2026-0007"]);
  });

  it("returns null for a missing postmortem", async () => {
    const conn = mockConnection(undefined, respondTo([["SELECT", EMPTY]]));
    expect(await new PostgresPostmortemStore(conn).load("PM-2026-9999")).toBeNull();
  });
});

describe("listForIncident", () => {
  it("filters by incident, newest first", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresPostmortemStore(conn).listForIncident("INC-2026-0007", 5);
    expect(capture[0]?.sql).toContain("WHERE incident_id = $1");
    expect(capture[0]?.sql).toContain("ORDER BY created_at DESC");
    expect(capture[0]?.params).toEqual(["INC-2026-0007", 5]);
  });

  it("defaults the limit to 100", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresPostmortemStore(conn).listForIncident("INC-2026-0007");
    expect(capture[0]?.params?.[1]).toBe(100);
  });

  it("rejects a non-positive limit before querying", async () => {
    const capture: Captured[] = [];
    const store = new PostgresPostmortemStore(mockConnection(capture));
    await expect(store.listForIncident("INC-2026-0007", 0)).rejects.toThrow(/positive/);
    expect(capture).toHaveLength(0);
  });

  it("re-validates every row it returns", async () => {
    const rows = [postmortemRow(published()), postmortemRow(postmortem())];
    const conn = mockConnection(undefined, respondTo([["SELECT", { rows, rowCount: 2 }]]));
    const loaded = await new PostgresPostmortemStore(conn).listForIncident("INC-2026-0007");
    expect(loaded.map((p) => p.status)).toEqual(["published", "drafting"]);
  });
});

describe("listUnpublished", () => {
  it("selects the pre-publication statuses, stalest first", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresPostmortemStore(conn).listUnpublished();
    expect(capture[0]?.sql).toContain("status IN ('drafting', 'review')");
    expect(capture[0]?.sql).toContain("ORDER BY created_at ASC");
  });

  it("rejects a non-positive limit", async () => {
    const store = new PostgresPostmortemStore(mockConnection());
    await expect(store.listUnpublished(-1)).rejects.toThrow(/positive/);
  });
});

describe("rowToPostmortem re-validation", () => {
  it("accepts a row the store itself wrote", () => {
    const record = published();
    expect(rowToPostmortem(postmortemRow(record))).toEqual(record);
  });

  it("omits absent optional storage fields rather than reading them back as null", () => {
    const loaded = rowToPostmortem(postmortemRow(postmortem()));
    expect("storageUri" in loaded).toBe(false);
    expect("storageSha256" in loaded).toBe(false);
  });

  it("round-trips the storage fields when present", () => {
    const record = postmortem({
      storageUri: "https://pm.example.com/PM-2026-0007",
      storageSha256: "a".repeat(64),
    });
    const loaded = rowToPostmortem(postmortemRow(record));
    expect(loaded.storageUri).toBe("https://pm.example.com/PM-2026-0007");
    expect(loaded.storageSha256).toBe("a".repeat(64));
  });

  it("reads TIMESTAMPTZ columns handed back as Date objects", () => {
    const row = { ...postmortemRow(published()), created_at: new Date(T0) };
    expect(rowToPostmortem(row).createdAt).toBe(T0);
  });

  it("reads JSONB columns handed back parsed or as text alike", () => {
    const row = postmortemRow(published());
    const parsed = {
      ...row,
      reviewers: JSON.parse(String(row["reviewers"])) as unknown,
      what_went_wrong: JSON.parse(String(row["what_went_wrong"])) as unknown,
    };
    expect(rowToPostmortem(parsed)).toEqual(rowToPostmortem(row));
  });

  it("refuses a row whose author was edited into its own reviewer list — four eyes", () => {
    const row = {
      ...postmortemRow(published()),
      reviewers: JSON.stringify(["reviewer-1", "author-1"]),
    };
    expect(() => rowToPostmortem(row)).toThrow(/author cannot be a reviewer/);
  });

  it("refuses a published row whose reviewers were trimmed to one", () => {
    const row = { ...postmortemRow(published()), reviewers: JSON.stringify(["reviewer-1"]) };
    expect(() => rowToPostmortem(row)).toThrow(/at least 2 reviewers/);
  });

  it("refuses a row with blameless attestation cleared", () => {
    const row = { ...postmortemRow(published()), blameless_attested: false };
    expect(() => rowToPostmortem(row)).toThrow(/blameless/);
  });

  it("refuses a published row with no publishedAt", () => {
    const row = { ...postmortemRow(published()), published_at: null };
    expect(() => rowToPostmortem(row)).toThrow(/requires publishedAt/);
  });

  it("refuses an amended row with no amendedAt", () => {
    const row = { ...postmortemRow(published({ status: "amended", amendedAt: T1 })), amended_at: null };
    expect(() => rowToPostmortem(row)).toThrow(/amended status requires amendedAt/);
  });

  it("refuses a sev1 row with no action items", () => {
    const record = published({ severity: "sev1", actionItems: [ACTION_ITEM] });
    const row = { ...postmortemRow(record), action_items: "[]" };
    expect(() => rowToPostmortem(row)).toThrow(/at least one action item/);
  });

  it("refuses duplicate reviewers", () => {
    const row = {
      ...postmortemRow(published()),
      reviewers: JSON.stringify(["reviewer-1", "reviewer-1"]),
    };
    expect(() => rowToPostmortem(row)).toThrow(/duplicate reviewer/);
  });

  it("refuses a critical action item that does not claim to prevent recurrence", () => {
    const row = {
      ...postmortemRow(published({ actionItems: [ACTION_ITEM] })),
      action_items: JSON.stringify([{ ...ACTION_ITEM, priority: "critical" }]),
    };
    expect(() => rowToPostmortem(row)).toThrow(/preventsRecurrence/);
  });
});
