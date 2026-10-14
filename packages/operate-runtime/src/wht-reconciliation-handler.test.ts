import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { RoleName } from "@crossengin/auth";
import { describe, expect, it } from "vitest";

import {
  buildWhtReconciliationHandler,
  type WhtReconciliationResponse,
} from "./wht-reconciliation-handler.js";
import { InMemoryEntityStore, type ListFilter, type ListPage, type ListQuery } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

const principalRoles = (p: ResolvedPrincipal | null) => ({
  primaryRole: p?.grantedScopes[0] ?? "anonymous",
});

function principal(role: string): ResolvedPrincipal {
  return {
    principalId: "00000000-0000-4000-8000-0000000000aa",
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [role],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

function buildHandler(store: InMemoryEntityStore, maxRows?: number) {
  return buildWhtReconciliationHandler({
    store,
    principalRoles,
    viewerRoles: new Set<RoleName>(["erp_admin" as RoleName]),
    ...(maxRows !== undefined ? { maxRows } : {}),
  });
}

async function invoke(
  handler: ReturnType<typeof buildHandler>,
  query?: Record<string, string>,
  role = "erp_admin",
): Promise<HandlerOutput> {
  const request = buildIncomingRequest({
    id: "req_wht000000001",
    receivedAt: "2026-06-21T12:00:00.000Z",
    method: "GET",
    path: "/v1/meta/wht-reconciliation",
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.1",
    ...(query !== undefined ? { query } : {}),
  });
  return handler({
    request,
    route: {} as never,
    principal: principal(role),
    params: {},
    parsedBody: null,
  });
}

function bodyOf(out: HandlerOutput): WhtReconciliationResponse {
  if (out.kind !== "json") throw new Error("expected json");
  return out.body as WhtReconciliationResponse;
}

/** Records every list query so a pushed-down filter can be asserted on, not merely inferred. */
class RecordingStore extends InMemoryEntityStore {
  readonly queries: { readonly entity: string; readonly query: ListQuery }[] = [];
  override async listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
    this.queries.push({ entity, query });
    return super.listPage(tenantId, entity, query);
  }
  filtersFor(entity: string): readonly ListFilter[] {
    const first = this.queries.find((q) => q.entity === entity);
    if (first === undefined) throw new Error(`no query issued against ${entity}`);
    return first.query.filters;
  }
  pagesFor(entity: string): number {
    return this.queries.filter((q) => q.entity === entity).length;
  }
}

/**
 * A store that silently drops the issue-date predicate — what a store unable to express it used to
 * do, and the one condition under which the in-memory re-check is observable at all.
 */
class FilterDroppingStore extends InMemoryEntityStore {
  override async listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
    return super.listPage(tenantId, entity, {
      ...query,
      filters: query.filters.filter((f) => f.field !== "issue_date"),
    });
  }
}

/** `n` withholding invoices issued on `issueDate`, numbered from `prefix`. */
async function seedInvoices(
  store: InMemoryEntityStore,
  opts: {
    readonly n: number;
    readonly prefix: string;
    readonly issueDate: string;
    readonly withheld: number;
  },
): Promise<void> {
  for (let i = 0; i < opts.n; i += 1) {
    await store.create(TENANT, "Invoice", {
      id: `${opts.prefix}_${String(i).padStart(5, "0")}`,
      invoice_number: `${opts.prefix.toUpperCase()}-${i}`,
      withholding_total: opts.withheld,
      issue_date: opts.issueDate,
      currency: "USD",
    });
  }
}

async function seedCertificates(
  store: InMemoryEntityStore,
  n: number,
  invoiceId: string,
  amount: number,
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await store.create(TENANT, "WhtCertificate", {
      id: `cert_${String(i).padStart(5, "0")}`,
      state: "confirmed",
      amount,
      invoice_id: invoiceId,
    });
  }
}

describe("buildWhtReconciliationHandler — authorization", () => {
  it("refuses a principal with no tenant", async () => {
    const handler = buildHandler(new InMemoryEntityStore());
    const out = await handler({
      request: buildIncomingRequest({
        id: "req_wht000000002",
        receivedAt: "2026-06-21T12:00:00.000Z",
        method: "GET",
        path: "/v1/meta/wht-reconciliation",
        headers: {},
        host: "api.example.com",
        scheme: "https",
        bodyBytes: null,
        clientIp: "203.0.113.1",
      }),
      route: {} as never,
      principal: null,
      params: {},
      parsedBody: null,
    });
    expect(out).toMatchObject({ status: 401, body: { error: "tenant_required" } });
  });

  it("refuses a role outside the finance set (fail-closed)", async () => {
    const out = await invoke(buildHandler(new InMemoryEntityStore()), {}, "erp_viewer");
    expect(out).toMatchObject({ status: 403, body: { error: "forbidden" } });
  });
});

describe("buildWhtReconciliationHandler — draining both reads", () => {
  it("reconciles every withholding invoice across pages", async () => {
    // 1200 invoices of 10 withheld at the drain's 500-row page: three round trips, so a one-page
    // read of 500 would have reported 5000 of a true 12,000.
    const store = new RecordingStore();
    await seedInvoices(store, { n: 1200, prefix: "inv", issueDate: "2026-06-10", withheld: 10 });
    const body = bodyOf(await invoke(buildHandler(store)));
    expect(body.rows).toHaveLength(1200);
    expect(body.totals).toEqual({ withheld: 12_000, certified: 0, uncertified: 12_000 });
    expect(store.pagesFor("Invoice")).toBe(3);
  });

  it("sums a certificate tail that a one-page read would have dropped", async () => {
    // The direction that matters: a dropped certificate leaves `certified` too small, so a
    // fully-certified invoice is reported `partial` with a gap it does not have.
    const store = new InMemoryEntityStore();
    await seedInvoices(store, { n: 1, prefix: "inv", issueDate: "2026-06-10", withheld: 110 });
    await seedCertificates(store, 1100, "inv_00000", 0.1);
    const whole = bodyOf(await invoke(buildHandler(store)));
    expect(whole.rows[0]).toMatchObject({ certified: 110, gap: 0, status: "certified" });
    expect(whole.complete).toBe(true);

    const bounded = bodyOf(await invoke(buildHandler(store, 600)));
    expect(bounded.rows[0]).toMatchObject({ certified: 60, gap: 50, status: "partial" });
    expect(bounded.bounded).toEqual(["certificates"]);
  });

  it("holds only the invoices in the period, never the certificates", async () => {
    // The certificates fold into a per-invoice map as the pages arrive, so this read is
    // O(invoices with a certificate) however many certificates there are. One page per 500.
    const store = new RecordingStore();
    await seedInvoices(store, { n: 1, prefix: "inv", issueDate: "2026-06-10", withheld: 100 });
    await seedCertificates(store, 1100, "inv_00000", 0.05);
    await invoke(buildHandler(store));
    expect(store.pagesFor("WhtCertificate")).toBe(3);
  });
});

describe("buildWhtReconciliationHandler — the period filter reaches the query", () => {
  it("pushes ?from and ?to into the invoice filters beside the withholding bound", async () => {
    const store = new RecordingStore();
    await seedInvoices(store, { n: 1, prefix: "inv", issueDate: "2026-06-10", withheld: 10 });
    await invoke(buildHandler(store), { from: "2026-06-01", to: "2026-06-30" });
    expect(store.filtersFor("Invoice")).toEqual([
      { field: "withholding_total", op: "gt", value: "0" },
      { field: "issue_date", op: "gte", value: "2026-06-01" },
      { field: "issue_date", op: "lte", value: "2026-06-30" },
    ]);
  });

  it("pushes one bound when only one is given", async () => {
    const store = new RecordingStore();
    await seedInvoices(store, { n: 1, prefix: "inv", issueDate: "2026-06-10", withheld: 10 });
    await invoke(buildHandler(store), { from: "2026-06-01" });
    expect(store.filtersFor("Invoice")).toEqual([
      { field: "withholding_total", op: "gt", value: "0" },
      { field: "issue_date", op: "gte", value: "2026-06-01" },
    ]);
  });

  it("pushes nothing for a malformed bound and reconciles every invoice", async () => {
    // A malformed value is ignored rather than refused, which is the pre-existing contract — so it
    // must reach neither the query nor the in-memory re-check, or an unparseable `?to` would
    // silently empty the report.
    const store = new RecordingStore();
    await seedInvoices(store, { n: 2, prefix: "inv", issueDate: "2026-06-10", withheld: 10 });
    const body = bodyOf(await invoke(buildHandler(store), { from: "not-a-date", to: "2026" }));
    expect(store.filtersFor("Invoice")).toEqual([
      { field: "withholding_total", op: "gt", value: "0" },
    ]);
    expect(body.rows).toHaveLength(2);
  });

  it("answers a recent period over deep history, where a capped read answered nothing", async () => {
    // The second live defect this push closes. 5200 old withholding invoices and 3 in the current
    // month: `sort: []` leaves `ORDER BY <id> ASC` and ids are minted in time order, so the old
    // one-page read of 5000 returned the OLDEST 5000 and the in-memory period filter then removed
    // all of them — `rows: 0, withheld: 0` under a 200, for a period holding 300.
    const store = new InMemoryEntityStore();
    await seedInvoices(store, { n: 5200, prefix: "inv_a", issueDate: "2020-01-15", withheld: 10 });
    await seedInvoices(store, { n: 3, prefix: "inv_z", issueDate: "2026-06-10", withheld: 100 });
    const recent = bodyOf(
      await invoke(buildHandler(store), { from: "2026-06-01", to: "2026-06-30" }),
    );
    expect(recent.rows).toHaveLength(3);
    expect(recent.totals.withheld).toBe(300);
    expect(recent.complete).toBe(true);
    // And the bound narrows the read rather than merely correcting it: 3 rows is one page.
    const counting = new RecordingStore();
    await seedInvoices(counting, {
      n: 5200,
      prefix: "inv_a",
      issueDate: "2020-01-15",
      withheld: 10,
    });
    await seedInvoices(counting, { n: 3, prefix: "inv_z", issueDate: "2026-06-10", withheld: 100 });
    await invoke(buildHandler(counting), { from: "2026-06-01", to: "2026-06-30" });
    expect(counting.pagesFor("Invoice")).toBe(1);
  });

  it("re-checks the period in memory, so a store that drops the predicate cannot widen the report", async () => {
    // Why the belt is kept beside the push rather than replaced by it: against a store that
    // expresses the filter the two agree exactly and the re-check is invisible, so the only test
    // that can see it is one whose store discards the predicate. Without the belt this answers
    // every one of the 5203 invoices for a period holding 3.
    const store = new FilterDroppingStore();
    await seedInvoices(store, { n: 5200, prefix: "inv_a", issueDate: "2020-01-15", withheld: 10 });
    await seedInvoices(store, { n: 3, prefix: "inv_z", issueDate: "2026-06-10", withheld: 100 });
    const body = bodyOf(
      await invoke(buildHandler(store), { from: "2026-06-01", to: "2026-06-30" }),
    );
    expect(body.rows).toHaveLength(3);
    expect(body.totals.withheld).toBe(300);
    expect(body.complete).toBe(true);
  });

  it("bounds the read from above as well as below", async () => {
    // What the `lte` push buys beyond correctness, which the belt already covers: history on BOTH
    // sides of the period. With only the lower bound pushed the read runs from the period to the
    // end of the table — 5200 later invoices, eleven pages — where both bounds make it one.
    const store = new RecordingStore();
    await seedInvoices(store, { n: 5200, prefix: "inv_a", issueDate: "2020-01-15", withheld: 10 });
    await seedInvoices(store, { n: 3, prefix: "inv_m", issueDate: "2026-06-10", withheld: 100 });
    await seedInvoices(store, { n: 5200, prefix: "inv_z", issueDate: "2026-09-01", withheld: 10 });
    const body = bodyOf(
      await invoke(buildHandler(store), { from: "2026-06-01", to: "2026-06-30" }),
    );
    expect(body.rows).toHaveLength(3);
    expect(store.pagesFor("Invoice")).toBe(1);
  });

  it("includes an undated invoice with no period and drops it under one", async () => {
    // Unchanged from the in-memory filter it replaces: an undated invoice still carries
    // withholding, so the unfiltered report shows it, while a period query cannot place it.
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "Invoice", {
      id: "undated",
      invoice_number: "INV-U",
      withholding_total: 25,
      currency: "USD",
    });
    expect(bodyOf(await invoke(buildHandler(store))).rows).toHaveLength(1);
    expect(bodyOf(await invoke(buildHandler(store), { from: "2026-01-01" })).rows).toHaveLength(0);
  });
});

describe("buildWhtReconciliationHandler — the bounded declaration", () => {
  it("declares a complete reading with an empty bounded list", async () => {
    const store = new InMemoryEntityStore();
    await seedInvoices(store, { n: 3, prefix: "inv", issueDate: "2026-06-10", withheld: 10 });
    await seedCertificates(store, 2, "inv_00000", 5);
    const body = bodyOf(await invoke(buildHandler(store)));
    expect(body.complete).toBe(true);
    expect(body.bounded).toEqual([]);
  });

  it("carries `complete` on every answer, so an absent field is never the happy path", async () => {
    const store = new InMemoryEntityStore();
    await seedInvoices(store, { n: 1, prefix: "inv", issueDate: "2026-06-10", withheld: 10 });
    const body = bodyOf(await invoke(buildHandler(store)));
    expect(Object.keys(body)).toEqual(["totals", "byCurrency", "rows", "complete", "bounded"]);
    expect("complete" in body).toBe(true);
  });

  it("names both reads when both hit the ceiling", async () => {
    const store = new InMemoryEntityStore();
    await seedInvoices(store, { n: 30, prefix: "inv", issueDate: "2026-06-10", withheld: 10 });
    await seedCertificates(store, 30, "inv_00000", 1);
    const body = bodyOf(await invoke(buildHandler(store, 10)));
    expect(body.complete).toBe(false);
    expect(body.bounded).toEqual(["invoices", "certificates"]);
  });

  it("names only the read that was bounded", async () => {
    const store = new InMemoryEntityStore();
    await seedInvoices(store, { n: 3, prefix: "inv", issueDate: "2026-06-10", withheld: 10 });
    await seedCertificates(store, 30, "inv_00000", 1);
    const body = bodyOf(await invoke(buildHandler(store, 10)));
    expect(body.bounded).toEqual(["certificates"]);
    // The bounded reading is still served — the only view there is of the gap.
    expect(body.rows).toHaveLength(3);
  });

  it("still reports complete when a set is exactly the ceiling", async () => {
    const store = new InMemoryEntityStore();
    await seedInvoices(store, { n: 10, prefix: "inv", issueDate: "2026-06-10", withheld: 10 });
    expect(bodyOf(await invoke(buildHandler(store, 10))).complete).toBe(true);
    expect(bodyOf(await invoke(buildHandler(store, 9))).complete).toBe(false);
  });
});
