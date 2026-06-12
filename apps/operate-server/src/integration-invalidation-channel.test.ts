import { createNodePgConnection, createNodePgListener, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresTenantInvalidationChannel } from "./invalidation-channel.js";

/**
 * Real-Postgres integration test (gated on `CROSSENGIN_PG_TEST=1`, skipped
 * offline) proving the P5.10 cross-process invalidation channel: a `pg_notify`
 * published on one connection (instance A) is delivered to a `LISTEN` session on
 * a *separate* connection (instance B), evicting the named tenant — the
 * fleet-wide mechanism behind `--invalidation-channel`.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

const TENANT = "00000000-0000-4000-8000-0000000000c1";

suite("cross-process tenant invalidation (real Postgres LISTEN/NOTIFY)", () => {
  const conns: PgConnection[] = [];

  afterAll(async () => {
    await Promise.all(conns.map((c) => c.close()));
  });

  it("delivers a published tenant id to a separate LISTEN connection", async () => {
    // Instance B: a dedicated listener connection + a publish connection.
    const pubB = createNodePgConnection(parsePgEnvConfig());
    conns.push(pubB);
    const listenerB = createNodePgListener(parsePgEnvConfig());
    const channelB = new PostgresTenantInvalidationChannel(pubB, listenerB);
    const evicted: string[] = [];
    await channelB.start((tenantId) => evicted.push(tenantId));

    // Instance A: an independent publish connection broadcasts the eviction.
    // (Its listener is constructed but never started, so it opens no connection.)
    const pubA = createNodePgConnection(parsePgEnvConfig());
    conns.push(pubA);
    const channelA = new PostgresTenantInvalidationChannel(pubA, createNodePgListener(parsePgEnvConfig()));
    await channelA.publish(TENANT);

    // NOTIFY delivery is asynchronous — poll until instance B's listener fires.
    const deadline = Date.now() + 3000;
    while (evicted.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await channelB.close();

    expect(evicted).toContain(TENANT);
  });
});
