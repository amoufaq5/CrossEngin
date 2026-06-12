import { describe, expect, it } from "vitest";

import {
  createReconnectingPgListener,
  type ListenerScheduler,
  type PgNotificationClient,
} from "./node-pg-listener.js";

interface PgNotification {
  readonly channel: string;
  readonly payload?: string;
}

/** A fake `pg.Client` that records LISTENs + lets a test emit notifications, errors, and end. */
class FakeClient implements PgNotificationClient {
  readonly listened: string[] = [];
  ended = false;
  connected = false;
  private notificationHandlers: Array<(msg: PgNotification) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];
  private endHandlers: Array<() => void> = [];

  async connect(): Promise<void> {
    this.connected = true;
  }

  async query(sql: string): Promise<unknown> {
    const m = /^LISTEN (.+)$/.exec(sql);
    if (m !== null) this.listened.push(m[1]!);
    return { rows: [], rowCount: 0 };
  }

  on(event: "notification", listener: (msg: PgNotification) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "notification" | "error" | "end", listener: (arg?: never) => void): void {
    if (event === "notification") this.notificationHandlers.push(listener as (msg: PgNotification) => void);
    else if (event === "error") this.errorHandlers.push(listener as (err: Error) => void);
    else this.endHandlers.push(listener as () => void);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  emitNotification(channel: string, payload: string): void {
    for (const h of this.notificationHandlers) h({ channel, payload });
  }

  emitError(err: Error): void {
    for (const h of this.errorHandlers) h(err);
  }

  emitEnd(): void {
    for (const h of this.endHandlers) h();
  }
}

/** A fake scheduler driving backoff with a manual clock. */
function fakeScheduler(): {
  scheduler: ListenerScheduler;
  delays: number[];
  runNext: () => void;
  pending: () => number;
} {
  const tasks: Array<{ handler: () => void; ms: number }> = [];
  const delays: number[] = [];
  return {
    delays,
    pending: () => tasks.length,
    runNext() {
      const task = tasks.shift();
      if (task !== undefined) task.handler();
    },
    scheduler: {
      setTimeout(handler: () => void, ms: number) {
        delays.push(ms);
        const entry = { handler, ms };
        tasks.push(entry);
        return entry;
      },
      clearTimeout(handle: unknown) {
        const idx = tasks.indexOf(handle as { handler: () => void; ms: number });
        if (idx >= 0) tasks.splice(idx, 1);
      },
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("createReconnectingPgListener", () => {
  it("connects, issues LISTEN, and routes a matching notification to onNotify", async () => {
    const clients: FakeClient[] = [];
    const listener = createReconnectingPgListener(() => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    });
    const got: string[] = [];
    await listener.listen("ch_a", (p) => got.push(p));

    expect(clients).toHaveLength(1);
    expect(clients[0]!.connected).toBe(true);
    expect(clients[0]!.listened).toEqual(["ch_a"]);

    clients[0]!.emitNotification("ch_a", "hello");
    expect(got).toEqual(["hello"]);

    clients[0]!.emitNotification("other_ch", "ignored");
    expect(got).toEqual(["hello"]);
  });

  it("rejects an invalid channel name", async () => {
    const listener = createReconnectingPgListener(() => new FakeClient());
    await expect(listener.listen("ATTACK; DROP", () => {})).rejects.toThrow(/invalid LISTEN channel/);
    await expect(listener.listen("1bad", () => {})).rejects.toThrow(/invalid LISTEN channel/);
  });

  it("reconnects on error after the backoff delay, re-LISTENs, and routes to the original handler", async () => {
    const clients: FakeClient[] = [];
    const fake = fakeScheduler();
    const reconnects: number[] = [];
    const listener = createReconnectingPgListener(
      () => {
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      { scheduler: fake.scheduler, onReconnect: (n) => reconnects.push(n) },
    );
    const got: string[] = [];
    await listener.listen("ch_a", (p) => got.push(p));
    expect(clients).toHaveLength(1);

    clients[0]!.emitError(new Error("socket dropped"));
    expect(fake.delays).toEqual([1000]);
    expect(clients).toHaveLength(1);

    fake.runNext();
    await tick();

    expect(clients).toHaveLength(2);
    expect(clients[1]!.connected).toBe(true);
    expect(clients[1]!.listened).toEqual(["ch_a"]);
    expect(reconnects).toEqual([1]);

    clients[1]!.emitNotification("ch_a", "after-reconnect");
    expect(got).toEqual(["after-reconnect"]);
  });

  it("backs off exponentially and resets to base after a successful reconnect", async () => {
    const clients: FakeClient[] = [];
    let failNextConnect = false;
    const fake = fakeScheduler();
    const listener = createReconnectingPgListener(
      () => {
        const c = new FakeClient();
        if (failNextConnect) {
          failNextConnect = false;
          c.connect = async () => {
            throw new Error("connect refused");
          };
        }
        clients.push(c);
        return c;
      },
      { scheduler: fake.scheduler },
    );
    await listener.listen("ch_a", () => {});

    clients[0]!.emitError(new Error("drop 1"));
    expect(fake.delays).toEqual([1000]);

    // First reconnect attempt fails → backoff climbs.
    failNextConnect = true;
    fake.runNext();
    await tick();
    expect(fake.delays).toEqual([1000, 2000]);

    // Second reconnect attempt fails → backoff climbs again.
    failNextConnect = true;
    fake.runNext();
    await tick();
    expect(fake.delays).toEqual([1000, 2000, 4000]);

    // Third reconnect succeeds → backoff resets to base.
    fake.runNext();
    await tick();
    const succeeded = clients[clients.length - 1]!;
    expect(succeeded.connected).toBe(true);

    // A fresh error now schedules at the base delay again.
    succeeded.emitError(new Error("drop 2"));
    expect(fake.delays).toEqual([1000, 2000, 4000, 1000]);
  });

  it("close() after an error prevents any reconnect", async () => {
    const clients: FakeClient[] = [];
    const fake = fakeScheduler();
    const listener = createReconnectingPgListener(
      () => {
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      { scheduler: fake.scheduler },
    );
    await listener.listen("ch_a", () => {});
    expect(clients).toHaveLength(1);

    clients[0]!.emitError(new Error("drop"));
    expect(fake.pending()).toBe(1);

    await listener.close();
    // The pending reconnect timer was cleared.
    expect(fake.pending()).toBe(0);

    // Even if a stray scheduled callback fired, it must not mint a new client.
    fake.runNext();
    await tick();
    expect(clients).toHaveLength(1);
  });

  it("re-LISTENs every channel from multiple listen() calls after a reconnect", async () => {
    const clients: FakeClient[] = [];
    const fake = fakeScheduler();
    const listener = createReconnectingPgListener(
      () => {
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      { scheduler: fake.scheduler },
    );
    const gotA: string[] = [];
    const gotB: string[] = [];
    await listener.listen("ch_a", (p) => gotA.push(p));
    await listener.listen("ch_b", (p) => gotB.push(p));

    expect(clients).toHaveLength(1);
    expect(clients[0]!.listened).toEqual(["ch_a", "ch_b"]);

    clients[0]!.emitError(new Error("drop"));
    fake.runNext();
    await tick();

    expect(clients).toHaveLength(2);
    expect(clients[1]!.listened).toEqual(["ch_a", "ch_b"]);

    clients[1]!.emitNotification("ch_b", "b-payload");
    expect(gotB).toEqual(["b-payload"]);
    expect(gotA).toEqual([]);
  });

  it("reconnects on a connection end while not intentionally closed", async () => {
    const clients: FakeClient[] = [];
    const fake = fakeScheduler();
    const listener = createReconnectingPgListener(
      () => {
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      { scheduler: fake.scheduler },
    );
    await listener.listen("ch_a", () => {});
    clients[0]!.emitEnd();
    expect(fake.delays).toEqual([1000]);
    fake.runNext();
    await tick();
    expect(clients).toHaveLength(2);
    expect(clients[1]!.listened).toEqual(["ch_a"]);
  });

  it("close() is idempotent and ends the current client", async () => {
    const clients: FakeClient[] = [];
    const listener = createReconnectingPgListener(() => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    });
    await listener.listen("ch_a", () => {});
    await listener.close();
    expect(clients[0]!.ended).toBe(true);
    await listener.close();
    expect(clients[0]!.ended).toBe(true);
  });
});
