import { describe, expect, it } from "vitest";
import {
  EMPTY_READ_STATE_INDEX,
  NotificationReadStateSchema,
  NotificationReadWatermarkSchema,
  READ_STATE_SOURCES,
  countUnread,
  indexReadState,
  isUnread,
  markAllReadUpTo,
  markRead,
  partitionByRead,
  readStateBlockers,
  readStateKey,
  supersededReadStates,
  type InboxViewer,
  type NotificationReadState,
  type NotificationReadWatermark,
} from "./read-state.js";
import type { NotificationDispatch } from "./delivery.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "33333333-3333-4333-8333-333333333333";

const viewer: InboxViewer = { tenantId: TENANT, userId: USER };

const dispatch = (
  overrides: Partial<NotificationDispatch> = {},
): NotificationDispatch => ({
  id: "disp_inbox_0001",
  tenantId: TENANT,
  templateId: "invoice_posted",
  templateVersion: "1.0.0",
  locale: "en-US",
  channel: "in_app",
  category: "transactional",
  priority: "normal",
  audienceJson: { kind: "specific_user", userId: USER },
  variablesSha256: "a".repeat(64),
  correlationId: null,
  idempotencyKey: "key-1",
  status: "completed",
  queuedAt: "2026-09-01T10:00:00.000Z",
  startedAt: null,
  completedAt: "2026-09-01T10:00:05.000Z",
  recipientCount: 1,
  deliveredCount: 1,
  failedCount: 0,
  suppressedCount: 0,
  cancelledReason: null,
  requestedBy: null,
  requestingSystem: "operate-server",
  ...overrides,
});

const state = (
  overrides: Partial<NotificationReadState> = {},
): NotificationReadState => ({
  id: "nrs_read_0001",
  tenantId: TENANT,
  userId: USER,
  dispatchId: "disp_inbox_0001",
  readAt: "2026-09-01T11:00:00.000Z",
  source: "user_action",
  ...overrides,
});

const watermark = (
  overrides: Partial<NotificationReadWatermark> = {},
): NotificationReadWatermark => ({
  tenantId: TENANT,
  userId: USER,
  readThroughAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
  source: "bulk_mark_read",
  ...overrides,
});

describe("constants", () => {
  it("has 4 read state sources", () => {
    expect(READ_STATE_SOURCES).toHaveLength(4);
  });
  it("names the backfill source the watermark design depends on", () => {
    expect(READ_STATE_SOURCES).toContain("system_backfill");
  });
  it("exposes an empty index that reads everything as unread", () => {
    expect(EMPTY_READ_STATE_INDEX.readThroughMs).toBeNull();
    expect(isUnread(dispatch(), EMPTY_READ_STATE_INDEX)).toBe(true);
  });
});

describe("NotificationReadStateSchema", () => {
  it("accepts a well-formed row", () => {
    expect(() => NotificationReadStateSchema.parse(state())).not.toThrow();
  });
  it("accepts every source", () => {
    for (const source of READ_STATE_SOURCES) {
      expect(() => NotificationReadStateSchema.parse(state({ source }))).not.toThrow();
    }
  });
  it("rejects a wrong id prefix", () => {
    expect(() =>
      NotificationReadStateSchema.parse(state({ id: "read_0001xxxx" })),
    ).toThrow();
  });
  it("rejects a dispatch id that is not a disp_ ref", () => {
    expect(() =>
      NotificationReadStateSchema.parse(state({ dispatchId: "dgst_abc12345" })),
    ).toThrow();
  });
  it("rejects a non-uuid user", () => {
    expect(() =>
      NotificationReadStateSchema.parse(state({ userId: "me" })),
    ).toThrow();
  });
  it("rejects a readAt without an offset", () => {
    expect(() =>
      NotificationReadStateSchema.parse(state({ readAt: "2026-09-01" })),
    ).toThrow();
  });
  it("rejects an unknown source", () => {
    expect(() =>
      NotificationReadStateSchema.parse({ ...state(), source: "guessed" }),
    ).toThrow();
  });
});

describe("NotificationReadWatermarkSchema", () => {
  it("accepts readThroughAt equal to updatedAt", () => {
    expect(() => NotificationReadWatermarkSchema.parse(watermark())).not.toThrow();
  });
  it("accepts readThroughAt before updatedAt", () => {
    expect(() =>
      NotificationReadWatermarkSchema.parse(
        watermark({ readThroughAt: "2026-09-01T08:00:00.000Z" }),
      ),
    ).not.toThrow();
  });
  it("rejects a watermark reaching past when it was written", () => {
    expect(() =>
      NotificationReadWatermarkSchema.parse(
        watermark({ readThroughAt: "2026-09-02T00:00:00.000Z" }),
      ),
    ).toThrow(/readThroughAt cannot be after updatedAt/);
  });
  it("rejects a missing tenant", () => {
    const { tenantId: _omitted, ...rest } = watermark();
    expect(() => NotificationReadWatermarkSchema.parse(rest)).toThrow();
  });
});

describe("readStateKey", () => {
  it("keys on all three parts", () => {
    expect(readStateKey(TENANT, USER, "disp_inbox_0001")).toBe(
      `${TENANT}|${USER}|disp_inbox_0001`,
    );
  });
  it("distinguishes the same user and notice in two tenants", () => {
    expect(readStateKey(TENANT, USER, "disp_x_00000001")).not.toBe(
      readStateKey(OTHER_TENANT, USER, "disp_x_00000001"),
    );
  });
});

describe("indexReadState", () => {
  it("collects this viewer's read dispatch ids", () => {
    const index = indexReadState(viewer, [state()], []);
    expect(index.readDispatchIds.has("disp_inbox_0001")).toBe(true);
  });
  it("ignores another user's read state", () => {
    const index = indexReadState(viewer, [state({ userId: OTHER_USER })], []);
    expect(index.readDispatchIds.size).toBe(0);
  });
  it("ignores the same user id under another tenant", () => {
    const index = indexReadState(viewer, [state({ tenantId: OTHER_TENANT })], []);
    expect(index.readDispatchIds.size).toBe(0);
  });
  it("takes the latest of several watermarks", () => {
    const index = indexReadState(viewer, [], [
      watermark({ readThroughAt: "2026-09-01T06:00:00.000Z" }),
      watermark({ readThroughAt: "2026-09-01T12:00:00.000Z" }),
      watermark({ readThroughAt: "2026-09-01T09:00:00.000Z" }),
    ]);
    expect(index.readThroughMs).toBe(Date.parse("2026-09-01T12:00:00.000Z"));
  });
  it("ignores another tenant's watermark", () => {
    const index = indexReadState(viewer, [], [watermark({ tenantId: OTHER_TENANT })]);
    expect(index.readThroughMs).toBeNull();
  });
  it("skips an unparseable watermark instead of throwing", () => {
    const index = indexReadState(viewer, [], [
      { ...watermark(), readThroughAt: "whenever" },
    ]);
    expect(index.readThroughMs).toBeNull();
  });
  it("returns a null watermark when there are none", () => {
    expect(indexReadState(viewer, [], []).readThroughMs).toBeNull();
  });
});

describe("isUnread", () => {
  it("is false for a notice with its own read row", () => {
    expect(isUnread(dispatch(), indexReadState(viewer, [state()], []))).toBe(false);
  });
  it("is true with no read state at all", () => {
    expect(isUnread(dispatch(), indexReadState(viewer, [], []))).toBe(true);
  });
  it("is false for a notice queued before the watermark", () => {
    const index = indexReadState(viewer, [], [watermark()]);
    expect(isUnread(dispatch({ queuedAt: "2026-09-01T10:00:00.000Z" }), index)).toBe(
      false,
    );
  });
  it("is true for a notice queued after the watermark", () => {
    const index = indexReadState(viewer, [], [watermark()]);
    expect(isUnread(dispatch({ queuedAt: "2026-09-01T13:00:00.000Z" }), index)).toBe(
      true,
    );
  });
  it("treats a notice queued exactly at the watermark as read", () => {
    const index = indexReadState(viewer, [], [watermark()]);
    expect(isUnread(dispatch({ queuedAt: "2026-09-01T12:00:00.000Z" }), index)).toBe(
      false,
    );
  });
  it("shows a notice whose queuedAt cannot be parsed rather than hiding it", () => {
    const index = indexReadState(viewer, [], [watermark()]);
    expect(isUnread(dispatch({ queuedAt: "sometime" }), index)).toBe(true);
  });
  it("does not depend on recency once a watermark exists", () => {
    // The whole point: an old notice read, a new notice unread, decided by record and not by order.
    const index = indexReadState(viewer, [], [watermark()]);
    const old = dispatch({ id: "disp_old_00000001", queuedAt: "2026-01-01T00:00:00.000Z" });
    const fresh = dispatch({ id: "disp_new_00000001", queuedAt: "2026-12-01T00:00:00.000Z" });
    expect(isUnread(old, index)).toBe(false);
    expect(isUnread(fresh, index)).toBe(true);
  });
});

describe("partitionByRead / countUnread", () => {
  const a = dispatch({ id: "disp_aaa_00000001", queuedAt: "2026-09-01T09:00:00.000Z" });
  const b = dispatch({ id: "disp_bbb_00000001", queuedAt: "2026-09-01T14:00:00.000Z" });
  const c = dispatch({ id: "disp_ccc_00000001", queuedAt: "2026-09-01T15:00:00.000Z" });

  it("splits on the watermark and the rows together", () => {
    const index = indexReadState(
      viewer,
      [state({ dispatchId: "disp_ccc_00000001", id: "nrs_read_0002" })],
      [watermark()],
    );
    const part = partitionByRead([a, b, c], index);
    expect(part.read.map((d) => d.id)).toEqual(["disp_aaa_00000001", "disp_ccc_00000001"]);
    expect(part.unread.map((d) => d.id)).toEqual(["disp_bbb_00000001"]);
  });
  it("preserves the caller's order within each side", () => {
    const part = partitionByRead([c, b, a], indexReadState(viewer, [], [watermark()]));
    expect(part.unread.map((d) => d.id)).toEqual([
      "disp_ccc_00000001",
      "disp_bbb_00000001",
    ]);
  });
  it("counts unread consistently with the partition", () => {
    const index = indexReadState(viewer, [], [watermark()]);
    expect(countUnread([a, b, c], index)).toBe(
      partitionByRead([a, b, c], index).unread.length,
    );
  });
  it("counts nothing for an empty inbox", () => {
    expect(countUnread([], EMPTY_READ_STATE_INDEX)).toBe(0);
  });
  it("counts everything with no read state", () => {
    expect(countUnread([a, b, c], EMPTY_READ_STATE_INDEX)).toBe(3);
  });
});

describe("markRead", () => {
  it("builds a schema-valid row from the viewer and the notice", () => {
    const made = markRead({
      viewer,
      dispatch: dispatch(),
      id: "nrs_read_0009",
      now: new Date("2026-09-01T11:30:00.000Z"),
      source: "user_action",
    });
    expect(made.dispatchId).toBe("disp_inbox_0001");
    expect(made.readAt).toBe("2026-09-01T11:30:00.000Z");
    expect(() => NotificationReadStateSchema.parse(made)).not.toThrow();
  });
  it("returns the existing row unchanged — first read wins", () => {
    const existing = state({ readAt: "2026-09-01T10:30:00.000Z" });
    const made = markRead({
      viewer,
      dispatch: dispatch(),
      id: "nrs_read_0010",
      now: new Date("2026-09-05T00:00:00.000Z"),
      source: "user_action",
      existing,
    });
    expect(made).toBe(existing);
    expect(made.readAt).toBe("2026-09-01T10:30:00.000Z");
  });
  it("refuses an id that is not a read-state ref", () => {
    expect(() =>
      markRead({
        viewer,
        dispatch: dispatch(),
        id: "bogus",
        now: new Date("2026-09-01T11:30:00.000Z"),
        source: "user_action",
      }),
    ).toThrow();
  });
  it("uses the injected instant and no ambient clock", () => {
    const made = markRead({
      viewer,
      dispatch: dispatch(),
      id: "nrs_read_0011",
      now: new Date(0),
      source: "digest_rollup",
    });
    expect(made.readAt).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("markAllReadUpTo", () => {
  it("writes a watermark at the requested position", () => {
    const made = markAllReadUpTo({
      viewer,
      upTo: new Date("2026-09-01T12:00:00.000Z"),
      now: new Date("2026-09-01T12:00:00.000Z"),
      source: "bulk_mark_read",
    });
    expect(made.readThroughAt).toBe("2026-09-01T12:00:00.000Z");
    expect(() => NotificationReadWatermarkSchema.parse(made)).not.toThrow();
  });
  it("clamps a future upTo to now", () => {
    const made = markAllReadUpTo({
      viewer,
      upTo: new Date("2030-01-01T00:00:00.000Z"),
      now: new Date("2026-09-01T12:00:00.000Z"),
      source: "bulk_mark_read",
    });
    expect(made.readThroughAt).toBe("2026-09-01T12:00:00.000Z");
  });
  it("never moves backwards when a later watermark already exists", () => {
    const made = markAllReadUpTo({
      viewer,
      upTo: new Date("2026-09-01T06:00:00.000Z"),
      now: new Date("2026-09-01T18:00:00.000Z"),
      source: "bulk_mark_read",
      existing: watermark({ readThroughAt: "2026-09-01T12:00:00.000Z" }),
    });
    expect(made.readThroughAt).toBe("2026-09-01T12:00:00.000Z");
    expect(made.updatedAt).toBe("2026-09-01T18:00:00.000Z");
  });
  it("advances past an earlier watermark", () => {
    const made = markAllReadUpTo({
      viewer,
      upTo: new Date("2026-09-01T18:00:00.000Z"),
      now: new Date("2026-09-01T18:00:00.000Z"),
      source: "bulk_mark_read",
      existing: watermark({ readThroughAt: "2026-09-01T12:00:00.000Z" }),
    });
    expect(made.readThroughAt).toBe("2026-09-01T18:00:00.000Z");
  });
  it("ignores an unparseable existing watermark rather than failing the mark", () => {
    const made = markAllReadUpTo({
      viewer,
      upTo: new Date("2026-09-01T18:00:00.000Z"),
      now: new Date("2026-09-01T18:00:00.000Z"),
      source: "bulk_mark_read",
      existing: { ...watermark(), readThroughAt: "nope" },
    });
    expect(made.readThroughAt).toBe("2026-09-01T18:00:00.000Z");
  });
  it("marks the whole backlog read in one row, which is the point", () => {
    const made = markAllReadUpTo({
      viewer,
      upTo: new Date("2026-09-01T18:00:00.000Z"),
      now: new Date("2026-09-01T18:00:00.000Z"),
      source: "system_backfill",
    });
    const index = indexReadState(viewer, [], [made]);
    const backlog = [
      dispatch({ id: "disp_1_000000001", queuedAt: "2025-01-01T00:00:00.000Z" }),
      dispatch({ id: "disp_2_000000001", queuedAt: "2026-05-01T00:00:00.000Z" }),
    ];
    expect(countUnread(backlog, index)).toBe(0);
  });
});

describe("readStateBlockers", () => {
  it("reports nothing for a matching pair", () => {
    expect(readStateBlockers(state(), dispatch())).toEqual([]);
  });
  it("reports a row naming another notice", () => {
    const blockers = readStateBlockers(
      state({ dispatchId: "disp_other_00001" }),
      dispatch(),
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("disp_other_00001");
  });
  it("reports a tenant mismatch", () => {
    expect(
      readStateBlockers(state({ tenantId: OTHER_TENANT }), dispatch()),
    ).toHaveLength(1);
  });
  it("reports a read that predates the notice", () => {
    const blockers = readStateBlockers(
      state({ readAt: "2026-08-01T00:00:00.000Z" }),
      dispatch(),
    );
    expect(blockers[0]).toContain("precedes queuedAt");
  });
  it("accumulates several blockers", () => {
    expect(
      readStateBlockers(
        state({ tenantId: OTHER_TENANT, readAt: "2026-08-01T00:00:00.000Z" }),
        dispatch(),
      ),
    ).toHaveLength(2);
  });
  it("reports nothing on an unparseable timestamp rather than guessing", () => {
    expect(readStateBlockers(state(), dispatch({ queuedAt: "soon" }))).toEqual([]);
  });
});

describe("supersededReadStates", () => {
  const positions = new Map([
    ["disp_old_00000001", "2026-09-01T06:00:00.000Z"],
    ["disp_new_00000001", "2026-09-01T18:00:00.000Z"],
  ]);

  it("names the rows the watermark already covers", () => {
    const rows = [
      state({ id: "nrs_a_00000001", dispatchId: "disp_old_00000001" }),
      state({ id: "nrs_b_00000001", dispatchId: "disp_new_00000001" }),
    ];
    expect(
      supersededReadStates(rows, watermark(), positions).map((r) => r.dispatchId),
    ).toEqual(["disp_old_00000001"]);
  });
  it("keeps a row whose position the caller could not supply", () => {
    const rows = [state({ dispatchId: "disp_unknown_0001" })];
    expect(supersededReadStates(rows, watermark(), positions)).toEqual([]);
  });
  it("ignores another viewer's rows", () => {
    const rows = [
      state({ userId: OTHER_USER, dispatchId: "disp_old_00000001" }),
      state({ tenantId: OTHER_TENANT, dispatchId: "disp_old_00000001" }),
    ];
    expect(supersededReadStates(rows, watermark(), positions)).toEqual([]);
  });
  it("returns nothing for an unparseable watermark", () => {
    const rows = [state({ dispatchId: "disp_old_00000001" })];
    expect(
      supersededReadStates(rows, { ...watermark(), readThroughAt: "x" }, positions),
    ).toEqual([]);
  });
  it("leaves the read answer unchanged when the rows are dropped", () => {
    const rows = [state({ dispatchId: "disp_old_00000001" })];
    const mark = watermark();
    const before = indexReadState(viewer, rows, [mark]);
    const kept = rows.filter((r) => !supersededReadStates(rows, mark, positions).includes(r));
    const after = indexReadState(viewer, kept, [mark]);
    const old = dispatch({ id: "disp_old_00000001", queuedAt: "2026-09-01T06:00:00.000Z" });
    expect(isUnread(old, before)).toBe(isUnread(old, after));
  });
});
