import {
  DELIVERY_OUTCOMES,
  PROVIDER_KINDS,
  RETRYABLE_DELIVERY_OUTCOMES,
  TERMINAL_DELIVERY_OUTCOMES,
  type NotificationChannel,
} from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import {
  CHANNEL_MISMATCH_ERROR_CODE,
  DEFAULT_SEND_TIMEOUT_MS,
  InAppSender,
  MAX_ERROR_MESSAGE_LENGTH,
  SEND_TIMEOUT_ERROR_CODE,
  SENDER_THREW_ERROR_CODE,
  SenderRegistry,
  UNROUTED_ERROR_CODE,
  UnroutableChannelSender,
  defaultSenderRegistry,
  sendWithTimeout,
  truncateErrorMessage,
  unroutedResult,
  type ChannelSender,
  type SendRequest,
  type SendResult,
  type SendTimer,
} from "./delivery-senders.js";

const TENANT_ID = "6f1b1a1e-0f5a-4d7a-9a1c-2b3c4d5e6f70";
const DISPATCH_ID = "disp_01HZY8Q9K3N4P5R6S7T8V9W0X1";

const IN_APP_REQUEST: SendRequest = {
  dispatchId: DISPATCH_ID,
  tenantId: TENANT_ID,
  channel: "in_app",
  templateId: "design_review.approved",
  locale: "en",
  recipientAddress: "user:11111111-2222-4333-8444-555555555555",
  attemptNumber: 1,
};

interface ScheduledTimer {
  readonly handle: number;
  readonly fn: () => void;
  readonly ms: number;
}

class FakeTimer implements SendTimer {
  readonly scheduled: ScheduledTimer[] = [];
  readonly cleared: unknown[] = [];
  private nextHandle = 1;

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.scheduled.push({ handle, fn, ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.cleared.push(handle);
  }

  fireAll(): void {
    for (const entry of [...this.scheduled]) entry.fn();
  }

  pending(): readonly ScheduledTimer[] {
    return this.scheduled.filter((entry) => !this.cleared.includes(entry.handle));
  }
}

function stubSender(
  channel: NotificationChannel,
  send: (request: SendRequest) => Promise<SendResult>,
): ChannelSender {
  return { channel, provider: "webhook_http", send };
}

const HANGING_SENDER = stubSender(
  "webhook",
  () => new Promise<SendResult>(() => undefined),
);

describe("module constants", () => {
  it("declares a ten-second default send budget", () => {
    expect(DEFAULT_SEND_TIMEOUT_MS).toBe(10_000);
  });

  it("caps error messages at the DeliveryAttempt schema limit", () => {
    expect(MAX_ERROR_MESSAGE_LENGTH).toBe(500);
  });

  it("names the unrouted code and keeps every code within the 80-char column", () => {
    expect(UNROUTED_ERROR_CODE).toBe("no_sender_configured");
    for (const code of [
      UNROUTED_ERROR_CODE,
      CHANNEL_MISMATCH_ERROR_CODE,
      SEND_TIMEOUT_ERROR_CODE,
      SENDER_THREW_ERROR_CODE,
    ]) {
      expect(code.length).toBeLessThanOrEqual(80);
    }
  });

  it("truncates only what exceeds the limit", () => {
    expect(truncateErrorMessage("short")).toBe("short");
    expect(truncateErrorMessage("x".repeat(900))).toHaveLength(500);
  });
});

describe("InAppSender", () => {
  it("declares the in_app channel and a real provider kind", () => {
    const sender = new InAppSender();
    expect(sender.channel).toBe("in_app");
    expect(PROVIDER_KINDS).toContain(sender.provider);
  });

  it("resolves delivered with the dispatch id as the provider message id", async () => {
    const result = await new InAppSender().send(IN_APP_REQUEST);
    expect(result.outcome).toBe("delivered");
    expect(result.providerMessageId).toBe(DISPATCH_ID);
  });

  it("reports no http status, no bytes sent, and no error", async () => {
    const result = await new InAppSender().send(IN_APP_REQUEST);
    expect(result.httpStatus).toBeNull();
    expect(result.bytesSent).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
  });

  it("is a terminal sink — delivered needs no retry", async () => {
    const result = await new InAppSender().send(IN_APP_REQUEST);
    expect(TERMINAL_DELIVERY_OUTCOMES.has(result.outcome)).toBe(true);
  });

  it("rejects a foreign channel with failed rather than throwing", async () => {
    const result = await new InAppSender().send({
      ...IN_APP_REQUEST,
      channel: "sms",
    });
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe(CHANNEL_MISMATCH_ERROR_CODE);
  });

  it("names the offending channel and mints no message id", async () => {
    const result = await new InAppSender().send({
      ...IN_APP_REQUEST,
      channel: "voice_call",
    });
    expect(result.errorMessage).toContain("voice_call");
    expect(result.providerMessageId).toBeNull();
  });
});

describe("SenderRegistry", () => {
  it("starts empty and misses on an unregistered channel", () => {
    const registry = new SenderRegistry();
    expect(registry.channels()).toEqual([]);
    expect(registry.for("email")).toBeNull();
  });

  it("seeds senders from the constructor", () => {
    const sender = new InAppSender();
    expect(new SenderRegistry([sender]).for("in_app")).toBe(sender);
  });

  it("registers a sender after construction", () => {
    const registry = new SenderRegistry();
    const sender = stubSender("webhook", async () => unroutedResult("webhook"));
    registry.register(sender);
    expect(registry.for("webhook")).toBe(sender);
  });

  it("lets the last registration for a channel win", () => {
    const registry = new SenderRegistry([new InAppSender()]);
    const override = stubSender("in_app", async () => unroutedResult("in_app"));
    registry.register(override);
    expect(registry.for("in_app")).toBe(override);
  });

  it("does not duplicate an overridden channel in channels()", () => {
    const registry = new SenderRegistry([new InAppSender()]);
    registry.register(stubSender("in_app", async () => unroutedResult("in_app")));
    expect(registry.channels()).toEqual(["in_app"]);
  });

  it("lists every registered channel", () => {
    const registry = new SenderRegistry([
      new InAppSender(),
      stubSender("webhook", async () => unroutedResult("webhook")),
    ]);
    expect([...registry.channels()].sort()).toEqual(["in_app", "webhook"]);
  });

  it("defaults to in-app only — the one sender implementable today", () => {
    const registry = defaultSenderRegistry();
    expect(registry.channels()).toEqual(["in_app"]);
    expect(registry.for("in_app")).toBeInstanceOf(InAppSender);
    expect(registry.for("email")).toBeNull();
  });
});

describe("unroutedResult", () => {
  it("fails rather than silently dropping the dispatch", () => {
    const result = unroutedResult("email");
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe(UNROUTED_ERROR_CODE);
  });

  it("names the channel that has no sender", () => {
    expect(unroutedResult("push_mobile").errorMessage).toContain("push_mobile");
  });

  it("is retryable — configuring the sender and re-draining should deliver", () => {
    expect(RETRYABLE_DELIVERY_OUTCOMES.has(unroutedResult("sms").outcome)).toBe(
      true,
    );
  });

  it("carries a real provider kind and no delivery metadata", () => {
    const result = unroutedResult("voice_call");
    expect(PROVIDER_KINDS).toContain(result.provider);
    expect(result.providerMessageId).toBeNull();
    expect(result.httpStatus).toBeNull();
    expect(result.bytesSent).toBeNull();
  });

  it("is what UnroutableChannelSender sends", async () => {
    const sender = new UnroutableChannelSender("email");
    expect(sender.channel).toBe("email");
    await expect(
      sender.send({ ...IN_APP_REQUEST, channel: "email" }),
    ).resolves.toEqual(unroutedResult("email"));
  });
});

describe("sendWithTimeout", () => {
  it("passes a successful result straight through", async () => {
    const timer = new FakeTimer();
    const result = await sendWithTimeout(
      new InAppSender(),
      IN_APP_REQUEST,
      50,
      timer,
    );
    expect(result.outcome).toBe("delivered");
    expect(result.providerMessageId).toBe(DISPATCH_ID);
  });

  it("clears the timer on success so no handle stays pending", async () => {
    const timer = new FakeTimer();
    await sendWithTimeout(new InAppSender(), IN_APP_REQUEST, 50, timer);
    expect(timer.cleared).toHaveLength(1);
    expect(timer.pending()).toHaveLength(0);
  });

  it("schedules the timer with the supplied budget", async () => {
    const timer = new FakeTimer();
    await sendWithTimeout(new InAppSender(), IN_APP_REQUEST, 250, timer);
    expect(timer.scheduled[0]?.ms).toBe(250);
  });

  it("falls back to the default budget", async () => {
    const timer = new FakeTimer();
    await sendWithTimeout(
      new InAppSender(),
      IN_APP_REQUEST,
      undefined,
      timer,
    );
    expect(timer.scheduled[0]?.ms).toBe(DEFAULT_SEND_TIMEOUT_MS);
  });

  it("resolves — never rejects — when a sender hangs", async () => {
    const timer = new FakeTimer();
    const pending = sendWithTimeout(
      HANGING_SENDER,
      { ...IN_APP_REQUEST, channel: "webhook" },
      75,
      timer,
    );
    timer.fireAll();
    const result = await pending;
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe(SEND_TIMEOUT_ERROR_CODE);
    expect(result.errorMessage).toContain("75ms");
  });

  it("attributes the timeout to the sender's own provider and stays retryable", async () => {
    const timer = new FakeTimer();
    const pending = sendWithTimeout(
      HANGING_SENDER,
      { ...IN_APP_REQUEST, channel: "webhook" },
      75,
      timer,
    );
    timer.fireAll();
    const result = await pending;
    expect(result.provider).toBe(HANGING_SENDER.provider);
    expect(RETRYABLE_DELIVERY_OUTCOMES.has(result.outcome)).toBe(true);
  });

  it("ignores a sender that resolves after the budget already elapsed", async () => {
    const timer = new FakeTimer();
    let release: (result: SendResult) => void = () => undefined;
    const late = stubSender(
      "webhook",
      () =>
        new Promise<SendResult>((resolve) => {
          release = resolve;
        }),
    );
    const pending = sendWithTimeout(
      late,
      { ...IN_APP_REQUEST, channel: "webhook" },
      75,
      timer,
    );
    timer.fireAll();
    release({ ...unroutedResult("webhook"), outcome: "delivered" });
    expect((await pending).errorCode).toBe(SEND_TIMEOUT_ERROR_CODE);
  });

  it("converts a rejected send into a failed result", async () => {
    const timer = new FakeTimer();
    const thrower = stubSender("webhook", async () => {
      throw new Error("connection reset by peer");
    });
    const result = await sendWithTimeout(
      thrower,
      { ...IN_APP_REQUEST, channel: "webhook" },
      50,
      timer,
    );
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe(SENDER_THREW_ERROR_CODE);
    expect(result.errorMessage).toBe("connection reset by peer");
    expect(timer.pending()).toHaveLength(0);
  });

  it("catches a synchronous throw from send()", async () => {
    const timer = new FakeTimer();
    const thrower: ChannelSender = {
      channel: "webhook",
      provider: "webhook_http",
      send(): Promise<SendResult> {
        throw new Error("bad provider config");
      },
    };
    const result = await sendWithTimeout(
      thrower,
      { ...IN_APP_REQUEST, channel: "webhook" },
      50,
      timer,
    );
    expect(result.errorCode).toBe(SENDER_THREW_ERROR_CODE);
    expect(result.errorMessage).toBe("bad provider config");
  });

  it("truncates a thrown message longer than the 500-char column", async () => {
    const timer = new FakeTimer();
    const thrower = stubSender("webhook", async () => {
      throw new Error("z".repeat(900));
    });
    const result = await sendWithTimeout(
      thrower,
      { ...IN_APP_REQUEST, channel: "webhook" },
      50,
      timer,
    );
    expect(result.errorMessage).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
  });

  it("stringifies a non-Error rejection", async () => {
    const timer = new FakeTimer();
    const thrower = stubSender("webhook", async () => {
      throw "socket closed";
    });
    const result = await sendWithTimeout(
      thrower,
      { ...IN_APP_REQUEST, channel: "webhook" },
      50,
      timer,
    );
    expect(result.errorMessage).toBe("socket closed");
  });

});

describe("every producible SendResult", () => {
  it("carries a provider in PROVIDER_KINDS and an outcome in DELIVERY_OUTCOMES", async () => {
    const timer = new FakeTimer();
    const thrower = stubSender("webhook", async () => {
      throw new Error("boom");
    });
    const timing = new FakeTimer();
    const hung = sendWithTimeout(
      HANGING_SENDER,
      { ...IN_APP_REQUEST, channel: "webhook" },
      10,
      timing,
    );
    timing.fireAll();

    const results: readonly SendResult[] = [
      await new InAppSender().send(IN_APP_REQUEST),
      await new InAppSender().send({ ...IN_APP_REQUEST, channel: "sms" }),
      unroutedResult("email"),
      await new UnroutableChannelSender("sms").send({
        ...IN_APP_REQUEST,
        channel: "sms",
      }),
      await sendWithTimeout(
        thrower,
        { ...IN_APP_REQUEST, channel: "webhook" },
        10,
        timer,
      ),
      await hung,
    ];

    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(PROVIDER_KINDS).toContain(result.provider);
      expect(DELIVERY_OUTCOMES).toContain(result.outcome);
    }
  });
});
