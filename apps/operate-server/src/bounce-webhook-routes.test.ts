import { signWebhookPayload } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import { applyFaxObservation } from "@crossengin/notification-providers";
import type { SuppressionRecord } from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import {
  BOUNCE_WEBHOOK_PATH_PREFIX,
  DEFAULT_BOUNCE_SIGNATURE_HEADER,
  buildBounceWebhookInterceptor,
  handleBounceWebhookRequest,
  isBounceWebhookPath,
  parseBounceWebhookTarget,
  type BounceWebhookHttpRequest,
  type BounceWebhookRefusalInfo,
  type BounceWebhookObservedInfo,
  type BounceWebhookRoutesContext,
  type FaxObservationCounterLike,
  type SuppressionWriterLike,
} from "./bounce-webhook-routes.js";
import {
  PostgresSuppressionStore,
  SuppressionWriteConflictError,
  type SuppressionWriteBatch,
  type SuppressionWriteResult,
} from "./suppression-store.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-01T12:00:00.000Z");
const SECRET_A = new Uint8Array(32).fill(7);
const SECRET_B = new Uint8Array(32).fill(9);
const BOUNCED = "bounced@example.test";

const SES_HARD_BOUNCE = JSON.stringify({
  eventType: "Bounce",
  mail: { messageId: "ses-msg-1" },
  bounce: {
    bounceType: "Permanent",
    bounceSubType: "General",
    bouncedRecipients: [{ emailAddress: BOUNCED }],
  },
});

const SES_TWO_RECIPIENTS = JSON.stringify({
  eventType: "Bounce",
  mail: { messageId: "ses-msg-2" },
  bounce: {
    bounceType: "Permanent",
    bounceSubType: "General",
    bouncedRecipients: [{ emailAddress: "one@example.test" }, { emailAddress: "two@example.test" }],
  },
});

const SES_TRANSIENT = JSON.stringify({
  eventType: "Bounce",
  mail: { messageId: "ses-msg-3" },
  bounce: {
    bounceType: "Transient",
    bounceSubType: "MailboxFull",
    bouncedRecipients: [{ emailAddress: BOUNCED }],
  },
});

const SES_DELIVERY = JSON.stringify({
  eventType: "Delivery",
  mail: { messageId: "ses-msg-4" },
  delivery: { recipients: [BOUNCED] },
});

const TWILIO_UNSUBSCRIBED =
  "MessageStatus=failed&To=%2B15550001111&ErrorCode=21610&MessageSid=SM1";
const TWILIO_UNKNOWN_CODE =
  "MessageStatus=failed&To=%2B15550001111&ErrorCode=30003&MessageSid=SM2";

function sign(secret: Uint8Array, body: string, at: Date = NOW): string {
  return signWebhookPayload(secret, body, Math.floor(at.getTime() / 1000)).header;
}

/**
 * An in-memory suppression writer with the table's real uniqueness rules: one row per (tenant,
 * channel, address), and the offered record id reported back only when it is the one that holds the
 * address. The SQL that implements this is proven in `suppression-store.test.ts`; here it stands in
 * so the route's own decisions are what is under test.
 */
function recordingWriter(): {
  writer: SuppressionWriterLike;
  rows: SuppressionRecord[];
  calls: { tenantId: string; count: number }[];
} {
  const rows: SuppressionRecord[] = [];
  const calls: { tenantId: string; count: number }[] = [];
  return {
    rows,
    calls,
    writer: {
      writeAll: async (tenantId, records): Promise<SuppressionWriteBatch> => {
        calls.push({ tenantId, count: records.length });
        const results: SuppressionWriteResult[] = records.map((r) => {
          const held = rows.find(
            (existing) =>
              existing.tenantId === r.tenantId &&
              existing.channel === r.channel &&
              existing.recipientAddress === r.recipientAddress,
          );
          if (held === undefined) {
            rows.push(r);
            return { suppressionId: r.id, outcome: "inserted" };
          }
          return {
            suppressionId: held.id,
            outcome: held.id === r.id ? "already_present" : "address_already_suppressed",
          };
        });
        return {
          results,
          inserted: results.filter((r) => r.outcome === "inserted").length,
          alreadyPresent: results.filter((r) => r.outcome === "already_present").length,
          addressAlreadySuppressed: results.filter(
            (r) => r.outcome === "address_already_suppressed",
          ).length,
        };
      },
    },
  };
}

function throwingWriter(err: unknown): SuppressionWriterLike {
  return {
    writeAll: async (): Promise<SuppressionWriteBatch> => {
      throw err;
    },
  };
}

/** A fake Postgres holding `meta.notification_suppressions`, for the two end-to-end route tests. */
function fakeConn(): { conn: PgConnection; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  let tenant: string | null = null;
  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO")) {
      const taken = rows.some(
        (r) =>
          r["tenant_id"] === tenant &&
          r["tenant_id"] === p[1] &&
          r["channel"] === p[2] &&
          r["recipient_address"] === p[3],
      );
      if (taken) return { rows: [], rowCount: 0 };
      rows.push({
        suppression_id: p[0],
        tenant_id: p[1],
        channel: p[2],
        recipient_address: p[3],
        reason: p[4],
        applied_at: p[5],
        applied_by: p[6],
        expires_at: p[7],
        source_delivery_id: p[8],
        notes: p[9],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT suppression_id FROM")) {
      const matched = rows
        .filter(
          (r) =>
            r["tenant_id"] === tenant &&
            r["tenant_id"] === p[0] &&
            r["channel"] === p[1] &&
            r["recipient_address"] === p[2],
        )
        .map((r) => ({ suppression_id: r["suppression_id"] }));
      return { rows: matched, rowCount: matched.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const tx: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params)) as PgConnection["query"],
    transaction: (async () => {
      throw new Error("nested transaction not supported by fake");
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return {
    rows,
    conn: {
      query: ((sql: string, params?: readonly unknown[]) =>
        run(sql, params)) as PgConnection["query"],
      transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => {
        try {
          return await fn(tx);
        } finally {
          tenant = null;
        }
      }) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
        fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    },
  };
}

function ctxWith(
  writer: SuppressionWriterLike,
  overrides: Partial<BounceWebhookRoutesContext> = {},
): BounceWebhookRoutesContext {
  return {
    store: writer,
    secretForTenant: (tenantId) => (tenantId === TENANT_A ? SECRET_A : null),
    clock: () => NOW,
    ...overrides,
  };
}

function post(opts: {
  readonly body: string;
  readonly signature?: string | null;
  readonly tenantId?: string;
  readonly source?: string;
  readonly method?: string;
  readonly path?: string;
}): BounceWebhookHttpRequest {
  const headers: Record<string, string> = {};
  if (opts.signature !== null) {
    headers[DEFAULT_BOUNCE_SIGNATURE_HEADER] = opts.signature ?? sign(SECRET_A, opts.body);
  }
  return {
    method: opts.method ?? "POST",
    path:
      opts.path ??
      `${BOUNCE_WEBHOOK_PATH_PREFIX}/${opts.tenantId ?? TENANT_A}/${opts.source ?? "ses"}`,
    headers,
    rawBody: opts.body,
  };
}

describe("bounce-webhook-routes — path", () => {
  it("claims its own prefix and nothing else", () => {
    expect(isBounceWebhookPath(`${BOUNCE_WEBHOOK_PATH_PREFIX}/${TENANT_A}/ses`)).toBe(true);
    expect(isBounceWebhookPath(BOUNCE_WEBHOOK_PATH_PREFIX)).toBe(true);
    expect(isBounceWebhookPath("/v1/notifications/bouncesomething")).toBe(false);
    expect(isBounceWebhookPath("/v1/entities/Invoice")).toBe(false);
  });

  it("parses the tenant and source out of the path", () => {
    expect(parseBounceWebhookTarget(`${BOUNCE_WEBHOOK_PATH_PREFIX}/${TENANT_A}/twilio?x=1`)).toEqual(
      { tenantId: TENANT_A, source: "twilio" },
    );
    expect(parseBounceWebhookTarget(`${BOUNCE_WEBHOOK_PATH_PREFIX}/${TENANT_A}/ses/`)).toEqual({
      tenantId: TENANT_A,
      source: "ses",
    });
  });

  it("refuses a target it cannot read as {tenantId}/{source}", () => {
    expect(parseBounceWebhookTarget(`${BOUNCE_WEBHOOK_PATH_PREFIX}/${TENANT_A}`)).toBeNull();
    expect(parseBounceWebhookTarget(`${BOUNCE_WEBHOOK_PATH_PREFIX}/not-a-uuid/ses`)).toBeNull();
    expect(parseBounceWebhookTarget(`${BOUNCE_WEBHOOK_PATH_PREFIX}/${TENANT_A}/sendgrid`)).toBeNull();
    expect(parseBounceWebhookTarget(`${BOUNCE_WEBHOOK_PATH_PREFIX}/${TENANT_A}/ses/extra`)).toBeNull();
  });

  it("404s a path that is not ours and 405s a method that is not POST", async () => {
    const { writer, rows } = recordingWriter();
    const foreign = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE, path: "/v1/entities/Invoice" }),
      ctxWith(writer),
    );
    expect(foreign.status).toBe(404);
    const wrongMethod = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE, method: "GET" }),
      ctxWith(writer),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers?.["allow"]).toBe("POST");
    expect(rows).toEqual([]);
  });

  it("404s an unreadable target without consulting the secret resolver", async () => {
    const { writer, rows } = recordingWriter();
    let resolverCalls = 0;
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE, source: "sendgrid" }),
      ctxWith(writer, {
        secretForTenant: () => {
          resolverCalls += 1;
          return SECRET_A;
        },
      }),
    );
    expect(result.status).toBe(404);
    expect(resolverCalls).toBe(0);
    expect(rows).toEqual([]);
  });
});

describe("bounce-webhook-routes — a verified bounce is recorded", () => {
  it("writes exactly one suppression for a valid signed SES hard bounce", async () => {
    const { writer, rows } = recordingWriter();
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE }),
      ctxWith(writer),
    );
    expect(result.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipientAddress).toBe(BOUNCED);
    expect(rows[0]?.reason).toBe("hard_bounce");
    expect(rows[0]?.tenantId).toBe(TENANT_A);
    expect(rows[0]?.expiresAt).toBeNull();
    expect(result.body["recorded"]).toBe(1);
    expect(result.body["duplicates"]).toBe(0);
    expect(result.body["kind"]).toBe("hard_bounce");
  });

  it("writes one row when the same POST arrives twice inside the tolerance window", async () => {
    const { writer, rows } = recordingWriter();
    const request = post({ body: SES_HARD_BOUNCE });
    const first = await handleBounceWebhookRequest(request, ctxWith(writer));
    const second = await handleBounceWebhookRequest(request, ctxWith(writer));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body["recorded"]).toBe(1);
    expect(second.body["recorded"]).toBe(0);
    expect(second.body["duplicates"]).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it("records a complaint as spam_complaint", async () => {
    const { writer, rows } = recordingWriter();
    const body = JSON.stringify({
      eventType: "Complaint",
      mail: { messageId: "ses-msg-5" },
      complaint: {
        complainedRecipients: [{ emailAddress: BOUNCED }],
        complaintFeedbackType: "abuse",
      },
    });
    const result = await handleBounceWebhookRequest(
      post({ body, signature: sign(SECRET_A, body) }),
      ctxWith(writer),
    );
    expect(result.status).toBe(200);
    expect(rows[0]?.reason).toBe("spam_complaint");
  });

  it("records every bounced recipient of one event in a single write call", async () => {
    const { writer, rows, calls } = recordingWriter();
    const result = await handleBounceWebhookRequest(
      post({ body: SES_TWO_RECIPIENTS, signature: sign(SECRET_A, SES_TWO_RECIPIENTS) }),
      ctxWith(writer),
    );
    expect(result.status).toBe(200);
    expect(result.body["recorded"]).toBe(2);
    expect(rows).toHaveLength(2);
    // One call, so the store can make the pair atomic: a half-recorded bounce is invisible.
    expect(calls).toEqual([{ tenantId: TENANT_A, count: 2 }]);
  });

  it("records a Twilio failure whose error code maps to a reason", async () => {
    const { writer, rows } = recordingWriter();
    const result = await handleBounceWebhookRequest(
      post({
        body: TWILIO_UNSUBSCRIBED,
        source: "twilio",
        signature: sign(SECRET_A, TWILIO_UNSUBSCRIBED),
      }),
      ctxWith(writer),
    );
    expect(result.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe("sms");
    expect(rows[0]?.reason).toBe("unsubscribe");
    expect(rows[0]?.recipientAddress).toBe("+15550001111");
  });

  it("suppresses a transient bounce only when a transient window is configured", async () => {
    const withoutWindow = recordingWriter();
    const refused = await handleBounceWebhookRequest(
      post({ body: SES_TRANSIENT, signature: sign(SECRET_A, SES_TRANSIENT) }),
      ctxWith(withoutWindow.writer),
    );
    expect(refused.status).toBe(422);
    expect(withoutWindow.rows).toEqual([]);

    const withWindow = recordingWriter();
    const accepted = await handleBounceWebhookRequest(
      post({ body: SES_TRANSIENT, signature: sign(SECRET_A, SES_TRANSIENT) }),
      ctxWith(withWindow.writer, { transientSuppressionHours: 6 }),
    );
    expect(accepted.status).toBe(200);
    expect(withWindow.rows[0]?.reason).toBe("soft_bounce_exceeded");
    expect(withWindow.rows[0]?.expiresAt).toBe("2026-09-01T18:00:00.000Z");
  });

  it("returns ids but never the address that bounced", async () => {
    const { writer } = recordingWriter();
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE }),
      ctxWith(writer),
    );
    expect(JSON.stringify(result.body)).not.toContain(BOUNCED);
    const suppressions = result.body["suppressions"] as readonly { suppressionId: string }[];
    expect(suppressions[0]?.suppressionId).toMatch(/^supp_[0-9a-f]{32}$/);
  });

  it("reports the recording through onRecorded with no payload in it", async () => {
    const { writer } = recordingWriter();
    const seen: unknown[] = [];
    await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE }),
      ctxWith(writer, { onRecorded: (info) => seen.push(info) }),
    );
    expect(seen).toEqual([
      { source: "ses", tenantId: TENANT_A, channel: "email", inserted: 1, duplicates: 0 },
    ]);
  });

  it("survives an observer that throws, because the suppression is already written", async () => {
    const { writer, rows } = recordingWriter();
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE }),
      ctxWith(writer, {
        onRecorded: () => {
          throw new Error("logger exploded");
        },
      }),
    );
    expect(result.status).toBe(200);
    expect(rows).toHaveLength(1);
  });
});

describe("bounce-webhook-routes — verification is the authorisation", () => {
  it("writes nothing for an invalid signature and says only that it is unauthorized", async () => {
    const { writer, rows } = recordingWriter();
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE, signature: `t=1788000000,v1=${"0".repeat(64)}` }),
      ctxWith(writer),
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "unauthorized" });
    expect(rows).toEqual([]);
  });

  it("writes nothing when the body was altered after signing", async () => {
    const { writer, rows } = recordingWriter();
    const signature = sign(SECRET_A, SES_HARD_BOUNCE);
    const tampered = SES_HARD_BOUNCE.replace(BOUNCED, "someone-else@example.test");
    const result = await handleBounceWebhookRequest(
      post({ body: tampered, signature }),
      ctxWith(writer),
    );
    expect(result.status).toBe(401);
    expect(rows).toEqual([]);
  });

  it("writes nothing for an unknown tenant, and is indistinguishable from a bad signature", async () => {
    const { writer, rows } = recordingWriter();
    const unknownTenant = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE, tenantId: TENANT_B, signature: sign(SECRET_B, SES_HARD_BOUNCE) }),
      ctxWith(writer),
    );
    const badSignature = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE, signature: `t=1788000000,v1=${"0".repeat(64)}` }),
      ctxWith(writer),
    );
    expect(unknownTenant.status).toBe(401);
    expect(unknownTenant.body).toEqual(badSignature.body);
    expect(rows).toEqual([]);
  });

  it("will not let one tenant's secret sign another tenant's bounces", async () => {
    const { writer, rows } = recordingWriter();
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE, tenantId: TENANT_B, signature: sign(SECRET_A, SES_HARD_BOUNCE) }),
      ctxWith(writer, {
        secretForTenant: (tenantId) => (tenantId === TENANT_A ? SECRET_A : SECRET_B),
      }),
    );
    expect(result.status).toBe(401);
    expect(rows).toEqual([]);
  });

  it("asks the resolver for the tenant named in the path and nothing more", async () => {
    const { writer } = recordingWriter();
    const asked: string[] = [];
    await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE }),
      ctxWith(writer, {
        secretForTenant: (tenantId) => {
          asked.push(tenantId);
          return SECRET_A;
        },
      }),
    );
    expect(asked).toEqual([TENANT_A]);
  });

  it("awaits an async secret resolver", async () => {
    const { writer, rows } = recordingWriter();
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE }),
      ctxWith(writer, { secretForTenant: async () => Promise.resolve(SECRET_A) }),
    );
    expect(result.status).toBe(200);
    expect(rows).toHaveLength(1);
  });

  it("refuses a missing signature header before resolving a secret", async () => {
    const { writer, rows } = recordingWriter();
    let resolverCalls = 0;
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE, signature: null }),
      ctxWith(writer, {
        secretForTenant: () => {
          resolverCalls += 1;
          return SECRET_A;
        },
      }),
    );
    expect(result.status).toBe(401);
    expect(resolverCalls).toBe(0);
    expect(rows).toEqual([]);
  });

  it("refuses a signature whose timestamp is outside the tolerance window", async () => {
    const { writer, rows } = recordingWriter();
    const stale = sign(SECRET_A, SES_HARD_BOUNCE, new Date("2026-09-01T10:00:00.000Z"));
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE, signature: stale }),
      ctxWith(writer),
    );
    expect(result.status).toBe(401);
    expect(rows).toEqual([]);
  });

  it("honours a configured tolerance and signature header name", async () => {
    const { writer, rows } = recordingWriter();
    const stale = sign(SECRET_A, SES_HARD_BOUNCE, new Date("2026-09-01T10:00:00.000Z"));
    const result = await handleBounceWebhookRequest(
      {
        method: "POST",
        path: `${BOUNCE_WEBHOOK_PATH_PREFIX}/${TENANT_A}/ses`,
        headers: { "x-bounce-signature": [stale] },
        rawBody: SES_HARD_BOUNCE,
      },
      ctxWith(writer, {
        toleranceSeconds: 10_000,
        signatureHeaderName: "X-Bounce-Signature",
      }),
    );
    expect(result.status).toBe(200);
    expect(rows).toHaveLength(1);
  });

  it("tells an operator the real reason through onRefusal without leaking the payload", async () => {
    const { writer } = recordingWriter();
    const seen: BounceWebhookRefusalInfo[] = [];
    await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE, tenantId: TENANT_B, signature: sign(SECRET_B, SES_HARD_BOUNCE) }),
      ctxWith(writer, { onRefusal: (info) => seen.push(info) }),
    );
    expect(seen).toEqual([
      { status: 401, reason: "secret_unresolved", source: "ses", tenantId: TENANT_B },
    ]);
    expect(JSON.stringify(seen)).not.toContain(BOUNCED);
  });
});

describe("bounce-webhook-routes — verified but nothing to record", () => {
  it("writes nothing for a provider code that maps to no suppression", async () => {
    const { writer, rows } = recordingWriter();
    const result = await handleBounceWebhookRequest(
      post({
        body: TWILIO_UNKNOWN_CODE,
        source: "twilio",
        signature: sign(SECRET_A, TWILIO_UNKNOWN_CODE),
      }),
      ctxWith(writer),
    );
    expect(result.status).toBe(422);
    expect(result.body["error"]).toBe("event_not_suppressible");
    expect(rows).toEqual([]);
  });

  it("writes nothing for a successful delivery notification", async () => {
    const { writer, rows } = recordingWriter();
    const result = await handleBounceWebhookRequest(
      post({ body: SES_DELIVERY, signature: sign(SECRET_A, SES_DELIVERY) }),
      ctxWith(writer),
    );
    expect(result.status).toBe(422);
    expect(rows).toEqual([]);
  });

  it("400s a verified body it cannot read as a provider event", async () => {
    const { writer, rows } = recordingWriter();
    const body = '{"not":"an event"}';
    const result = await handleBounceWebhookRequest(
      post({ body, signature: sign(SECRET_A, body) }),
      ctxWith(writer),
    );
    expect(result.status).toBe(400);
    expect(result.body["error"]).toBe("payload_unrecognized");
    expect(rows).toEqual([]);
  });

  it("400s an empty body that nonetheless carries a valid signature", async () => {
    const { writer, rows } = recordingWriter();
    const result = await handleBounceWebhookRequest(
      post({ body: "", signature: sign(SECRET_A, "") }),
      ctxWith(writer),
    );
    expect(result.status).toBe(400);
    expect(rows).toEqual([]);
  });
});

describe("bounce-webhook-routes — a failed write is not a 2xx", () => {
  it("503s a lost race so the provider retries into an idempotent write", async () => {
    const seen: unknown[] = [];
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE }),
      ctxWith(throwingWriter(new SuppressionWriteConflictError("c", "supp_abcdef0123")), {
        onError: (err) => seen.push(err),
      }),
    );
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "suppression_write_conflict" });
    expect(seen).toHaveLength(1);
  });

  it("500s any other store failure without echoing its message", async () => {
    const failure = new Error(`duplicate key … (recipient_address)=(${BOUNCED}) already exists`);
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE }),
      ctxWith(throwingWriter(failure)),
    );
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "suppression_write_failed" });
    expect(JSON.stringify(result.body)).not.toContain(BOUNCED);
  });
});

describe("bounce-webhook-routes — over the real store", () => {
  it("records one row through PostgresSuppressionStore, and one again on a replay", async () => {
    const { conn, rows } = fakeConn();
    const ctx = ctxWith(new PostgresSuppressionStore(conn));
    const request = post({ body: SES_HARD_BOUNCE });
    const first = await handleBounceWebhookRequest(request, ctx);
    const second = await handleBounceWebhookRequest(request, ctx);
    expect(first.body["recorded"]).toBe(1);
    expect(second.body["recorded"]).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["reason"]).toBe("hard_bounce");
  });

  it("writes nothing to the real store when the signature does not verify", async () => {
    const { conn, rows } = fakeConn();
    const result = await handleBounceWebhookRequest(
      post({ body: SES_HARD_BOUNCE, signature: `t=1788000000,v1=${"1".repeat(64)}` }),
      ctxWith(new PostgresSuppressionStore(conn)),
    );
    expect(result.status).toBe(401);
    expect(rows).toEqual([]);
  });
});

describe("bounce-webhook-routes — node adapter", () => {
  it("returns null for a request that is not a bounce webhook, so the gateway sees it", async () => {
    const { writer } = recordingWriter();
    const intercept = buildBounceWebhookInterceptor(ctxWith(writer));
    expect(await intercept({ method: "GET", url: "/v1/entities/Invoice", headers: {} }, null)).toBeNull();
  });

  it("decodes the raw body and answers with JSON bytes", async () => {
    const { writer, rows } = recordingWriter();
    const intercept = buildBounceWebhookInterceptor(ctxWith(writer));
    const response = await intercept(
      {
        method: "POST",
        url: `${BOUNCE_WEBHOOK_PATH_PREFIX}/${TENANT_A}/ses?x=1`,
        headers: { [DEFAULT_BOUNCE_SIGNATURE_HEADER]: sign(SECRET_A, SES_HARD_BOUNCE) },
      },
      new TextEncoder().encode(SES_HARD_BOUNCE),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers["content-type"]).toBe("application/json");
    expect(rows).toHaveLength(1);
    const decoded = JSON.parse(new TextDecoder().decode(response?.body ?? new Uint8Array())) as {
      recorded: number;
    };
    expect(decoded.recorded).toBe(1);
  });

  it("refuses a bodyless POST rather than treating it as an empty verified event", async () => {
    const { writer, rows } = recordingWriter();
    const intercept = buildBounceWebhookInterceptor(ctxWith(writer));
    const response = await intercept(
      {
        method: "POST",
        url: `${BOUNCE_WEBHOOK_PATH_PREFIX}/${TENANT_A}/ses`,
        headers: { [DEFAULT_BOUNCE_SIGNATURE_HEADER]: sign(SECRET_A, SES_HARD_BOUNCE) },
      },
      null,
    );
    expect(response?.status).toBe(401);
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The voice reachability counter (ADR-0310's open `fax` verdict)
// ---------------------------------------------------------------------------

const VOICE_NUMBER = "+15551230001";

function voiceCallback(fields: Record<string, string>): string {
  return new URLSearchParams({
    CallStatus: "completed",
    To: VOICE_NUMBER,
    From: "+15559990000",
    ...fields,
  }).toString();
}

/**
 * An in-memory counter with the store's rules, so the route's own decisions are what is under test.
 * The SQL that implements these is proven in `fax-observation-store.test.ts`, and the live test
 * proves the two agree.
 */
function recordingCounter(): {
  counter: FaxObservationCounterLike;
  runs: Map<string, { count: number; lastSid: string | null; suppressedAt: string | null }>;
  cleared: string[];
} {
  const runs = new Map<
    string,
    { count: number; lastSid: string | null; suppressedAt: string | null }
  >();
  const cleared: string[] = [];
  return {
    runs,
    cleared,
    counter: {
      observe: async (tenantId, observation, at, windowHours) => {
        const key = `${tenantId}|${observation.address}`;
        const existing = runs.get(key) ?? null;
        const outcome = applyFaxObservation({
          existing:
            existing === null
              ? null
              : {
                  consecutiveCount: existing.count,
                  lastObservedAt: at.toISOString(),
                  lastCallSid: existing.lastSid,
                },
          observedAt: at,
          callSid: observation.callSid,
          windowHours,
        });
        runs.set(key, {
          count: outcome.consecutiveCount,
          lastSid: observation.callSid,
          suppressedAt: existing?.suppressedAt ?? null,
        });
        return {
          consecutiveCount: outcome.consecutiveCount,
          disposition: outcome.disposition,
          suppressedAt: existing?.suppressedAt ?? null,
        };
      },
      markSuppressed: async (tenantId, address, at) => {
        const key = `${tenantId}|${address}`;
        const run = runs.get(key);
        if (run !== undefined && run.suppressedAt === null) {
          runs.set(key, { ...run, suppressedAt: at.toISOString() });
        }
      },
      clearRun: async (tenantId, address) => {
        const key = `${tenantId}|${address}`;
        const had = runs.has(key);
        if (had) cleared.push(address);
        runs.delete(key);
        return had;
      },
    },
  };
}

function throwingCounter(): FaxObservationCounterLike {
  return {
    observe: async () => {
      throw new Error("db down");
    },
    markSuppressed: async () => undefined,
    clearRun: async () => false,
  };
}

async function postVoice(
  ctx: BounceWebhookRoutesContext,
  body: string,
): Promise<Awaited<ReturnType<typeof handleBounceWebhookRequest>>> {
  return handleBounceWebhookRequest(
    {
      method: "POST",
      path: `${BOUNCE_WEBHOOK_PATH_PREFIX}/${TENANT_A}/twilio_voice`,
      headers: { [DEFAULT_BOUNCE_SIGNATURE_HEADER]: sign(SECRET_A, body) },
      rawBody: body,
    },
    ctx,
  );
}

describe("fax observations", () => {
  function context(
    over: Partial<BounceWebhookRoutesContext> = {},
  ): {
    ctx: BounceWebhookRoutesContext;
    writer: ReturnType<typeof recordingWriter>;
    counter: ReturnType<typeof recordingCounter>;
    observed: BounceWebhookObservedInfo[];
  } {
    const writer = recordingWriter();
    const counter = recordingCounter();
    const observed: BounceWebhookObservedInfo[] = [];
    return {
      writer,
      counter,
      observed,
      ctx: {
        store: writer.writer,
        secretForTenant: (t) => (t === TENANT_A ? SECRET_A : null),
        clock: () => NOW,
        faxObservations: counter.counter,
        onObserved: (info) => observed.push(info),
        ...over,
      },
    };
  }

  it("behaves exactly as before when no counter is configured", async () => {
    const writer = recordingWriter();
    const response = await postVoice(
      {
        store: writer.writer,
        secretForTenant: () => SECRET_A,
        clock: () => NOW,
      },
      voiceCallback({ AnsweredBy: "fax", CallSid: "CA1" }),
    );
    expect(response.status).toBe(422);
    expect(response.body["error"]).toBe("event_not_suppressible");
    expect(writer.rows).toHaveLength(0);
  });

  it("counts a fax verdict, writes nothing, and answers 200 so Twilio stops retrying", async () => {
    const { ctx, writer, observed } = context();
    const response = await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA1" }));
    // 200 and not 422: something was durably recorded. Twilio retries a non-2xx indefinitely, so a
    // 422 here would have every answered call redelivered forever.
    expect(response.status).toBe(200);
    expect(response.body["recorded"]).toBe(0);
    expect(response.body["observation"]).toEqual({
      signal: "fax_detected",
      disposition: "started",
      consecutive: 1,
      suppressed: false,
    });
    expect(writer.rows).toHaveLength(0);
    expect(observed).toEqual([
      {
        tenantId: TENANT_A,
        signal: "fax_detected",
        disposition: "started",
        consecutiveCount: 1,
        suppressionPlanned: false,
      },
    ]);
  });

  it("never returns the number or the CallSid", async () => {
    const { ctx } = context();
    const response = await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA1" }));
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(VOICE_NUMBER);
    expect(serialized).not.toContain("CA1");
  });

  it("counts but never suppresses with no threshold configured, which is the default", async () => {
    const { ctx, writer } = context();
    for (const sid of ["CA1", "CA2", "CA3", "CA4", "CA5"]) {
      const response = await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: sid }));
      expect(response.status).toBe(200);
      expect(response.body["observation"]).toMatchObject({ suppressed: false });
    }
    expect(writer.rows).toHaveLength(0);
  });

  it("suppresses exactly at the threshold, and not before", async () => {
    const { ctx, writer, observed } = context({ faxSuppressAfter: 3 });
    for (const sid of ["CA1", "CA2"]) {
      await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: sid }));
    }
    expect(writer.rows).toHaveLength(0);
    const crossing = await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA3" }));
    expect(crossing.status).toBe(200);
    expect(crossing.body["kind"]).toBe("voice_fax_threshold");
    expect(crossing.body["recorded"]).toBe(1);
    expect(writer.rows).toHaveLength(1);
    const row = writer.rows[0];
    expect(row?.channel).toBe("voice_call");
    expect(row?.reason).toBe("hard_bounce");
    expect(row?.recipientAddress).toBe(VOICE_NUMBER);
    expect(row?.appliedBy).toBe("provider:twilio_voice");
    expect(row?.notes).toContain("consecutive=3");
    expect(observed.at(-1)?.suppressionPlanned).toBe(true);
  });

  it("stamps the crossing only after the suppression lands", async () => {
    const { ctx, counter } = context({ faxSuppressAfter: 2 });
    await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA1" }));
    expect(counter.runs.get(`${TENANT_A}|${VOICE_NUMBER}`)?.suppressedAt).toBeNull();
    await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA2" }));
    expect(counter.runs.get(`${TENANT_A}|${VOICE_NUMBER}`)?.suppressedAt).toBe(NOW.toISOString());
  });

  it("does not stamp a crossing whose suppression write failed", async () => {
    const { counter } = context();
    const ctx: BounceWebhookRoutesContext = {
      store: throwingWriter(new Error("nope")),
      secretForTenant: () => SECRET_A,
      clock: () => NOW,
      faxObservations: counter.counter,
      faxSuppressAfter: 2,
    };
    await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA1" }));
    const response = await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA2" }));
    expect(response.status).toBe(500);
    // A `suppressed_at` written before the suppression would say an address was blocked when it was
    // not — ADR-0317's shape.
    expect(counter.runs.get(`${TENANT_A}|${VOICE_NUMBER}`)?.suppressedAt).toBeNull();
  });

  it("re-crossing presents the identical row, which the store declines", async () => {
    const { ctx, writer } = context({ faxSuppressAfter: 2 });
    for (const sid of ["CA1", "CA2"]) {
      await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: sid }));
    }
    const again = await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA3" }));
    expect(again.body["recorded"]).toBe(0);
    expect(again.body["duplicates"]).toBe(1);
    expect(writer.rows).toHaveLength(1);
  });

  it("does not advance on a retried callback", async () => {
    // Twilio retries a callback that did not answer 2xx, and a count has no idempotency of its own.
    const { ctx, writer } = context({ faxSuppressAfter: 3 });
    for (let i = 0; i < 5; i++) {
      const response = await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA1" }));
      expect(response.body["observation"]).toMatchObject({ consecutive: 1 });
    }
    expect(writer.rows).toHaveLength(0);
  });

  it.each(["human", "machine_start", "machine_end_beep"])(
    "resets the run when %s answers",
    async (verdict) => {
      const { ctx, writer, counter } = context({ faxSuppressAfter: 3 });
      await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA1" }));
      await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA2" }));
      const answered = await postVoice(ctx, voiceCallback({ AnsweredBy: verdict, CallSid: "CA3" }));
      expect(answered.status).toBe(200);
      expect(answered.body["observation"]).toEqual({
        signal: "voice_answered",
        disposition: "cleared",
        consecutive: 0,
        suppressed: false,
      });
      expect(counter.cleared).toEqual([VOICE_NUMBER]);
      // And the run really is gone: the next two fax verdicts are a run of two, not of four.
      await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA4" }));
      const second = await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA5" }));
      expect(second.body["observation"]).toMatchObject({ consecutive: 2 });
      expect(writer.rows).toHaveLength(0);
    },
  );

  it("reports a reset that undid nothing distinctly from one that did", async () => {
    const { ctx } = context();
    const response = await postVoice(ctx, voiceCallback({ AnsweredBy: "human", CallSid: "CA1" }));
    expect(response.body["observation"]).toMatchObject({ disposition: "no_run" });
  });

  it("leaves the run alone for an unknown verdict", async () => {
    const { ctx, counter } = context({ faxSuppressAfter: 3 });
    await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA1" }));
    const unknown = await postVoice(ctx, voiceCallback({ AnsweredBy: "unknown", CallSid: "CA2" }));
    // The detector declined, which is not evidence either way — so neither advance nor reset.
    expect(unknown.status).toBe(422);
    expect(unknown.body["observation"]).toBeUndefined();
    expect(counter.runs.get(`${TENANT_A}|${VOICE_NUMBER}`)?.count).toBe(1);
  });

  it.each(["busy", "no-answer"])("leaves the run alone on %s", async (status) => {
    const { ctx, counter } = context({ faxSuppressAfter: 3 });
    await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: "CA1" }));
    const unanswered = await postVoice(
      ctx,
      voiceCallback({ CallStatus: status, AnsweredBy: "fax", CallSid: "CA2" }),
    );
    expect(unanswered.status).toBe(422);
    expect(counter.runs.get(`${TENANT_A}|${VOICE_NUMBER}`)?.count).toBe(1);
  });

  it("refuses a threshold below the minimum rather than suppressing on one sample", async () => {
    const { ctx, writer } = context({ faxSuppressAfter: 1 });
    for (const sid of ["CA1", "CA2", "CA3"]) {
      await postVoice(ctx, voiceCallback({ AnsweredBy: "fax", CallSid: sid }));
    }
    expect(writer.rows).toHaveLength(0);
  });

  it("refuses the request when the observation cannot be stored", async () => {
    const writer = recordingWriter();
    const errors: unknown[] = [];
    const response = await postVoice(
      {
        store: writer.writer,
        secretForTenant: () => SECRET_A,
        clock: () => NOW,
        faxObservations: throwingCounter(),
        faxSuppressAfter: 2,
        onError: (err) => errors.push(err),
      },
      voiceCallback({ AnsweredBy: "fax", CallSid: "CA1" }),
    );
    // A run whose length is unknown is not a run, and a 503 has the provider retry — which is safe
    // because the counter's dedup key is the CallSid.
    expect(response.status).toBe(503);
    expect(response.body["error"]).toBe("fax_observation_write_failed");
    expect(errors).toHaveLength(1);
    expect(writer.rows).toHaveLength(0);
  });

  it("counts nothing from an unverified body", async () => {
    const { ctx, counter } = context({ faxSuppressAfter: 2 });
    const body = voiceCallback({ AnsweredBy: "fax", CallSid: "CA1" });
    const response = await handleBounceWebhookRequest(
      {
        method: "POST",
        path: `${BOUNCE_WEBHOOK_PATH_PREFIX}/${TENANT_A}/twilio_voice`,
        headers: { [DEFAULT_BOUNCE_SIGNATURE_HEADER]: sign(SECRET_B, body) },
        rawBody: body,
      },
      ctx,
    );
    expect(response.status).toBe(401);
    // A counter fed by an unverified POST is a counter an anonymous caller walks to the threshold.
    expect(counter.runs.size).toBe(0);
  });

  it("keeps a provider-reported voice failure on its own path", async () => {
    const { ctx, writer, counter } = context({ faxSuppressAfter: 2 });
    const body = new URLSearchParams({
      CallStatus: "failed",
      ErrorCode: "13224",
      To: VOICE_NUMBER,
      CallSid: "CA9",
    }).toString();
    const response = await postVoice(ctx, body);
    expect(response.status).toBe(200);
    expect(response.body["kind"]).toBe("voice_failure");
    expect(writer.rows).toHaveLength(1);
    // A carrier verdict needs no run behind it, so nothing was counted.
    expect(counter.runs.size).toBe(0);
  });
});
