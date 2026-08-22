import { describe, expect, it } from "vitest";

import { enrolNewProposalsForReview } from "./review-enrolment.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

interface Proposal {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
}

class FakeStore {
  readonly created: { tenantId: string; name: string }[] = [];
  readonly listCalls: string[] = [];
  private seq = 0;

  async create(tenantId: string, input: never): Promise<Proposal> {
    const { name } = input as unknown as { name: string };
    this.created.push({ tenantId, name });
    this.seq += 1;
    return { id: `prop_${this.seq.toString()}`, tenantId, name };
  }

  async list(tenantId: string): Promise<readonly Proposal[]> {
    this.listCalls.push(tenantId);
    return [];
  }
}

function enroller(): { markPending: (t: string, id: string) => Promise<void>; calls: [string, string][] } {
  const calls: [string, string][] = [];
  return {
    calls,
    markPending: async (t: string, id: string): Promise<void> => {
      calls.push([t, id]);
    },
  };
}

describe("enrolNewProposalsForReview", () => {
  it("enrols a newly created proposal as pending and returns it unchanged", async () => {
    const store = new FakeStore();
    const e = enroller();
    const wrapped = enrolNewProposalsForReview(store, { enroller: e });
    const proposal = await wrapped.create(TENANT, { name: "Field Service" } as never);
    expect(proposal).toEqual({ id: "prop_1", tenantId: TENANT, name: "Field Service" });
    expect(e.calls).toEqual([[TENANT, "prop_1"]]);
    expect(store.created).toEqual([{ tenantId: TENANT, name: "Field Service" }]);
  });

  it("enrols with the proposal's own tenant, not the caller's argument", async () => {
    const store = new FakeStore();
    const e = enroller();
    const wrapped = enrolNewProposalsForReview(store, { enroller: e });
    const proposal = await wrapped.create(TENANT, { name: "x" } as never);
    expect(e.calls[0]?.[0]).toBe(proposal.tenantId);
  });

  it("never loses the proposal when enrolment fails — reports and returns", async () => {
    const store = new FakeStore();
    const errors: string[] = [];
    const wrapped = enrolNewProposalsForReview(store, {
      enroller: {
        markPending: async (): Promise<void> => {
          throw new Error("ledger down");
        },
      },
      onError: (err, id) => errors.push(`${id}:${err instanceof Error ? err.message : String(err)}`),
    });
    const proposal = await wrapped.create(TENANT, { name: "x" } as never);
    expect(proposal.id).toBe("prop_1");
    expect(errors).toEqual(["prop_1:ledger down"]);
  });

  it("swallows an enrolment failure even with no onError handler", async () => {
    const store = new FakeStore();
    const wrapped = enrolNewProposalsForReview(store, {
      enroller: {
        markPending: async (): Promise<void> => {
          throw new Error("boom");
        },
      },
    });
    await expect(wrapped.create(TENANT, { name: "x" } as never)).resolves.toMatchObject({ id: "prop_1" });
  });

  it("passes every other method through to the underlying store", async () => {
    const store = new FakeStore();
    const wrapped = enrolNewProposalsForReview(store, { enroller: enroller() });
    await wrapped.list(TENANT);
    expect(store.listCalls).toEqual([TENANT]);
  });

  it("does not mutate the original store", async () => {
    const store = new FakeStore();
    const e = enroller();
    enrolNewProposalsForReview(store, { enroller: e });
    await store.create(TENANT, { name: "direct" } as never);
    expect(e.calls).toHaveLength(0);
  });

  it("enrols each proposal exactly once across several creates", async () => {
    const store = new FakeStore();
    const e = enroller();
    const wrapped = enrolNewProposalsForReview(store, { enroller: e });
    await wrapped.create(TENANT, { name: "a" } as never);
    await wrapped.create(TENANT, { name: "b" } as never);
    expect(e.calls).toEqual([
      [TENANT, "prop_1"],
      [TENANT, "prop_2"],
    ]);
  });
});
