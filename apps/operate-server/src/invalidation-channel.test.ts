import type { PgListener } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  PostgresTenantInvalidationChannel,
  TENANT_INVALIDATION_CHANNEL,
} from "./invalidation-channel.js";

const T = "00000000-0000-4000-8000-0000000000a1";

/** A fake publisher recording the pg_notify calls. */
function fakePublisher(): { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: never[]; rowCount: number }>; calls: Array<{ sql: string; params: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
}

/** A fake listener that captures the (channel, handler) and lets a test fire a payload. */
function fakeListener(): { listener: PgListener; fire: (channel: string, payload: string) => void; closed: () => boolean } {
  let captured: { channel: string; onNotify: (payload: string) => void } | null = null;
  let isClosed = false;
  return {
    fire(channel: string, payload: string) {
      if (captured !== null && captured.channel === channel) captured.onNotify(payload);
    },
    closed: () => isClosed,
    listener: {
      async listen(channel: string, onNotify: (payload: string) => void) {
        captured = { channel, onNotify };
      },
      async close() {
        isClosed = true;
      },
    },
  };
}

describe("PostgresTenantInvalidationChannel", () => {
  it("publish emits pg_notify(channel, tenantId)", async () => {
    const pub = fakePublisher();
    const { listener } = fakeListener();
    const channel = new PostgresTenantInvalidationChannel(pub, listener);
    await channel.publish(T);
    expect(pub.calls).toHaveLength(1);
    expect(pub.calls[0]!.sql).toContain("pg_notify");
    expect(pub.calls[0]!.params).toEqual([TENANT_INVALIDATION_CHANNEL, T]);
  });

  it("start routes a NOTIFY payload to the invalidate handler", async () => {
    const pub = fakePublisher();
    const fake = fakeListener();
    const channel = new PostgresTenantInvalidationChannel(pub, fake.listener);
    const evicted: string[] = [];
    await channel.start((tenantId) => evicted.push(tenantId));
    fake.fire(TENANT_INVALIDATION_CHANNEL, T);
    expect(evicted).toEqual([T]);
  });

  it("ignores an empty payload", async () => {
    const fake = fakeListener();
    const channel = new PostgresTenantInvalidationChannel(fakePublisher(), fake.listener);
    const evicted: string[] = [];
    await channel.start((tenantId) => evicted.push(tenantId));
    fake.fire(TENANT_INVALIDATION_CHANNEL, "");
    expect(evicted).toEqual([]);
  });

  it("close closes the underlying listener", async () => {
    const fake = fakeListener();
    const channel = new PostgresTenantInvalidationChannel(fakePublisher(), fake.listener);
    await channel.close();
    expect(fake.closed()).toBe(true);
  });

  it("publish + a round-trip through start evicts (the self-broadcast path)", async () => {
    // Mirrors the live wiring: publish() fans out, and this instance's own
    // listener receives it and evicts (harmless second evict alongside the
    // in-process invalidate).
    const pub = fakePublisher();
    const fake = fakeListener();
    const channel = new PostgresTenantInvalidationChannel(pub, fake.listener);
    const evicted: string[] = [];
    await channel.start((tenantId) => evicted.push(tenantId));
    await channel.publish(T);
    // simulate the NOTIFY arriving back on the LISTEN connection
    fake.fire(TENANT_INVALIDATION_CHANNEL, pub.calls[0]!.params[1] as string);
    expect(evicted).toEqual([T]);
  });
});
