import { describe, expect, it } from "vitest";

import {
  DEFAULT_DRAIN_PAGE_SIZE,
  DRAIN_HALT_REASONS,
  DrainDidNotTerminate,
  READ_CEILING_EFFECT,
  ReadCeilingExceeded,
  drainList,
  isReadCeilingExceeded,
  type DrainBounds,
  type DrainOutcome,
  type ReadCeilingEffect,
  type ReadCeilingPosition,
} from "./list-drain.js";
import {
  InMemoryEntityStore,
  applyListQuery,
  type EntityRecord,
  type EntityStore,
  type ListPage,
  type ListQuery,
  type ListValueType,
} from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const ENTITY = "JournalLine";

/** Ordering on a field, as every money reader that drains does. */
const QUERY: Omit<ListQuery, "cursor" | "limit"> = {
  sort: [{ field: "n", direction: "asc" }],
  filters: [],
};

function record(id: string): EntityRecord {
  return { id, n: id };
}

/**
 * Ids are zero-padded to a fixed width deliberately: lexicographic and numeric order agree on
 * them, so what these tests measure is the drain loop and never the id comparator — the
 * disagreement between the sort and the seek is `store.test.ts`'s subject, and a drain over ids
 * that reached it would fail here for a reason that has nothing to do with this module.
 */
async function seeded(rows: number): Promise<InMemoryEntityStore> {
  const store = new InMemoryEntityStore();
  for (let i = 0; i < rows; i += 1) {
    await store.create(TENANT, ENTITY, record(`r${String(i).padStart(3, "0")}`));
  }
  return store;
}

interface DrainRun {
  readonly outcome: DrainOutcome;
  /** One entry per `onPage` call, holding that call's ids. */
  readonly pages: readonly (readonly string[])[];
  /** The `limit` the drain asked the store for on each round trip. */
  readonly limits: readonly number[];
}

async function drain(
  rows: number,
  bounds: DrainBounds,
  query: Omit<ListQuery, "cursor" | "limit"> = QUERY,
): Promise<DrainRun> {
  const inner = await seeded(rows);
  const limits: number[] = [];
  const pages: string[][] = [];
  const store: Pick<EntityStore, "listPage"> = {
    listPage: async (tenantId, entity, q) => {
      limits.push(q.limit);
      return inner.listPage(tenantId, entity, q);
    },
  };
  const outcome = await drainList(store, TENANT, ENTITY, query, bounds, (records) => {
    pages.push(records.map((r) => String(r["id"])));
  });
  return { outcome, pages, limits };
}

/** A store whose answer is a function of which round trip this is — one fence's shape per fake. */
function fakeStore(answer: (call: number) => ListPage): Pick<EntityStore, "listPage"> {
  let call = 0;
  return {
    listPage: async () => {
      call += 1;
      return answer(call);
    },
  };
}

async function refusal(run: Promise<unknown>): Promise<DrainDidNotTerminate> {
  try {
    await run;
  } catch (e) {
    if (e instanceof DrainDidNotTerminate) return e;
    throw e;
  }
  throw new Error("expected the drain to refuse, and it returned an outcome");
}

describe("drainList reads the whole set", () => {
  it("visits every row exactly once across several pages", async () => {
    const { outcome, pages } = await drain(5, { ceiling: 100, pageSize: 2 });
    expect(outcome).toEqual({ complete: true, records: 5, pages: 3 });
    const visited = pages.flat();
    expect(visited).toEqual(["r000", "r001", "r002", "r003", "r004"]);
    expect(new Set(visited).size).toBe(5);
  });

  it("hands each page to onPage once, with that page's rows", async () => {
    const { pages } = await drain(5, { ceiling: 100, pageSize: 2 });
    expect(pages).toEqual([["r000", "r001"], ["r002", "r003"], ["r004"]]);
  });

  it("calls onPage for an empty set too, so a fold over nothing still runs", async () => {
    const { outcome, pages } = await drain(0, { ceiling: 10, pageSize: 2 });
    expect(outcome).toEqual({ complete: true, records: 0, pages: 1 });
    expect(pages).toEqual([[]]);
  });

  it("reads one page when the default page size covers the set", async () => {
    expect(DEFAULT_DRAIN_PAGE_SIZE).toBe(500);
    const { outcome, limits } = await drain(3, { ceiling: 10 });
    expect(outcome).toEqual({ complete: true, records: 3, pages: 1 });
    // The ceiling, not the page size, is what bounds the first limit here.
    expect(limits).toEqual([10]);
  });

  it("sends the store's own cursor back and changes nothing else about the query", async () => {
    const sent: ListQuery[] = [];
    const store: Pick<EntityStore, "listPage"> = {
      listPage: async (_tenantId, _entity, q) => {
        sent.push(q);
        return sent.length < 3
          ? {
              records: [record(`x${String(sent.length)}`)],
              nextCursor: `tok${String(sent.length)}`,
            }
          : { records: [], nextCursor: null };
      },
    };
    const query: Omit<ListQuery, "cursor" | "limit"> = {
      sort: [{ field: "posted_at", direction: "desc" }],
      filters: [{ field: "state", op: "eq", value: "completed" }],
      search: { term: "milk", fields: ["name"] },
      fields: ["id", "amount"],
      valueTypes: new Map<string, ListValueType>([["amount", "numeric"]]),
    };
    await drainList(store, TENANT, ENTITY, query, { ceiling: 50, pageSize: 1 }, () => {});
    expect(sent.map((q) => q.cursor)).toEqual([null, "tok1", "tok2"]);
    for (const q of sent) {
      expect(q.sort).toEqual(query.sort);
      expect(q.filters).toEqual(query.filters);
      expect(q.search).toEqual(query.search);
      expect(q.fields).toEqual(query.fields);
      expect(q.valueTypes).toEqual(query.valueTypes);
    }
  });
});

describe("the ceiling is reported, never silently truncated", () => {
  it("stops at the ceiling and names why", async () => {
    const { outcome } = await drain(10, { ceiling: 3, pageSize: 2 });
    expect(outcome).toEqual({
      complete: false,
      records: 3,
      pages: 2,
      haltedBy: "ceiling_reached",
    });
  });

  it("hands onPage no more than `ceiling` rows", async () => {
    const { pages } = await drain(10, { ceiling: 3, pageSize: 2 });
    expect(pages.flat()).toEqual(["r000", "r001", "r002"]);
  });

  it("clamps the last page's limit to what is left of the ceiling", async () => {
    // `Math.min(pageSize, ceiling - records)`: without it the second page would ask for 2 and the
    // drain would hand onPage 4 rows under a ceiling of 3.
    const { limits } = await drain(10, { ceiling: 3, pageSize: 2 });
    expect(limits).toEqual([2, 1]);
  });

  it("clamps a page size larger than the ceiling down to it", async () => {
    const { outcome, limits } = await drain(10, { ceiling: 3, pageSize: 500 });
    expect(limits).toEqual([3]);
    expect(outcome.haltedBy).toBe("ceiling_reached");
  });

  it("reads nothing at all at a ceiling of 0", async () => {
    const { outcome, pages, limits } = await drain(4, { ceiling: 0, pageSize: 2 });
    expect(outcome).toEqual({ complete: false, records: 0, pages: 0, haltedBy: "ceiling_reached" });
    expect(limits).toEqual([]);
    expect(pages).toEqual([]);
  });

  it("treats a negative ceiling as 0 rather than as an unbounded read", async () => {
    const { outcome, limits } = await drain(4, { ceiling: -5, pageSize: 2 });
    expect(outcome).toEqual({ complete: false, records: 0, pages: 0, haltedBy: "ceiling_reached" });
    expect(limits).toEqual([]);
  });

  it("truncates a fractional bound rather than rounding it up", async () => {
    const { outcome, limits } = await drain(10, { ceiling: 3.9, pageSize: 2.9 });
    expect(limits).toEqual([2, 1]);
    expect(outcome.records).toBe(3);
  });
});

describe("a ceiling that is an exact multiple of the page size", () => {
  // The distinction is not in the row count — both cases read exactly 4 rows in exactly 2 pages.
  // It is in the cursor of the page that exhausts the ceiling: null means that was the whole set,
  // and anything else means the ceiling was reached with rows still behind it.
  it("reports complete when the ceiling is exactly the whole set", async () => {
    expect(await drain(4, { ceiling: 4, pageSize: 2 })).toMatchObject({
      outcome: { complete: true, records: 4, pages: 2 },
    });
  });

  it("reports incomplete when one more row sits behind the ceiling", async () => {
    expect(await drain(5, { ceiling: 4, pageSize: 2 })).toMatchObject({
      outcome: { complete: false, records: 4, pages: 2, haltedBy: "ceiling_reached" },
    });
  });

  it("reads the same rows in the same pages either way", async () => {
    const whole = await drain(4, { ceiling: 4, pageSize: 2 });
    const truncated = await drain(5, { ceiling: 4, pageSize: 2 });
    expect(truncated.pages).toEqual(whole.pages);
  });
});

describe("the page budget fences a store that does not advance", () => {
  it("refuses when the store hands back the cursor it was just given", async () => {
    const err = await refusal(
      drainList(
        fakeStore(() => ({ records: [], nextCursor: "SAME" })),
        TENANT,
        ENTITY,
        QUERY,
        { ceiling: 1000, pageSize: 500 },
        () => {},
      ),
    );
    expect(err.reason).toBe("cursor_did_not_advance");
    expect(err.entity).toBe(ENTITY);
    expect(err.pages).toBe(3);
    expect(err.message).toContain(ENTITY);
    expect(err.message).toContain("cursor_did_not_advance");
  });

  it("refuses a pinned cursor that is still returning rows, so the row count cannot mask it", async () => {
    const err = await refusal(
      drainList(
        fakeStore((call) => ({ records: [record(`x${String(call)}`)], nextCursor: "SAME" })),
        TENANT,
        ENTITY,
        QUERY,
        { ceiling: 1000, pageSize: 500 },
        () => {},
      ),
    );
    expect(err.reason).toBe("cursor_did_not_advance");
  });

  it("refuses a two-cursor cycle, which advances by one token and gets nowhere", async () => {
    const err = await refusal(
      drainList(
        fakeStore((call) => ({ records: [], nextCursor: call % 2 === 1 ? "A" : "B" })),
        TENANT,
        ENTITY,
        QUERY,
        { ceiling: 1000, pageSize: 500 },
        () => {},
      ),
    );
    expect(err.reason).toBe("cursor_did_not_advance");
  });

  it("refuses a fresh cursor forever over empty pages, which no row ceiling can catch", async () => {
    // An empty page with a non-null cursor is legal (pinned below), so a store that only ever
    // returns those spends no row budget and would loop under a ceiling alone.
    const err = await refusal(
      drainList(
        fakeStore((call) => ({ records: [], nextCursor: `c${String(call)}` })),
        TENANT,
        ENTITY,
        QUERY,
        { ceiling: 10, pageSize: 5 },
        () => {},
      ),
    );
    expect(err.reason).toBe("page_budget_exhausted");
    expect(err.pages).toBe(11);
  });

  it("lets an empty page with a cursor through, because that is a legal answer", async () => {
    const outcome = await drainList(
      fakeStore((call) =>
        call === 1
          ? { records: [record("a")], nextCursor: "c1" }
          : call === 2
            ? { records: [], nextCursor: "c2" }
            : { records: [record("b")], nextCursor: null },
      ),
      TENANT,
      ENTITY,
      QUERY,
      { ceiling: 10, pageSize: 5 },
      () => {},
    );
    expect(outcome).toEqual({ complete: true, records: 2, pages: 3 });
  });

  it("lets a store hand out short pages without tripping the budget", async () => {
    // Two pages of 2 against `ceiling: 4, pageSize: 4`, so the drain takes more round trips than
    // `ceil(ceiling / pageSize)` on a set it reads in full. That is what the budget's slack is
    // for, and with the slack removed this refuses `page_budget_exhausted` at one page.
    const outcome = await drainList(
      fakeStore((call) =>
        call === 1
          ? { records: [record("a"), record("b")], nextCursor: "c1" }
          : { records: [record("c"), record("d")], nextCursor: null },
      ),
      TENANT,
      ENTITY,
      QUERY,
      { ceiling: 4, pageSize: 4 },
      () => {},
    );
    expect(outcome).toEqual({ complete: true, records: 4, pages: 2 });
  });

  it("names a reason from the declared vocabulary, and the ceiling is the one that is not a fault", async () => {
    const err = await refusal(
      drainList(
        fakeStore(() => ({ records: [], nextCursor: "SAME" })),
        TENANT,
        ENTITY,
        QUERY,
        { ceiling: 1000, pageSize: 500 },
        () => {},
      ),
    );
    expect(DRAIN_HALT_REASONS).toContain(err.reason);
    expect(err.reason).not.toBe("ceiling_reached");
    expect([...DRAIN_HALT_REASONS]).toEqual([
      "ceiling_reached",
      "cursor_did_not_advance",
      "page_budget_exhausted",
    ]);
  });

  it("lets an onPage failure out rather than reporting a complete drain", async () => {
    await expect(
      drainList(await seeded(4), TENANT, ENTITY, QUERY, { ceiling: 10, pageSize: 2 }, () => {
        throw new Error("the fold refused this page");
      }),
    ).rejects.toThrow("the fold refused this page");
  });
});

describe("the page size is floored at 1", () => {
  it("floors a page size of 0 rather than reading nothing", async () => {
    const { outcome, limits, pages } = await drain(3, { ceiling: 5, pageSize: 0 });
    expect(outcome).toEqual({ complete: true, records: 3, pages: 3 });
    expect(limits).toEqual([1, 1, 1]);
    expect(pages.flat()).toEqual(["r000", "r001", "r002"]);
  });

  it("floors a negative page size, which is what keeps the page budget positive", async () => {
    // The floor's observable job is the *budget* rather than the limit, because the limit is
    // floored again where it is built. Unfloored, `Math.ceil(50 / -3)` is −16, so the budget is
    // negative and `pages >= pageBudget` refuses at page zero: measured, this drain reports
    // `page_budget_exhausted` over a set it reads in full.
    const { outcome, limits } = await drain(20, { ceiling: 50, pageSize: -3 });
    expect(outcome).toEqual({ complete: true, records: 20, pages: 20 });
    expect(limits).toEqual(Array.from({ length: 20 }, () => 1));
  });

  it("a limit of 0 really does answer a null cursor, which is what the floor is for", () => {
    // The trap, in one assertion: `nextCursor` is built from the last row of the slice and a
    // `limit: 0` slice has none, so an unfloored 0 would read nothing, see the end-of-set signal
    // and report `complete: true` over an empty read — a figure computed from no rows at all.
    const page = applyListQuery([record("a"), record("b"), record("c")], {
      limit: 0,
      cursor: null,
      sort: [],
      filters: [],
    });
    expect(page.records).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("READ_CEILING_EFFECT", () => {
  it("is total over the positions, so a fourth cannot inherit an arm", () => {
    // Total at compile time: a new key on the map widens `ReadCeilingPosition`, which leaves this
    // annotated literal incomplete and fails `typecheck` — where a value-level count alone would
    // pass as soon as somebody added the key without deciding what it does.
    const byPosition: Readonly<Record<ReadCeilingPosition, ReadCeilingEffect>> = {
      guard: "refuses",
      effect: "aborts",
      report: "declares",
    };
    expect(byPosition).toEqual(READ_CEILING_EFFECT);
    expect(Object.keys(READ_CEILING_EFFECT).sort()).toEqual(["effect", "guard", "report"]);
  });

  it("gives every position a distinct arm", () => {
    const arms = Object.values(READ_CEILING_EFFECT);
    expect(new Set(arms).size).toBe(arms.length);
  });

  it("refuses from a guard, aborts an effect and declares in a report", () => {
    expect(READ_CEILING_EFFECT.guard).toBe("refuses");
    expect(READ_CEILING_EFFECT.effect).toBe("aborts");
    expect(READ_CEILING_EFFECT.report).toBe("declares");
  });
});

describe("ReadCeilingExceeded", () => {
  const err = new ReadCeilingExceeded(ENTITY, 50_000, "the entry's debit/credit balance");

  it("carries the entity, the ceiling and what could not be computed", () => {
    expect(err.name).toBe("ReadCeilingExceeded");
    expect(err.entity).toBe(ENTITY);
    expect(err.ceiling).toBe(50_000);
    expect(err.computing).toBe("the entry's debit/credit balance");
  });

  it("names all three in the message, the only diagnosis that reaches an operator", () => {
    // `writeTxn`'s catch answers a fixed `500 {error: "write_failed"}` and the message reaches no
    // recorder, so a refusal that did not name itself here would name itself nowhere.
    expect(err.message).toContain(ENTITY);
    expect(err.message).toContain("50000");
    expect(err.message).toContain("the entry's debit/credit balance");
  });

  it("is recognised by shape, and a lookalike is not", () => {
    expect(isReadCeilingExceeded(err)).toBe(true);
    expect(isReadCeilingExceeded(new Error("read too much"))).toBe(false);
    expect(isReadCeilingExceeded(new DrainDidNotTerminate(ENTITY, "ceiling_reached", 2))).toBe(
      false,
    );
    expect(isReadCeilingExceeded(null)).toBe(false);
    expect(isReadCeilingExceeded({ name: "ReadCeilingExceeded", entity: ENTITY, ceiling: 1 })).toBe(
      false,
    );
  });
});

describe("every in-repo refusal carries a literal, not a record value", () => {
  // `handlers.ts` puts `computing` straight into a 500 body, and the comment authorising that says
  // the refusal carries "no row, no value, no tenant". That is a claim about every construction
  // site in the package, not about this class — so it is checked here rather than asserted there.
  // The first version of these six interpolated a document number, a period label and once a record
  // id, which is exactly the shape the comment denies.
  const SOURCES = ["write-effects.ts"] as const;

  it("builds `computing` from a string literal at every site", async () => {
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sites: string[] = [];
    for (const file of SOURCES) {
      const text = await fs.readFile(path.join(here, file), "utf8");
      for (const m of text.matchAll(/new ReadCeilingExceeded\(([^;]*?)\);/gs)) {
        sites.push(m[1]!.replace(/\s+/g, " ").trim());
      }
    }
    // Vacuity floor: if the matcher stopped matching, this test would pass having examined nothing.
    expect(sites.length).toBeGreaterThanOrEqual(6);
    for (const args of sites) {
      // The third argument begins after the entity and the ceiling. A template literal is what
      // interpolation needs, so its absence is the checkable form of "carries no record value".
      const third = args.split(",").slice(2).join(",").trim();
      expect(third, `computing argument: ${third}`).toMatch(/^(["'])(?:(?!\1).)*\1$/);
    }
  });
});
