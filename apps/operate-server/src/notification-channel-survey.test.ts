import { NOTIFICATION_CHANNELS, type NotificationChannel } from "@crossengin/notifications";
import {
  readWorkspaceSources,
  scanWorkspaceSql,
  stripComments,
} from "@crossengin/testing/strategy";
import { describe, expect, it } from "vitest";

import type { StoreKind } from "./cli.js";
import {
  NOTIFICATION_CHANNEL_VERDICT_DISPOSITION,
  formatNotificationChannelSurvey,
  surveyNotificationChannels,
  type DispatchProducer,
  type NotificationChannelSurveyInput,
  type NotificationChannelVerdict,
} from "./notification-channel-survey.js";

const ALL_PRODUCERS: ReadonlySet<DispatchProducer> = new Set(["design_review_decision"]);
const NONE: ReadonlySet<DispatchProducer> = new Set();

/** The shipped compose: `--store pg`, design review, a drain, and no SES or Twilio variable set. */
const SHIPPED: NotificationChannelSurveyInput = {
  registeredChannels: ["in_app"],
  mountedProducers: ALL_PRODUCERS,
  drainMounted: true,
  storeKind: "pg",
};

function verdicts(
  input: NotificationChannelSurveyInput,
): Record<NotificationChannel, NotificationChannelVerdict | undefined> {
  const out: Record<NotificationChannel, NotificationChannelVerdict | undefined> = {
    in_app: undefined,
    email: undefined,
    sms: undefined,
    push_mobile: undefined,
    webhook: undefined,
    voice_call: undefined,
  };
  for (const c of surveyNotificationChannels(input).channels) out[c.channel] = c.verdict;
  return out;
}

function text(input: NotificationChannelSurveyInput): string {
  return formatNotificationChannelSurvey(surveyNotificationChannels(input))
    .map((l) => l.line)
    .join("\n");
}

function levels(input: NotificationChannelSurveyInput): readonly string[] {
  return formatNotificationChannelSurvey(surveyNotificationChannels(input)).map((l) => l.level);
}

describe("surveyNotificationChannels", () => {
  it("answers once per channel, in NOTIFICATION_CHANNELS order", () => {
    expect(surveyNotificationChannels(SHIPPED).channels.map((c) => c.channel)).toEqual([
      ...NOTIFICATION_CHANNELS,
    ]);
  });

  it("says in_app delivers on the shipped compose, at info, with nothing else to report", () => {
    const v = verdicts(SHIPPED);
    expect(v.in_app).toBe("delivers");
    for (const c of NOTIFICATION_CHANNELS.filter((x) => x !== "in_app")) {
      expect(v[c]).toBe("not_registered");
    }
    expect(levels(SHIPPED)).toEqual(["info"]);
    expect(text(SHIPPED)).toBe(
      "[notify] channels — in_app: delivers to the recipients each audience resolves to",
    );
  });

  it("warns that a configured SES/Twilio sender sends nothing, and names no remedy", () => {
    const input = { ...SHIPPED, registeredChannels: ["in_app", "email", "sms"] } as const;
    const v = verdicts(input);
    expect(v.email).toBe("registered_without_producer");
    expect(v.sms).toBe("registered_without_producer");
    expect(v.in_app).toBe("delivers");
    expect(levels(input)).toEqual(["info", "warn"]);
    const out = text(input);
    expect(out).toContain("email, sms: a sender is registered and no message will ever be sent");
    expect(out).toContain("every dispatch this binary writes is on in_app");
    expect(out).toContain("No flag or environment variable changes that.");
    expect(out).toContain(
      "[notify] channels — email, sms: sender registered, no producer in this binary; in_app: delivers to",
    );
  });

  it("does not say delivers when the only producer is not mounted (a --read-state-routes-only deployment)", () => {
    const input = { ...SHIPPED, mountedProducers: NONE };
    expect(verdicts(input).in_app).toBe("producer_unmounted");
    const out = text(input);
    expect(out).not.toContain("delivers");
    expect(out).toContain("--require-design-review");
    expect(levels(input)).toEqual(["info", "info"]);
  });

  it("does not say delivers with no drain, so it cannot contradict the drain-absence warning", () => {
    const input = { ...SHIPPED, drainMounted: false };
    expect(verdicts(input).in_app).toBe("no_drain");
    expect(text(input)).not.toContain("delivers");
  });

  it("names the memory store rather than an unmounted producer when nothing can be stored", () => {
    expect(verdicts({ ...SHIPPED, storeKind: "memory", mountedProducers: NONE }).in_app).toBe(
      "no_durable_store",
    );
  });

  it("keeps the idle-sender warning ahead of every deployment fact, because none of them fixes it", () => {
    for (const storeKind of ["memory", "pg", "pg-columns"] as const) {
      for (const drainMounted of [true, false]) {
        const v = verdicts({
          registeredChannels: ["email"],
          mountedProducers: NONE,
          drainMounted,
          storeKind,
        });
        expect(v.email).toBe("registered_without_producer");
      }
    }
  });

  it("states the drop for a produced channel with no sender, from the drain's own ladder", () => {
    const input = { ...SHIPPED, registeredChannels: [] };
    expect(verdicts(input).in_app).toBe("produced_without_sender");
    // 30 + 60 + 120 + 240: measured from `decideRetry` at the drain's defaults (attempt 5 is
    // `max_attempts_exhausted`). A change to the ladder should land here and be read.
    expect(text(input)).toContain("no_sender_configured, is retried for about 450s of backoff");
    expect(levels(input)).toContain("warn");
  });

  it("reaches every verdict the disposition map declares, and no other", () => {
    const stores: readonly StoreKind[] = ["memory", "pg", "pg-columns"];
    const subsets: readonly (readonly NotificationChannel[])[] = [
      [],
      ["in_app"],
      ["in_app", "email"],
      ["email"],
    ];
    const reached = new Set<NotificationChannelVerdict>();
    let combos = 0;
    for (const storeKind of stores)
      for (const drainMounted of [true, false])
        for (const mountedProducers of [ALL_PRODUCERS, NONE])
          for (const registeredChannels of subsets) {
            combos += 1;
            for (const c of surveyNotificationChannels({
              storeKind,
              drainMounted,
              mountedProducers,
              registeredChannels,
            }).channels)
              reached.add(c.verdict);
          }
    expect(combos).toBe(48);
    expect([...reached].sort()).toEqual(
      Object.keys(NOTIFICATION_CHANNEL_VERDICT_DISPOSITION).sort(),
    );
  });
});

/**
 * The map of which channels have a producer is a declaration, and a declaration nothing compares
 * goes stale silently. These read the workspace from disk and anchor on what a second producer
 * cannot avoid: the table's one INSERT, the store's constructions, and the dispatch row's own
 * `audienceJson` field, which a producer must supply (it is required on `DispatchInput`). They
 * deliberately do not key on a receiver's variable name or on a `channel: "…"` literal anywhere,
 * since a template's content carries one and the digest summary takes its channel from a variable.
 */
describe("the producer map against the workspace", () => {
  const sources = readWorkspaceSources().files.filter((f) => !f.file.endsWith(".test.ts"));

  it("finds exactly one INSERT into meta.notification_dispatches, in the notification store", () => {
    const scan = scanWorkspaceSql();
    const inserts = scan.statements.filter((s) => s.kind === "insert");
    // Non-vacuity: the scanner sees the workspace's inserts and this table's other statements.
    expect(inserts.length).toBeGreaterThan(50);
    expect(
      scan.statements.filter((s) => s.table === "notification_dispatches").length,
    ).toBeGreaterThanOrEqual(4);
    expect(inserts.filter((s) => s.table === "notification_dispatches").map((s) => s.file)).toEqual(
      ["apps/operate-server/src/notification-store.ts"],
    );
  });

  it("constructs PostgresNotificationStore only where its two callers are wired", () => {
    const counts = new Map<string, number>();
    for (const f of sources) {
      const n = (stripComments(f.text).match(/\bnew\s+PostgresNotificationStore\s*\(/g) ?? [])
        .length;
      if (n > 0) counts.set(f.file, n);
    }
    // node.ts: the design-review notifier's store, and the digest assembler's sink. A third
    // construction is a third way into the table — re-adjudicate the producer map before moving
    // this number.
    expect(Object.fromEntries(counts)).toEqual({ "apps/operate-server/src/node.ts": 2 });
  });

  type AudienceRole = "declares_shape" | "maps_stored_row" | "originates" | "inherits";
  const AUDIENCE_ROLES: Readonly<Record<string, AudienceRole>> = {
    "apps/operate-server/src/notification-store.ts": "declares_shape",
    "packages/notifications/src/delivery.ts": "declares_shape",
    "apps/operate-server/src/delivery-store.ts": "maps_stored_row",
    "apps/operate-server/src/design-notifications.ts": "originates",
    "apps/operate-server/src/digest-assembly.ts": "inherits",
  };
  const audienceFiles = sources.filter((f) =>
    /\baudienceJson\s*\??\s*:/.test(stripComments(f.text)),
  );

  it("accounts for every module that writes an audienceJson, in both directions", () => {
    expect(audienceFiles.length).toBeGreaterThanOrEqual(3);
    expect(audienceFiles.map((f) => f.file).sort()).toEqual(Object.keys(AUDIENCE_ROLES).sort());
  });

  it("matches the channels an originating builder writes to the channels the survey says are produced", () => {
    const written = new Set<string>();
    for (const f of audienceFiles.filter((x) => AUDIENCE_ROLES[x.file] === "originates")) {
      for (const m of stripComments(f.text).matchAll(/\bchannel\s*:\s*"([a-z_]+)"/g)) {
        written.add(m[1] ?? "");
      }
    }
    expect(written.size).toBeGreaterThan(0);
    const produced = surveyNotificationChannels({
      registeredChannels: [...NOTIFICATION_CHANNELS],
      mountedProducers: ALL_PRODUCERS,
      drainMounted: true,
      storeKind: "pg",
    })
      .channels.filter((c) => c.verdict === "delivers")
      .map((c) => c.channel);
    expect([...written].sort()).toEqual([...produced].sort());
  });

  it("keeps the digest summary's channel inherited rather than chosen", () => {
    const digest = audienceFiles.find((f) => AUDIENCE_ROLES[f.file] === "inherits");
    const body = stripComments(digest?.text ?? "");
    expect(body).toMatch(/\bchannel\s*:\s*input\.digest\.channel\b/);
    expect(body).not.toMatch(/\bchannel\s*:\s*"/);
  });
});
