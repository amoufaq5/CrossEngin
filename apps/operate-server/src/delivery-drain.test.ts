import {
  DeliveryAttemptSchema,
  RETRYABLE_DELIVERY_OUTCOMES,
  type DeliveryAttempt,
  type NotificationChannel,
  type DigestBatch,
  type NotificationDispatch,
  type SuppressionRecord,
  type UserPreferenceMatrix,
} from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import {
  QUIET_HOURS_DEFER_ERROR_CODE,
  QUIET_HOURS_DROP_ERROR_CODE,
  addressFor,
  drainTenant,
  drainTenants,
  emptyPreferenceMatrix,
  terminalOutcomeFor,
  type DeliveryDrainOptions,
  type DeliveryStoreLike,
  type DigestStoreLike,
  type RecipientResolverLike,
} from "./delivery-drain.js";
import type { NotificationPolicy } from "./delivery-throttle.js";
import type { DigestAddResult } from "./digest-store.js";
import {
  SenderRegistry,
  InAppSender,
  type ChannelSender,
  type SendRequest,
  type SendResult,
} from "./delivery-senders.js";
import type { ClaimedDispatch, DispatchAdvanceUpdate, DueRetry } from "./delivery-store.js";
import type { ResolvedRecipient } from "./recipient-resolver.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER_A = "22222222-2222-4222-8222-222222222222";
const USER_B = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-23T12:00:00.000Z");

function dispatch(overrides: Partial<NotificationDispatch> = {}): NotificationDispatch {
  return {
    id: `disp_${"a".repeat(32)}`,
    tenantId: TENANT,
    templateId: "design_review.approved",
    templateVersion: "1.0.0",
    locale: "en",
    channel: "in_app",
    category: "transactional",
    priority: "high",
    audienceJson: { kind: "tenant_admins", tenantId: TENANT },
    variablesSha256: "b".repeat(64),
    correlationId: null,
    idempotencyKey: "design_review:p1:approved",
    status: "queued",
    queuedAt: NOW.toISOString(),
    startedAt: null,
    completedAt: null,
    recipientCount: 1,
    deliveredCount: 0,
    failedCount: 0,
    suppressedCount: 0,
    cancelledReason: null,
    requestedBy: null,
    requestingSystem: "operate-server.design-review",
    ...overrides,
  };
}

function recipient(userId: string, email: string): ResolvedRecipient {
  return { userId, email, displayName: null, primaryRole: "erp_admin", secondaryRoles: [] };
}

class FakeStore implements DeliveryStoreLike {
  readonly attempts: DeliveryAttempt[] = [];
  readonly advances: Array<{ rowId: string; update: DispatchAdvanceUpdate }> = [];
  claims: ClaimedDispatch[] = [];
  retries: DueRetry[] = [];
  claimCalls = 0;

  async claimQueued(): Promise<readonly ClaimedDispatch[]> {
    this.claimCalls += 1;
    return this.claims;
  }
  async recordAttempt(_t: string, _r: string, attempt: DeliveryAttempt): Promise<boolean> {
    this.attempts.push(attempt);
    return true;
  }
  async advance(_t: string, rowId: string, update: DispatchAdvanceUpdate): Promise<boolean> {
    this.advances.push({ rowId, update });
    return true;
  }
  async dueRetries(): Promise<readonly DueRetry[]> {
    return this.retries;
  }
}

class FakeResolver implements RecipientResolverLike {
  suppressions: SuppressionRecord[] = [];
  preferences = new Map<string, UserPreferenceMatrix>();
  audienceCalls: unknown[] = [];

  constructor(public recipients: ResolvedRecipient[] = []) {}

  async resolveAudience(_t: string, audience: unknown): Promise<readonly ResolvedRecipient[]> {
    this.audienceCalls.push(audience);
    return this.recipients;
  }
  async preferencesFor(): Promise<ReadonlyMap<string, UserPreferenceMatrix>> {
    return this.preferences;
  }
  async activeSuppressions(): Promise<readonly SuppressionRecord[]> {
    return this.suppressions;
  }
}

class ScriptedSender implements ChannelSender {
  readonly channel: NotificationChannel = "in_app";
  readonly provider = "in_app_native" as const;
  readonly seen: SendRequest[] = [];
  constructor(private readonly results: SendResult[]) {}
  async send(request: SendRequest): Promise<SendResult> {
    this.seen.push(request);
    return this.results[Math.min(this.seen.length - 1, this.results.length - 1)] as SendResult;
  }
}

function opts(
  store: FakeStore,
  resolver: FakeResolver,
  senders: SenderRegistry = new SenderRegistry([new InAppSender()]),
): DeliveryDrainOptions {
  return { store, resolver, senders, clock: () => NOW };
}

function suppression(address: string, channel: NotificationChannel = "in_app"): SuppressionRecord {
  return {
    id: `supp_${"c".repeat(20)}`,
    tenantId: TENANT,
    channel,
    recipientAddress: address,
    reason: "manual_block",
    appliedAt: NOW.toISOString(),
    appliedBy: null,
    expiresAt: null,
    sourceDeliveryId: null,
    notes: null,
  };
}

describe("delivery-drain — addressFor", () => {
  it("uses the user id for in_app", () => {
    expect(addressFor("in_app", recipient(USER_A, "a@x.test"))).toBe(USER_A);
  });

  it("uses the user id for push_mobile", () => {
    expect(addressFor("push_mobile", recipient(USER_A, "a@x.test"))).toBe(USER_A);
  });

  it("uses the email for email", () => {
    expect(addressFor("email", recipient(USER_A, "a@x.test"))).toBe("a@x.test");
  });

  it("uses the email for sms and webhook (no other address exists)", () => {
    expect(addressFor("sms", recipient(USER_A, "a@x.test"))).toBe("a@x.test");
    expect(addressFor("webhook", recipient(USER_A, "a@x.test"))).toBe("a@x.test");
  });
});

describe("delivery-drain — emptyPreferenceMatrix", () => {
  it("builds a matrix with no entries", () => {
    const m = emptyPreferenceMatrix(TENANT, USER_A, NOW);
    expect(m.entries).toEqual([]);
    expect(m.userId).toBe(USER_A);
    expect(m.tenantId).toBe(TENANT);
  });
});

describe("delivery-drain — terminalOutcomeFor", () => {
  it("keeps a retryable outcome while retries remain", () => {
    expect(terminalOutcomeFor("failed", true)).toBe("failed");
    expect(terminalOutcomeFor("deferred", true)).toBe("deferred");
  });

  it("converts every exhausted retryable outcome to dropped", () => {
    for (const outcome of RETRYABLE_DELIVERY_OUTCOMES) {
      expect(terminalOutcomeFor(outcome, false)).toBe("dropped");
    }
  });

  it("leaves a terminal outcome untouched", () => {
    expect(terminalOutcomeFor("delivered", false)).toBe("delivered");
    expect(terminalOutcomeFor("bounced_hard", false)).toBe("bounced_hard");
  });
});

describe("delivery-drain — drainTenant", () => {
  it("delivers to every resolved recipient and completes the dispatch", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([
      recipient(USER_A, "a@x.test"),
      recipient(USER_B, "b@x.test"),
    ]);

    const report = await drainTenant(opts(store, resolver), TENANT);

    expect(report.dispatches).toBe(1);
    expect(report.delivered).toBe(2);
    expect(report.failed).toBe(0);
    expect(store.advances[0]?.update.status).toBe("completed");
    expect(store.advances[0]?.update.deliveredCount).toBe(2);
  });

  it("overwrites the placeholder recipientCount with the resolved fan-out", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch({ recipientCount: 1 }) }];
    const resolver = new FakeResolver([
      recipient(USER_A, "a@x.test"),
      recipient(USER_B, "b@x.test"),
    ]);

    await drainTenant(opts(store, resolver), TENANT);

    expect(store.advances[0]?.update.recipientCount).toBe(2);
  });

  it("passes the dispatch's own audienceJson to the resolver", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    await drainTenant(opts(store, resolver), TENANT);

    expect(resolver.audienceCalls[0]).toEqual({ kind: "tenant_admins", tenantId: TENANT });
  });

  it("records every attempt against the claimed row", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-9", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    await drainTenant(opts(store, resolver), TENANT);

    expect(store.attempts).toHaveLength(1);
    expect(store.advances[0]?.rowId).toBe("row-9");
  });

  it("writes attempts that pass DeliveryAttemptSchema", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    await drainTenant(opts(store, resolver), TENANT);

    for (const attempt of store.attempts) {
      expect(() => DeliveryAttemptSchema.parse(attempt)).not.toThrow();
    }
  });

  it("delivers a transactional notice to a suppressed recipient anyway", async () => {
    // transactional is a NON_SUPPRESSIBLE category: a review decision must reach the tenant
    // even if that address has been blocked for optional traffic.
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch({ category: "transactional" }) }];
    const resolver = new FakeResolver([
      recipient(USER_A, "a@x.test"),
      recipient(USER_B, "b@x.test"),
    ]);
    resolver.suppressions = [suppression(USER_B)];

    const report = await drainTenant(opts(store, resolver), TENANT);

    expect(report.delivered).toBe(2);
    expect(report.suppressed).toBe(0);
  });

  it("records a suppressed attempt when the category IS suppressible", async () => {
    const store = new FakeStore();
    store.claims = [
      { rowId: "row-1", dispatch: dispatch({ category: "operational_digest" }) },
    ];
    const resolver = new FakeResolver([
      recipient(USER_A, "a@x.test"),
      recipient(USER_B, "b@x.test"),
    ]);
    resolver.suppressions = [suppression(USER_B)];

    const report = await drainTenant(opts(store, resolver), TENANT);

    expect(report.delivered).toBe(1);
    expect(report.suppressed).toBe(1);
    const suppressed = store.attempts.filter((a) => a.outcome === "suppressed");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.errorMessage).toBe("suppressed");
    expect(() => DeliveryAttemptSchema.parse(suppressed[0])).not.toThrow();
  });

  it("skips a marketing recipient who has not explicitly opted in", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch({ category: "marketing" }) }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    const report = await drainTenant(opts(store, resolver), TENANT);

    expect(report.delivered).toBe(0);
    expect(report.suppressed).toBe(1);
    expect(store.attempts[0]?.errorMessage).toBe("not_opted_in");
  });

  it("completes a dispatch whose audience resolves to nobody, without any attempt", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];

    const report = await drainTenant(opts(store, new FakeResolver([])), TENANT);

    expect(store.attempts).toHaveLength(0);
    expect(store.advances[0]?.update.status).toBe("completed");
    expect(report.delivered).toBe(0);
  });

  it("deduplicates one address reached twice into a single delivery", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([
      recipient(USER_A, "a@x.test"),
      recipient(USER_A, "a@x.test"),
    ]);

    const report = await drainTenant(opts(store, resolver), TENANT);

    expect(report.delivered).toBe(1);
    expect(store.attempts).toHaveLength(1);
  });

  it("marks the dispatch failed when no recipient could be delivered to", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);
    const senders = new SenderRegistry([
      new ScriptedSender([
        {
          outcome: "bounced_hard",
          provider: "in_app_native",
          providerMessageId: null,
          httpStatus: null,
          bytesSent: null,
          errorCode: "hard_bounce",
          errorMessage: "no such address",
        },
      ]),
    ]);

    const report = await drainTenant(opts(store, resolver, senders), TENANT);

    expect(report.failed).toBe(1);
    expect(store.advances[0]?.update.status).toBe("failed");
  });

  it("keeps the dispatch sending while a retry is pending", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);
    const senders = new SenderRegistry([
      new ScriptedSender([
        {
          outcome: "deferred",
          provider: "in_app_native",
          providerMessageId: null,
          httpStatus: null,
          bytesSent: null,
          errorCode: null,
          errorMessage: null,
        },
      ]),
    ]);

    const report = await drainTenant(opts(store, resolver, senders), TENANT);

    expect(store.advances[0]?.update.status).toBe("sending");
    expect(store.advances[0]?.update.completedAt).toBeNull();
    expect(report.retryScheduled).toBe(1);
    expect(store.attempts[0]?.nextRetryAt).not.toBeNull();
  });

  it("drops a retryable outcome that has exhausted its attempts", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);
    const senders = new SenderRegistry([
      new ScriptedSender([
        {
          outcome: "failed",
          provider: "in_app_native",
          providerMessageId: null,
          httpStatus: null,
          bytesSent: null,
          errorCode: "boom",
          errorMessage: "boom",
        },
      ]),
    ]);

    const report = await drainTenant(
      { ...opts(store, resolver, senders), maxAttempts: 1 },
      TENANT,
    );

    expect(store.attempts[0]?.outcome).toBe("dropped");
    expect(store.attempts[0]?.nextRetryAt).toBeNull();
    expect(store.attempts[0]?.errorCode).toBe("boom");
    expect(report.failed).toBe(1);
    expect(() => DeliveryAttemptSchema.parse(store.attempts[0])).not.toThrow();
  });

  it("records an unrouted failure for a channel with no sender", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch({ channel: "email" }) }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    await drainTenant(opts(store, resolver, new SenderRegistry()), TENANT);

    expect(store.attempts[0]?.errorCode).toBe("no_sender_configured");
    expect(store.attempts[0]?.nextRetryAt).not.toBeNull();
    expect(() => DeliveryAttemptSchema.parse(store.attempts[0])).not.toThrow();
  });

  it("addresses an email dispatch by email, not user id", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch({ channel: "email" }) }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);
    const sender = new ScriptedSender([
      {
        outcome: "delivered",
        provider: "in_app_native",
        providerMessageId: "m1",
        httpStatus: 202,
        bytesSent: 10,
        errorCode: null,
        errorMessage: null,
      },
    ]);
    const senders = new SenderRegistry();
    senders.register({ ...sender, channel: "email", send: (r) => sender.send(r) });

    await drainTenant(opts(store, resolver, senders), TENANT);

    expect(sender.seen[0]?.recipientAddress).toBe("a@x.test");
  });

  it("returns a zero report when nothing is queued", async () => {
    const report = await drainTenant(opts(new FakeStore(), new FakeResolver([])), TENANT);
    expect(report).toMatchObject({ dispatches: 0, delivered: 0, failed: 0, retryScheduled: 0 });
  });
});

describe("delivery-drain — retries", () => {
  it("re-sends a due retry with an incremented attempt number", async () => {
    const store = new FakeStore();
    const d = dispatch({ status: "sending" });
    store.retries = [
      {
        rowId: "row-1",
        dispatch: d,
        // sha256 of USER_A, the in_app address
        recipientAddressSha256: "",
        attemptNumber: 1,
      },
    ];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);
    // Resolve the real hash by draining a queued copy first.
    const probe = new FakeStore();
    probe.claims = [{ rowId: "row-0", dispatch: dispatch() }];
    await drainTenant(opts(probe, new FakeResolver([recipient(USER_A, "a@x.test")])), TENANT);
    const hash = probe.attempts[0]?.recipientAddressSha256 ?? "";
    store.retries = [
      { rowId: "row-1", dispatch: d, recipientAddressSha256: hash, attemptNumber: 1 },
    ];

    const report = await drainTenant(opts(store, resolver), TENANT);

    expect(report.retriesAttempted).toBe(1);
    expect(store.attempts[0]?.attemptNumber).toBe(2);
    expect(store.attempts[0]?.attemptKind).toBe("retry");
    expect(() => DeliveryAttemptSchema.parse(store.attempts[0])).not.toThrow();
  });

  it("skips a retry whose recipient has left the audience", async () => {
    const store = new FakeStore();
    store.retries = [
      {
        rowId: "row-1",
        dispatch: dispatch({ status: "sending" }),
        recipientAddressSha256: "f".repeat(64),
        attemptNumber: 1,
      },
    ];

    const report = await drainTenant(opts(store, new FakeResolver([])), TENANT);

    expect(report.retriesAttempted).toBe(0);
    expect(store.attempts).toHaveLength(0);
  });
});

describe("delivery-drain — drainTenants", () => {
  it("aggregates across tenants", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    const report = await drainTenants(opts(store, resolver), [TENANT, TENANT]);

    expect(report.tenants).toBe(2);
    expect(report.dispatches).toBe(2);
    expect(report.delivered).toBe(2);
  });

  it("routes one tenant's failure to onError and keeps sweeping", async () => {
    const errors: string[] = [];
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);
    const failing: DeliveryStoreLike = {
      ...store,
      claimQueued: async (tenantId: string) => {
        if (tenantId === "bad") throw new Error("nope");
        return store.claimQueued();
      },
      recordAttempt: (t, r, a) => store.recordAttempt(t, r, a),
      advance: (t, r, u) => store.advance(t, r, u),
      dueRetries: () => store.dueRetries(),
    };

    const report = await drainTenants(
      { store: failing, resolver, senders: new SenderRegistry([new InAppSender()]), clock: () => NOW, onError: (_e, t) => errors.push(t) },
      ["bad", TENANT],
    );

    expect(errors).toEqual(["bad"]);
    expect(report.tenants).toBe(1);
    expect(report.delivered).toBe(1);
  });

  it("returns an empty report for no tenants", async () => {
    const report = await drainTenants(opts(new FakeStore(), new FakeResolver([])), []);
    expect(report).toMatchObject({ tenants: 0, dispatches: 0, delivered: 0 });
  });
});

describe("delivery-drain — quiet hours", () => {
  const QUIET: NotificationPolicy = {
    quietHours: {
      startTime: "22:00",
      endTime: "07:00",
      timezone: "UTC",
      behavior: "defer_to_morning",
      bypassCategories: [],
    },
    digestFrequency: "immediate",
    digestMaxItems: 50,
  };
  // 23:30 UTC — inside the 22:00→07:00 window.
  const NIGHT = new Date("2026-08-23T23:30:00.000Z");

  function nightOpts(
    store: FakeStore,
    resolver: FakeResolver,
    policy: NotificationPolicy,
    digests?: DigestStoreLike,
  ): DeliveryDrainOptions {
    return {
      store,
      resolver,
      senders: new SenderRegistry([new InAppSender()]),
      clock: () => NIGHT,
      policySource: async () => policy,
      ...(digests !== undefined ? { digests } : {}),
    };
  }

  it("defers instead of sending inside quiet hours", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    const report = await drainTenant(nightOpts(store, resolver, QUIET), TENANT);

    expect(report.delivered).toBe(0);
    expect(report.deferred).toBe(1);
    expect(store.attempts[0]?.outcome).toBe("deferred");
    expect(store.attempts[0]?.errorCode).toBe(QUIET_HOURS_DEFER_ERROR_CODE);
    expect(() => DeliveryAttemptSchema.parse(store.attempts[0])).not.toThrow();
  });

  it("releases the deferred notice at the end of the quiet window", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    await drainTenant(nightOpts(store, resolver, QUIET), TENANT);

    const releaseAt = store.attempts[0]?.nextRetryAt ?? "";
    expect(Date.parse(releaseAt)).toBeGreaterThan(NIGHT.getTime());
    expect(new Date(releaseAt).toISOString()).toBe("2026-08-24T07:00:00.000Z");
  });

  it("keeps the dispatch sending, not completed, while notices are deferred", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    await drainTenant(nightOpts(store, resolver, QUIET), TENANT);

    expect(store.advances[0]?.update.status).toBe("sending");
    expect(store.advances[0]?.update.completedAt).toBeNull();
  });

  it("sends outside the quiet window", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    const report = await drainTenant(
      { ...nightOpts(store, resolver, QUIET), clock: () => new Date("2026-08-23T12:00:00.000Z") },
      TENANT,
    );

    expect(report.delivered).toBe(1);
    expect(report.deferred).toBe(0);
  });

  it("lets a critical-priority notice through quiet hours", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch({ priority: "critical" }) }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    const report = await drainTenant(nightOpts(store, resolver, QUIET), TENANT);

    expect(report.delivered).toBe(1);
  });

  it("lets a bypass category through quiet hours", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch({ category: "security_alert" }) }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);
    const policy: NotificationPolicy = {
      ...QUIET,
      quietHours: { ...QUIET.quietHours!, bypassCategories: ["security_alert"] },
    };

    const report = await drainTenant(nightOpts(store, resolver, policy), TENANT);

    expect(report.delivered).toBe(1);
  });

  it("drops silently under a drop_silently policy, terminally", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);
    const policy: NotificationPolicy = {
      ...QUIET,
      quietHours: { ...QUIET.quietHours!, behavior: "drop_silently" },
    };

    const report = await drainTenant(nightOpts(store, resolver, policy), TENANT);

    expect(report.dropped).toBe(1);
    expect(store.attempts[0]?.outcome).toBe("dropped");
    expect(store.attempts[0]?.nextRetryAt).toBeNull();
    expect(store.attempts[0]?.errorCode).toBe(QUIET_HOURS_DROP_ERROR_CODE);
    expect(store.advances[0]?.update.status).toBe("failed");
  });

  it("sends when the policy source throws", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    const report = await drainTenant(
      {
        ...nightOpts(store, resolver, QUIET),
        policySource: async () => {
          throw new Error("settings unreadable");
        },
      },
      TENANT,
    );

    expect(report.delivered).toBe(1);
  });

  it("sends when no policy source is wired at all", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    const report = await drainTenant(opts(store, resolver), TENANT);

    expect(report.delivered).toBe(1);
  });
});

describe("delivery-drain — digest batching", () => {
  const BATCH: NotificationPolicy = {
    quietHours: {
      startTime: "22:00",
      endTime: "07:00",
      timezone: "UTC",
      behavior: "batch_until_morning",
      bypassCategories: [],
    },
    digestFrequency: "hourly",
    digestMaxItems: 50,
  };
  const NIGHT = new Date("2026-08-23T23:30:00.000Z");

  class FakeDigests implements DigestStoreLike {
    readonly opened: DigestBatch[] = [];
    readonly added: string[] = [];
    async openOrReuse(_t: string, batch: DigestBatch): Promise<DigestBatch> {
      const existing = this.opened.find((b) => b.id === batch.id);
      if (existing !== undefined) return existing;
      this.opened.push(batch);
      return batch;
    }
    async addItem(_t: string, digestId: string): Promise<DigestAddResult> {
      this.added.push(digestId);
      return { added: true, itemCount: this.added.length, closed: false };
    }
  }

  function batchOpts(
    store: FakeStore,
    resolver: FakeResolver,
    digests: DigestStoreLike,
  ): DeliveryDrainOptions {
    return {
      store,
      resolver,
      senders: new SenderRegistry([new InAppSender()]),
      clock: () => NIGHT,
      policySource: async () => BATCH,
      digests,
    };
  }

  it("pools each recipient into a digest instead of sending", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([
      recipient(USER_A, "a@x.test"),
      recipient(USER_B, "b@x.test"),
    ]);
    const digests = new FakeDigests();

    const report = await drainTenant(batchOpts(store, resolver, digests), TENANT);

    expect(report.batched).toBe(2);
    expect(report.delivered).toBe(0);
    expect(digests.added).toHaveLength(2);
  });

  it("opens one digest per user, not one per dispatch", async () => {
    const store = new FakeStore();
    store.claims = [
      { rowId: "row-1", dispatch: dispatch() },
      { rowId: "row-2", dispatch: dispatch({ id: `disp_${"c".repeat(32)}` }) },
    ];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);
    const digests = new FakeDigests();

    await drainTenant(batchOpts(store, resolver, digests), TENANT);

    expect(digests.opened).toHaveLength(1);
    expect(digests.added).toHaveLength(2);
    expect(digests.added[0]).toBe(digests.added[1]);
  });

  it("releases every notice in a window at the same instant", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([
      recipient(USER_A, "a@x.test"),
      recipient(USER_B, "b@x.test"),
    ]);

    await drainTenant(batchOpts(store, resolver, new FakeDigests()), TENANT);

    const releases = new Set(store.attempts.map((a) => a.nextRetryAt));
    expect(releases.size).toBe(1);
    expect([...releases][0]).toBe("2026-08-24T00:00:00.000Z");
  });

  it("degrades to a plain quiet-hours defer when no digest store is wired", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);

    const report = await drainTenant(
      {
        store,
        resolver,
        senders: new SenderRegistry([new InAppSender()]),
        clock: () => NIGHT,
        policySource: async () => BATCH,
      },
      TENANT,
    );

    expect(report.batched).toBe(1);
    // Still the quantized hourly boundary, so a degraded batch releases together.
    expect(store.attempts[0]?.nextRetryAt).toBe("2026-08-24T00:00:00.000Z");
  });

  it("degrades to a defer when the digest store throws", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "row-1", dispatch: dispatch() }];
    const resolver = new FakeResolver([recipient(USER_A, "a@x.test")]);
    const errors: unknown[] = [];

    const report = await drainTenant(
      {
        ...batchOpts(store, resolver, {
          openOrReuse: async () => {
            throw new Error("digest table gone");
          },
          addItem: async () => ({ added: false, itemCount: 0, closed: false }),
        }),
        onError: (err) => errors.push(err),
      },
      TENANT,
    );

    expect(report.batched).toBe(1);
    expect(errors).toHaveLength(1);
    expect(store.attempts[0]?.outcome).toBe("deferred");
  });
});
