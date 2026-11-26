import { describe, expect, it } from "vitest";

import {
  DIGEST_TEMPLATE_ID,
  SETUP_NOTICE_TEMPLATE_IDS,
  UNREAD_PARTITION_WINDOW_MAX,
  extendPartitionOnto,
  fetchUnreadPartitionCovering,
  mergeNoticePages,
  mergeUnreadPartitions,
  partitionPagesAfter,
  toUnreadCount,
  toUnreadPartition,
  unreadCountLabel,
  type TenantNotification,
  type UnreadPartition,
  type UnreadPartitionWindow,
} from "./notifications";

function notice(dispatchId: string, queuedAt: string, templateId = DIGEST_TEMPLATE_ID): TenantNotification {
  return {
    dispatchId,
    templateId,
    channel: "in_app",
    category: "system",
    priority: "normal",
    correlationId: null,
    status: "delivered",
    queuedAt,
    requestingSystem: "operate",
  };
}

function partition(over: Partial<UnreadPartition> = {}): UnreadPartition {
  return {
    unread: 0,
    exact: true,
    readThroughAt: null,
    scope: "self",
    readIds: new Set<string>(),
    unreadIds: new Set<string>(),
    examined: 0,
    nextCursor: null,
    ...over,
  };
}

describe("/setup reads per template (ADR-0385 Q7)", () => {
  it("asks for both decision templates and the digest", () => {
    expect([...SETUP_NOTICE_TEMPLATE_IDS].sort()).toEqual(
      ["design_review.approved", "design_review.rejected", DIGEST_TEMPLATE_ID].sort(),
    );
  });

  it("merges per-template pages newest first, once per dispatch", () => {
    const a = notice("d1", "2026-11-01T00:00:00.000Z", "design_review.approved");
    const b = notice("d2", "2026-11-03T00:00:00.000Z", "design_review.rejected");
    const c = notice("d3", "2026-11-02T00:00:00.000Z");
    const merged = mergeNoticePages([[a], [b, a], [c]]);
    expect(merged.map((n) => n.dispatchId)).toEqual(["d2", "d3", "d1"]);
  });
});

describe("the unread count is exact (ADR-0476, read by ADR-0478)", () => {
  it("reads `exact` from the body rather than assuming it", () => {
    expect(toUnreadCount({ unread: 227, exact: true, readThroughAt: null, scope: "self" })).toEqual({
      unread: 227,
      exact: true,
      readThroughAt: null,
      scope: "self",
    });
    // A server a build behind answered a page scan, so its figure is a floor.
    expect(toUnreadCount({ unread: 200, truncated: true }).exact).toBe(false);
  });

  it("renders a floor only when the server did not say the figure is exact", () => {
    expect(unreadCountLabel({ unread: 227, exact: true, readThroughAt: null, scope: "self" })).toBe("227 unread");
    expect(unreadCountLabel({ unread: 200, exact: false, readThroughAt: null, scope: "self" })).toBe(
      "200+ unread",
    );
  });

  it("keeps the partition's window and cursor on the partition", () => {
    const p = toUnreadPartition({
      unread: 3,
      exact: true,
      notices: { read: ["r1"], unread: ["u1", "u2", 7, ""] },
      examined: 3,
      nextCursor: "c2",
    });
    expect([...p.readIds]).toEqual(["r1"]);
    expect([...p.unreadIds]).toEqual(["u1", "u2"]);
    expect(p.examined).toBe(3);
    expect(p.nextCursor).toBe("c2");
    expect(toUnreadPartition({ unread: 0, nextCursor: "" }).nextCursor).toBeNull();
  });
});

describe("mergeUnreadPartitions", () => {
  it("takes the newer answer for an id both pages place", () => {
    const merged = mergeUnreadPartitions(
      partition({ unread: 2, unreadIds: new Set(["a", "b"]), examined: 2, nextCursor: "c" }),
      partition({ unread: 1, readIds: new Set(["a"]), unreadIds: new Set(["z"]), examined: 1, nextCursor: null }),
    );
    expect([...merged.readIds].sort()).toEqual(["a"]);
    expect([...merged.unreadIds].sort()).toEqual(["b", "z"]);
    expect(merged.unread).toBe(1);
    expect(merged.examined).toBe(3);
    expect(merged.nextCursor).toBeNull();
  });
});

describe("fetchUnreadPartitionCovering", () => {
  /** A listing of `total` notices, read state alternating, paged by the server's own cursor. */
  function server(total: number): {
    calls: UnreadPartitionWindow[];
    fetch: (c: string | undefined, w: UnreadPartitionWindow) => Promise<UnreadPartition>;
  } {
    const calls: UnreadPartitionWindow[] = [];
    return {
      calls,
      fetch: async (_c, w) => {
        calls.push(w);
        const start = w.cursor === undefined ? 0 : Number(w.cursor);
        const limit = w.limit ?? UNREAD_PARTITION_WINDOW_MAX;
        if (limit > UNREAD_PARTITION_WINDOW_MAX) throw new Error("400: a wider window is refused");
        const ids = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => `n${start + i}`);
        const end = start + ids.length;
        return partition({
          unread: Math.ceil(total / 2),
          readIds: new Set(ids.filter((_, i) => (start + i) % 2 === 1)),
          unreadIds: new Set(ids.filter((_, i) => (start + i) % 2 === 0)),
          examined: ids.length,
          nextCursor: end < total ? String(end) : null,
        });
      },
    };
  }

  it("covers every loaded row past one window, paging with the server's cursor", async () => {
    const s = server(450);
    const p = await fetchUnreadPartitionCovering("in_app", 450, null, s.fetch);
    expect(p.examined).toBe(450);
    expect(p.readIds.size + p.unreadIds.size).toBe(450);
    expect(p.unreadIds.has("n448")).toBe(true);
    expect(s.calls).toEqual([{ limit: 200 }, { limit: 200, cursor: "200" }, { limit: 50, cursor: "400" }]);
  });

  it("stops at the end of the listing", async () => {
    const s = server(30);
    const p = await fetchUnreadPartitionCovering("in_app", 50, null, s.fetch);
    expect(p.examined).toBe(30);
    expect(p.nextCursor).toBeNull();
    expect(s.calls).toHaveLength(1);
  });

  it("extends a partition already held rather than re-reading it", async () => {
    const s = server(120);
    const first = await fetchUnreadPartitionCovering("in_app", 50, null, s.fetch);
    const extended = await fetchUnreadPartitionCovering("in_app", 100, first, s.fetch);
    expect(extended.examined).toBe(100);
    expect(s.calls).toEqual([{ limit: 50 }, { limit: 50, cursor: "50" }]);
  });

  it("does not loop on an empty page that carries a cursor", async () => {
    let calls = 0;
    const p = await fetchUnreadPartitionCovering("in_app", 50, null, async () => {
      calls += 1;
      return partition({ examined: 0, nextCursor: "again" });
    });
    expect(calls).toBe(1);
    expect(p.examined).toBe(0);
  });
});

describe("extendPartitionOnto (an extension landing on a page that moved on)", () => {
  const base = partition({ unread: 2, unreadIds: new Set(["a", "b"]), examined: 2, nextCursor: "2" });
  const added = partition({ unread: 2, unreadIds: new Set(["c"]), examined: 1, nextCursor: null });

  it("keeps a per-row mark made while the extension was in flight", () => {
    // `a` was marked read after the extension started: the page holds `current`, not `base`.
    const current = { ...base, readIds: new Set(["a"]), unreadIds: new Set(["b"]), unread: 1 };
    const out = extendPartitionOnto(current, base, added);
    expect([...(out?.readIds ?? [])]).toEqual(["a"]);
    expect([...(out?.unreadIds ?? [])].sort()).toEqual(["b", "c"]);
    expect(out?.examined).toBe(3);
  });

  it("drops an extension whose starting point the page has since moved past", () => {
    // A re-read that went further than `base` ends at a later cursor; laying `added` over it would
    // count `c` twice. And one that reached the end has nothing to continue.
    const reread = partition({ unread: 0, readIds: new Set(["a", "b", "c"]), examined: 3, nextCursor: "3" });
    expect(extendPartitionOnto(reread, base, added)).toBe(reread);
    const ended = { ...reread, nextCursor: null };
    expect(extendPartitionOnto(ended, base, added)).toBe(ended);
  });

  it("has nothing to extend when the page holds no partition", () => {
    expect(extendPartitionOnto(null, base, added)).toBeNull();
  });

  it("seeds a read of only the pages after the base", async () => {
    const seed = partitionPagesAfter(base);
    expect(seed.examined).toBe(0);
    expect(seed.readIds.size + seed.unreadIds.size).toBe(0);
    expect(seed.nextCursor).toBe("2");
    const calls: UnreadPartitionWindow[] = [];
    const out = await fetchUnreadPartitionCovering("in_app", 1, seed, async (_c, w) => {
      calls.push(w);
      return added;
    });
    expect(calls).toEqual([{ limit: 1, cursor: "2" }]);
    expect([...out.unreadIds]).toEqual(["c"]);
  });
});
