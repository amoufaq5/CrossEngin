import type { AccessReviewDecision } from "@crossengin/access-reviews";
import { describe, expect, it } from "vitest";

import { PostgresAccessReviewDecisionStore } from "./decision-store.js";
import { CampaignUuidResolver, ItemUuidResolver } from "./id-mapping.js";
import { rowToDecision, type DecisionRow } from "./records.js";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";
import { FakeConn, UUIDS, makeDecision, type CapturedCall } from "./test-fakes.js";

const PHRASE = "I attest this access is appropriate.";

/** A decision whose phrase is load-bearing: `typed_attestation_phrase` is what the column is for. */
const typedPhraseDecision = (): AccessReviewDecision =>
  makeDecision({
    kind: "keep",
    reason: "manager_attestation",
    comment: "Reviewed with the principal's manager.",
    attestation: {
      kind: "typed_attestation_phrase",
      attestedAt: "2026-02-01T00:00:00.000Z",
      attestedByUserId: UUIDS.system,
      attestationPhrase: PHRASE,
      signatureSha256: null,
      signingKeyFingerprint: null,
      coAttestingUserId: null,
      coAttestedAt: null,
      ipAddress: "127.0.0.1",
      userAgent: "crossengin-access-reviews-runtime",
    },
  });

/** The statement's own column list, so a positional assertion cannot drift from the statement. */
function insertColumns(sql: string): readonly string[] {
  const list = /INSERT INTO meta\.access_review_decisions \(([^)]*)\)/.exec(sql);
  if (list === null) throw new Error("no INSERT column list in the captured SQL");
  return (list[1] ?? "").split(",").map((c) => c.trim()).filter((c) => c.length > 0);
}

function valuesPlaceholders(sql: string): number {
  const values = /VALUES \(([\s\S]*?)\)/.exec(sql);
  if (values === null) throw new Error("no VALUES list in the captured SQL");
  return new Set((values[1] ?? "").match(/\$\d+/g) ?? []).size;
}

/**
 * The row the SELECT would hand back for a decision the INSERT just wrote, zipped from the
 * statement's own column list rather than restated — so a column the writer binds and the mapper
 * cannot read, which is exactly what `attestation_phrase` was, fails here.
 *
 * Two columns cannot come from the write: the INSERT binds the surrogate `item_id`/`campaign_id`
 * uuids while `SELECT_JOINED` aliases the natural ids off the joined tables.
 */
function rowFromInsert(call: CapturedCall | undefined): DecisionRow {
  if (call === undefined) throw new Error("the INSERT was never issued");
  const params = call.params ?? [];
  const bound = Object.fromEntries(
    insertColumns(call.sql).map((column, i) => [column, params[i] ?? null]),
  );
  return {
    ...bound,
    item_natural_id: "ari_00000001",
    campaign_natural_id: "arc_00000001",
  } as DecisionRow;
}

function resolvedStore(): {
  conn: FakeConn;
  store: PostgresAccessReviewDecisionStore;
} {
  const conn = new FakeConn();
  const campaignResolver = new CampaignUuidResolver();
  campaignResolver.register("arc_00000001", UUIDS.campaignRow);
  const itemResolver = new ItemUuidResolver();
  itemResolver.register("ari_00000001", UUIDS.itemRow);
  const store = new PostgresAccessReviewDecisionStore(conn, campaignResolver, itemResolver);
  return { conn, store };
}

describe("PostgresAccessReviewDecisionStore.record", () => {
  it("sets tenant context then INSERT ... ON CONFLICT (decision_id) DO NOTHING", async () => {
    const { conn, store } = resolvedStore();
    await store.record(makeDecision());
    expect(conn.calls[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    const insert = conn.find("INSERT INTO meta.access_review_decisions");
    expect(insert?.sql).toContain("ON CONFLICT (decision_id) DO NOTHING");
  });

  it("binds resolved item + campaign uuids as FK columns", async () => {
    const { conn, store } = resolvedStore();
    await store.record(makeDecision());
    const params = conn.find("INSERT INTO meta.access_review_decisions")?.params ?? [];
    expect(params[0]).toBe("ard_00000001");
    expect(params[1]).toBe(UUIDS.itemRow);
    expect(params[2]).toBe(UUIDS.campaignRow);
    expect(params[3]).toBe(UUIDS.tenant);
  });

  it("flattens the nested attestation into columns", async () => {
    const { conn, store } = resolvedStore();
    await store.record(makeDecision());
    const insert = conn.find("INSERT INTO meta.access_review_decisions");
    const params = insert?.params ?? [];
    // Read by position **through the statement's own column list** rather than by a hand-counted
    // index: this assertion used to name 11/12/16/17 as literals, and inserting one column shifted
    // three of the four onto a neighbour of the same declared type.
    const at = (column: string): unknown => params[insertColumns(insert?.sql ?? "").indexOf(column)];
    expect(at("attestation_kind")).toBe("click_through_acknowledgement");
    expect(at("attestation_phrase")).toBeNull();
    expect(at("attestation_signature_sha256")).toBeNull();
    expect(at("ip_address")).toBe("127.0.0.1");
    expect(at("user_agent")).toBe("crossengin-access-reviews-runtime");
  });

  it("names attestation_phrase in the INSERT, with one placeholder per column", async () => {
    const { conn, store } = resolvedStore();
    await store.record(makeDecision());
    const insert = conn.find("INSERT INTO meta.access_review_decisions");
    const columns = insertColumns(insert?.sql ?? "");
    expect(columns).toContain("attestation_phrase");
    // Equal counts in all three places, which is what an off-by-one in a 24-column statement
    // breaks: a column list longer than the VALUES list is a syntax error, and a params array
    // longer than the placeholder list is silently ignored by node-postgres.
    expect(valuesPlaceholders(insert?.sql ?? "")).toBe(columns.length);
    expect(insert?.params).toHaveLength(columns.length);
    expect(columns.length).toBeGreaterThanOrEqual(24);
  });

  it("binds the typed phrase, whose loss the signed attestation bytes commit to", async () => {
    const { conn, store } = resolvedStore();
    await store.record(typedPhraseDecision());
    const insert = conn.find("INSERT INTO meta.access_review_decisions");
    const i = insertColumns(insert?.sql ?? "").indexOf("attestation_phrase");
    expect(insert?.params?.[i]).toBe(PHRASE);
  });

  it("round-trips a decision through its own INSERT column list and back", async () => {
    const { conn, store } = resolvedStore();
    const decision = typedPhraseDecision();
    await store.record(decision);
    const insert = conn.find("INSERT INTO meta.access_review_decisions");
    expect(rowToDecision(rowFromInsert(insert))).toEqual(decision);
  });

  it("selects attestation_phrase, so the write and the read agree about the column", async () => {
    const { conn, store } = resolvedStore();
    await store.listByItem(UUIDS.tenant, "ari_00000001");
    expect(conn.find("FROM meta.access_review_decisions d")?.sql).toContain(
      "d.attestation_phrase",
    );
  });

  it("casts ip_address to inet in SQL", async () => {
    const { conn, store } = resolvedStore();
    await store.record(makeDecision());
    expect(conn.find("INSERT INTO meta.access_review_decisions")?.sql).toContain("::inet");
  });

  it("serializes modified_grant_attributes when present, null otherwise", async () => {
    const { conn, store } = resolvedStore();
    await store.record(
      makeDecision({
        id: "ard_00000002",
        kind: "modify_grant",
        reason: "role_changed_modified",
        modifiedGrantAttributes: { tier: "gold" },
      }),
    );
    const params = conn.find("INSERT INTO meta.access_review_decisions")?.params ?? [];
    expect(params[10]).toBe(JSON.stringify({ tier: "gold" }));
  });

  it("throws when the item FK cannot be resolved", async () => {
    const conn = new FakeConn(() => ({ rows: [], rowCount: 0 }));
    const store = new PostgresAccessReviewDecisionStore(conn);
    await expect(store.record(makeDecision())).rejects.toThrow(
      /access review item not found/,
    );
  });

  it("listByItem filters by natural item id via join", async () => {
    const { conn, store } = resolvedStore();
    await store.listByItem(UUIDS.tenant, "ari_00000001");
    const select = conn.find("FROM meta.access_review_decisions d");
    expect(select?.sql).toContain("WHERE i.item_id = $1");
    expect(select?.params).toEqual(["ari_00000001"]);
  });

  it("listByCampaign filters by natural campaign id via join", async () => {
    const { conn, store } = resolvedStore();
    await store.listByCampaign(UUIDS.tenant, "arc_00000001");
    const select = conn.find("FROM meta.access_review_decisions d");
    expect(select?.sql).toContain("WHERE c.campaign_id = $1");
    // All three joined tables, which is what a non-owner is shown.
    expect(select?.sql).toContain("d.tenant_id = $2");
    expect(select?.sql).toContain("i.tenant_id = $2");
    expect(select?.sql).toContain("c.tenant_id = $2");
    expect(select?.params).toEqual(["arc_00000001", UUIDS.tenant]);
  });
});
