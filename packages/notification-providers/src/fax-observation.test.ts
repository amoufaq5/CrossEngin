import { describe, expect, it } from "vitest";

import {
  handleBounceWebhook,
  recognizeTwilioVoiceStatusCallback,
  VOICE_REACHABILITY_SIGNALS,
  type VoiceReachabilityObservation,
} from "./bounce-webhook.js";
import {
  DEFAULT_FAX_OBSERVATION_WINDOW_HOURS,
  FAX_OBSERVATION_DISPOSITIONS,
  FAX_SUPPRESSION_NOTE_PREFIX,
  MIN_FAX_SUPPRESSION_THRESHOLD,
  applyFaxObservation,
  isUsableFaxThreshold,
  planFaxSuppression,
  windowMsOf,
  type FaxObservationState,
} from "./fax-observation.js";
import { signBody, TEST_TENANT_ID, TEST_WEBHOOK_SECRET } from "./test-fakes.js";

const TENANT = TEST_TENANT_ID;
const NUMBER = "+15551230001";
const NOW = new Date("2026-03-01T12:00:00.000Z");

function voiceBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function completedCall(answeredBy: string, overrides: Record<string, string> = {}): string {
  return voiceBody({
    CallStatus: "completed",
    AnsweredBy: answeredBy,
    To: NUMBER,
    From: "+15559990000",
    CallSid: "CA00000000000000000000000000000001",
    ...overrides,
  });
}

describe("constants", () => {
  it("names both directions a count needs and nothing else", () => {
    expect([...VOICE_REACHABILITY_SIGNALS]).toEqual(["fax_detected", "voice_answered"]);
  });

  it("names four dispositions", () => {
    expect([...FAX_OBSERVATION_DISPOSITIONS]).toEqual([
      "started",
      "advanced",
      "restarted",
      "duplicate",
    ]);
  });

  it("defaults the window to a week", () => {
    expect(DEFAULT_FAX_OBSERVATION_WINDOW_HOURS).toBe(168);
    expect(windowMsOf(undefined)).toBe(168 * 3_600_000);
  });

  it("refuses a threshold of one, because that is a single detector sample", () => {
    expect(MIN_FAX_SUPPRESSION_THRESHOLD).toBe(2);
    expect(isUsableFaxThreshold(1)).toBe(false);
    expect(isUsableFaxThreshold(0)).toBe(false);
    expect(isUsableFaxThreshold(-3)).toBe(false);
    expect(isUsableFaxThreshold(2.5)).toBe(false);
    expect(isUsableFaxThreshold(2)).toBe(true);
    expect(isUsableFaxThreshold(3)).toBe(true);
    // Not configured is a usable configuration: count, suppress nothing.
    expect(isUsableFaxThreshold(null)).toBe(true);
  });

  it("falls back to the default for a nonsense window rather than to zero", () => {
    // A zero or negative window would make every observation stale, so every run would restart at
    // one and the threshold could never be crossed — off, silently, which is the failure mode this
    // whole module exists to end.
    expect(windowMsOf(0)).toBe(windowMsOf(undefined));
    expect(windowMsOf(-1)).toBe(windowMsOf(undefined));
    expect(windowMsOf(Number.NaN)).toBe(windowMsOf(undefined));
    expect(windowMsOf(Number.POSITIVE_INFINITY)).toBe(windowMsOf(undefined));
    expect(windowMsOf(1)).toBe(3_600_000);
  });
});

describe("recognizeTwilioVoiceStatusCallback — the observation", () => {
  it("reports a fax verdict as an observation while still refusing to suppress", () => {
    const result = recognizeTwilioVoiceStatusCallback(completedCall("fax"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.refusal).toBe("event_not_suppressible");
    expect(result.observation).toEqual({
      signal: "fax_detected",
      channel: "voice_call",
      address: NUMBER,
      callSid: "CA00000000000000000000000000000001",
    } satisfies VoiceReachabilityObservation);
  });

  it.each(["human", "machine_start", "machine_end_beep"])(
    "reports %s as voice_answered, which is what resets a run",
    (verdict) => {
      const result = recognizeTwilioVoiceStatusCallback(completedCall(verdict));
      if (result.ok) throw new Error("unreachable");
      expect(result.observation?.signal).toBe("voice_answered");
    },
  );

  it("emits nothing for unknown: the detector declined, which is not evidence either way", () => {
    const result = recognizeTwilioVoiceStatusCallback(completedCall("unknown"));
    if (result.ok) throw new Error("unreachable");
    expect(result.observation).toBeUndefined();
  });

  it("emits nothing when AnsweredBy is absent or not a verdict Twilio defines", () => {
    for (const body of [
      voiceBody({ CallStatus: "completed", To: NUMBER, CallSid: "CA1" }),
      completedCall("facsimile"),
    ]) {
      const result = recognizeTwilioVoiceStatusCallback(body);
      if (result.ok) throw new Error("unreachable");
      expect(result.observation).toBeUndefined();
    }
  });

  it("emits nothing without a CallSid: the count would have no dedup key", () => {
    const result = recognizeTwilioVoiceStatusCallback(
      voiceBody({ CallStatus: "completed", AnsweredBy: "fax", To: NUMBER }),
    );
    if (result.ok) throw new Error("unreachable");
    expect(result.observation).toBeUndefined();
  });

  it("emits nothing for a To that is not a telephone number", () => {
    // The live defect `voice-twilio.ts` guards the other end of: the serving recipient directory
    // hands `voice_call` an email address, and a run of fax verdicts against one would eventually
    // write a permanent row about a mailbox.
    const result = recognizeTwilioVoiceStatusCallback(
      completedCall("fax", { To: "ops@example.test" }),
    );
    if (result.ok) throw new Error("unreachable");
    expect(result.observation).toBeUndefined();
  });

  it("normalises the address, so the count and the eventual row share one key", () => {
    const result = recognizeTwilioVoiceStatusCallback(
      completedCall("fax", { To: "+1 (555) 123-0001" }),
    );
    if (result.ok) throw new Error("unreachable");
    expect(result.observation?.address).toBe(NUMBER);
  });

  it("emits nothing for a failed call: that path has its own error-code verdict", () => {
    const result = recognizeTwilioVoiceStatusCallback(
      voiceBody({ CallStatus: "failed", ErrorCode: "13224", To: NUMBER, CallSid: "CA1" }),
    );
    expect(result.ok).toBe(true);
  });

  it.each(["busy", "no-answer"])("emits nothing for %s even with a fax verdict attached", (status) => {
    // The status is checked before anything else, so a verdict riding along cannot route around it.
    const result = recognizeTwilioVoiceStatusCallback(
      completedCall("fax", { CallStatus: status }),
    );
    if (result.ok) throw new Error("unreachable");
    expect(result.observation).toBeUndefined();
  });
});

describe("handleBounceWebhook carries the observation out", () => {
  const secret = TEST_WEBHOOK_SECRET;
  const nowSeconds = Math.floor(NOW.getTime() / 1000);

  function post(body: string): ReturnType<typeof handleBounceWebhook> {
    return handleBounceWebhook(
      {
        source: "twilio_voice",
        tenantId: TENANT,
        body,
        signatureHeader: signBody(body, nowSeconds),
        now: NOW,
      },
      { secretBytes: secret },
    );
  }

  it("refuses, plans nothing, and still hands the fax verdict over", () => {
    const result = post(completedCall("fax"));
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    expect(result.observation?.signal).toBe("fax_detected");
  });

  it("attaches nothing to an unverified body", () => {
    const body = completedCall("fax");
    const result = handleBounceWebhook(
      {
        source: "twilio_voice",
        tenantId: TENANT,
        body,
        // Well-formed and wrong, so this exercises verification rather than header parsing.
        signatureHeader: signBody(body, nowSeconds, new Uint8Array(32).fill(9)),
        now: NOW,
      },
      { secretBytes: secret },
    );
    if (result.accepted) throw new Error("unreachable");
    // Nothing is believed before the signature verifies, observations included: a counter fed by an
    // unverified POST is a counter an anonymous caller can walk to the threshold.
    expect(result.observation).toBeUndefined();
    expect(result.refusal).toBe("signature_invalid");
  });

  it("attaches nothing on the SES or messaging sources", () => {
    const sesBody = JSON.stringify({ eventType: "Delivery", mail: { messageId: "m" } });
    const ses = handleBounceWebhook(
      {
        source: "ses",
        tenantId: TENANT,
        body: sesBody,
        signatureHeader: signBody(sesBody, nowSeconds),
        now: NOW,
      },
      { secretBytes: secret },
    );
    if (ses.accepted) throw new Error("unreachable");
    expect(ses.observation).toBeUndefined();
  });
});

describe("applyFaxObservation", () => {
  const state = (over: Partial<FaxObservationState> = {}): FaxObservationState => ({
    consecutiveCount: 1,
    lastObservedAt: "2026-03-01T06:00:00.000Z",
    lastCallSid: "CA_OLD",
    ...over,
  });

  it("starts a run when none exists", () => {
    expect(
      applyFaxObservation({ existing: null, observedAt: NOW, callSid: "CA_NEW" }),
    ).toEqual({ consecutiveCount: 1, disposition: "started" });
  });

  it("advances a run inside the window", () => {
    expect(
      applyFaxObservation({ existing: state({ consecutiveCount: 2 }), observedAt: NOW, callSid: "CA_NEW" }),
    ).toEqual({ consecutiveCount: 3, disposition: "advanced" });
  });

  it("does not advance on the same CallSid, because Twilio retries a callback", () => {
    expect(
      applyFaxObservation({
        existing: state({ consecutiveCount: 2, lastCallSid: "CA_SAME" }),
        observedAt: NOW,
        callSid: "CA_SAME",
      }),
    ).toEqual({ consecutiveCount: 2, disposition: "duplicate" });
  });

  it("treats a retry arriving after the window as a retry, not as a fresh run", () => {
    // Duplicate is checked before staleness. The other order would let a single call's late retry
    // open a brand-new run of one, which is a count built from one call.
    expect(
      applyFaxObservation({
        existing: state({
          consecutiveCount: 2,
          lastCallSid: "CA_SAME",
          lastObservedAt: "2026-01-01T00:00:00.000Z",
        }),
        observedAt: NOW,
        callSid: "CA_SAME",
      }),
    ).toEqual({ consecutiveCount: 2, disposition: "duplicate" });
  });

  it("restarts a run older than the window", () => {
    expect(
      applyFaxObservation({
        existing: state({ consecutiveCount: 9, lastObservedAt: "2026-01-01T00:00:00.000Z" }),
        observedAt: NOW,
        callSid: "CA_NEW",
      }),
    ).toEqual({ consecutiveCount: 1, disposition: "restarted" });
  });

  it("restarts rather than advances at exactly one tick past the window", () => {
    const windowHours = 2;
    const last = new Date(NOW.getTime() - windowHours * 3_600_000 - 1).toISOString();
    expect(
      applyFaxObservation({
        existing: state({ consecutiveCount: 4, lastObservedAt: last }),
        observedAt: NOW,
        callSid: "CA_NEW",
        windowHours,
      }),
    ).toEqual({ consecutiveCount: 1, disposition: "restarted" });
    // Exactly at the boundary still advances: the comparison is strictly greater than.
    expect(
      applyFaxObservation({
        existing: state({
          consecutiveCount: 4,
          lastObservedAt: new Date(NOW.getTime() - windowHours * 3_600_000).toISOString(),
        }),
        observedAt: NOW,
        callSid: "CA_NEW",
        windowHours,
      }).disposition,
    ).toBe("advanced");
  });

  it("treats an unparseable stored instant as stale, never as now", () => {
    expect(
      applyFaxObservation({
        existing: state({ consecutiveCount: 7, lastObservedAt: "not-a-date" }),
        observedAt: NOW,
        callSid: "CA_NEW",
      }),
    ).toEqual({ consecutiveCount: 1, disposition: "restarted" });
  });

  it("advances past a stored NULL CallSid rather than reading it as a match", () => {
    expect(
      applyFaxObservation({
        existing: state({ consecutiveCount: 1, lastCallSid: null }),
        observedAt: NOW,
        callSid: "CA_NEW",
      }).disposition,
    ).toBe("advanced");
  });
});

describe("planFaxSuppression", () => {
  const observation: VoiceReachabilityObservation = {
    signal: "fax_detected",
    channel: "voice_call",
    address: NUMBER,
    callSid: "CA1",
  };

  const plan = (
    consecutiveCount: number,
    consecutiveThreshold: number | null,
  ): ReturnType<typeof planFaxSuppression> =>
    planFaxSuppression({
      tenantId: TENANT,
      observation,
      consecutiveCount,
      policy: { consecutiveThreshold },
      observedAt: NOW,
    });

  it("plans nothing when no threshold is configured, which is the default", () => {
    expect(plan(99, null)).toBeNull();
  });

  it("plans nothing below the threshold", () => {
    expect(plan(1, 3)).toBeNull();
    expect(plan(2, 3)).toBeNull();
  });

  it("plans a permanent voice_call hard_bounce at the threshold", () => {
    const record = plan(3, 3);
    expect(record).not.toBeNull();
    expect(record?.channel).toBe("voice_call");
    expect(record?.reason).toBe("hard_bounce");
    // Permanent: a bounded row cannot be renewed by a store whose only conflict action is DO
    // NOTHING, so "bounded" would mean thirty days and then never again.
    expect(record?.expiresAt).toBeNull();
    expect(record?.recipientAddress).toBe(NUMBER);
    expect(record?.appliedBy).toBe("provider:twilio_voice");
    expect(record?.notes).toContain(FAX_SUPPRESSION_NOTE_PREFIX);
    expect(record?.notes).toContain("consecutive=3");
    expect(record?.notes).toContain("threshold=3");
    expect(record?.notes).toContain("window_hours=168");
  });

  it("plans the identical row past the threshold, so re-crossing is a no-op at the store", () => {
    // Not identical *notes* — the run is longer — but the same id, which is what the store dedups
    // on and what keeps `applied_at` from moving.
    expect(plan(4, 3)?.id).toBe(plan(3, 3)?.id);
  });

  it("plans nothing for a voice_answered observation", () => {
    expect(
      planFaxSuppression({
        tenantId: TENANT,
        observation: { ...observation, signal: "voice_answered" },
        consecutiveCount: 99,
        policy: { consecutiveThreshold: 2 },
        observedAt: NOW,
      }),
    ).toBeNull();
  });

  it("plans nothing for a threshold the module will not act on", () => {
    expect(plan(99, 1)).toBeNull();
    expect(plan(99, 0)).toBeNull();
    expect(plan(99, 2.5)).toBeNull();
  });

  it("records the configured window in the note", () => {
    const record = planFaxSuppression({
      tenantId: TENANT,
      observation,
      consecutiveCount: 2,
      policy: { consecutiveThreshold: 2, windowHours: 48 },
      observedAt: NOW,
    });
    expect(record?.notes).toContain("window_hours=48");
  });

  it("plans nothing for an address the contract refuses", () => {
    expect(
      planFaxSuppression({
        tenantId: "not-a-uuid",
        observation,
        consecutiveCount: 5,
        policy: { consecutiveThreshold: 2 },
        observedAt: NOW,
      }),
    ).toBeNull();
  });
});
