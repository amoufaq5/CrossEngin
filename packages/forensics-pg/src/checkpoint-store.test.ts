import { describe, expect, it } from "vitest";
import type { ChainCheckpoint } from "@crossengin/forensics";

import { PostgresChainCheckpointStore, rowToCheckpoint } from "./checkpoint-store.js";
import { fakeChainPg } from "./test-fakes.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const AT = "2026-06-01T00:00:00.000Z";

function h(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function checkpoint(sequenceNumber: number, extra: Partial<ChainCheckpoint> = {}): ChainCheckpoint {
  return {
    sequenceNumber,
    rootHash: h(sequenceNumber + 1),
    checkpointedAt: AT,
    checkpointedBy: "auditor",
    algorithm: "sha256",
    ...extra,
  };
}

describe("PostgresChainCheckpointStore", () => {
  it("records and reads back the latest checkpoint per scope", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    expect(await store.latest(TENANT_A)).toBeNull();

    await store.record(TENANT_A, checkpoint(2));
    await store.record(TENANT_A, checkpoint(5, { externalAnchorReference: "btc:txid:abc" }));

    const latest = await store.latest(TENANT_A);
    expect(latest?.sequenceNumber).toBe(5);
    expect(latest?.externalAnchorReference).toBe("btc:txid:abc");
  });

  it("fetches a checkpoint by sequence and lists recent newest-first", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await store.record(TENANT_A, checkpoint(1));
    await store.record(TENANT_A, checkpoint(3));
    await store.record(TENANT_A, checkpoint(7));

    const at3 = await store.getBySequence(TENANT_A, 3);
    expect(at3?.sequenceNumber).toBe(3);
    expect(await store.getBySequence(TENANT_A, 99)).toBeNull();

    const recent = await store.listRecent(TENANT_A, 2);
    expect(recent.map((c) => c.sequenceNumber)).toEqual([7, 3]);
  });

  it("is append-only — re-recording the same sequence is a no-op", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await store.record(TENANT_A, checkpoint(2, { checkpointedBy: "first" }));
    await store.record(TENANT_A, checkpoint(2, { checkpointedBy: "second" }));
    const got = await store.getBySequence(TENANT_A, 2);
    expect(got?.checkpointedBy).toBe("first");
  });

  it("isolates checkpoints per tenant and from the platform chain", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await store.record(TENANT_A, checkpoint(4));
    await store.record(TENANT_B, checkpoint(9));
    await store.record(null, checkpoint(1));

    expect((await store.latest(TENANT_A))?.sequenceNumber).toBe(4);
    expect((await store.latest(TENANT_B))?.sequenceNumber).toBe(9);
    expect((await store.latest(null))?.sequenceNumber).toBe(1);
    expect(await store.getBySequence(TENANT_A, 9)).toBeNull();
  });

  it("rejects a malformed tenant id and a bad schema", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await expect(store.record("not-a-uuid", checkpoint(0))).rejects.toThrow();
    expect(() => new PostgresChainCheckpointStore(fakeChainPg(), { schema: "Bad-Schema" })).toThrow(
      /schema/,
    );
  });
});

describe("rowToCheckpoint", () => {
  it("trims CHAR(64) padding, coerces a Date, and nulls to undefined", () => {
    const cp = rowToCheckpoint({
      sequence_number: "5",
      root_hash: `${h(6)} `,
      checkpointed_at: new Date(AT),
      checkpointed_by: "auditor",
      external_anchor_reference: null,
      algorithm: "sha256",
    });
    expect(cp.sequenceNumber).toBe(5);
    expect(cp.rootHash).toBe(h(6));
    expect(cp.checkpointedAt).toBe(AT);
    expect(cp.externalAnchorReference).toBeUndefined();
  });
});
