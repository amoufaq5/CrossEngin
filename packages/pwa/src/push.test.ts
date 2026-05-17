import { describe, expect, it } from "vitest";
import {
  buildPhiSafePayload,
  LOCALE_STUB_TEMPLATES,
  NotificationPayloadSchema,
  phiSafeStub,
  PushSubscriptionSchema,
  VapidConfigSchema,
} from "./push.js";

const now = "2026-05-13T10:00:00.000Z";

describe("VapidConfigSchema", () => {
  it("accepts a base64url-shaped public key", () => {
    expect(() =>
      VapidConfigSchema.parse({
        publicKey: "A".repeat(87),
        privateKeyVaultRef: { vault: "pwa.vapid.private" },
        subject: "mailto:security@crossengin.com",
      }),
    ).not.toThrow();
  });

  it("rejects a short public key", () => {
    expect(() =>
      VapidConfigSchema.parse({
        publicKey: "short",
        privateKeyVaultRef: { vault: "x" },
        subject: "mailto:x@y.z",
      }),
    ).toThrow();
  });

  it("rejects subjects that aren't mailto: or https:", () => {
    expect(() =>
      VapidConfigSchema.parse({
        publicKey: "A".repeat(87),
        privateKeyVaultRef: { vault: "x" },
        subject: "phone:+1234",
      }),
    ).toThrow();
  });
});

describe("PushSubscriptionSchema", () => {
  it("parses a Web Push subscription", () => {
    expect(() =>
      PushSubscriptionSchema.parse({
        id: "ps_1",
        tenantId: "t_1",
        userId: "u_1",
        protocol: "web_push",
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        expirationTime: null,
        keys: { p256dh: "p256dh-key", auth: "auth-key" },
        deviceLabel: "Chrome on macOS",
        createdAt: now,
        lastSeenAt: now,
      }),
    ).not.toThrow();
  });
});

describe("phiSafeStub + LOCALE_STUB_TEMPLATES", () => {
  it("returns localized stubs for supported locales", () => {
    expect(phiSafeStub("en")).toBe("You have an update");
    expect(phiSafeStub("ar")).toBe("لديك تحديث");
  });

  it("falls back to English for unknown locales", () => {
    expect(phiSafeStub("xx" as never)).toBe(LOCALE_STUB_TEMPLATES.en);
  });
});

describe("NotificationPayloadSchema", () => {
  it("parses a generic entity_updated payload", () => {
    expect(() =>
      NotificationPayloadSchema.parse({
        kind: "entity_updated",
        tenantId: "t_1",
        recipientUserId: "u_1",
        locale: "en",
        title: "Prescription updated",
        body: "Dr. Hassan verified prescription #4242",
        clickUrl: "/prescriptions/4242",
        createdAt: now,
      }),
    ).not.toThrow();
  });

  it("forces PHI-bearing notifications to use stub-shaped body", () => {
    expect(() =>
      NotificationPayloadSchema.parse({
        kind: "entity_updated",
        tenantId: "t_1",
        recipientUserId: "u_1",
        locale: "en",
        title: "You have an update",
        body: "Patient John Smith's prescription is ready",
        clickUrl: "/prescriptions/4242",
        containsPhi: true,
        createdAt: now,
      }),
    ).toThrow(/PHI-containing notifications must use locale-aware stubs/);
  });

  it("rejects clickUrl that's neither absolute https nor path-prefixed", () => {
    expect(() =>
      NotificationPayloadSchema.parse({
        kind: "entity_updated",
        tenantId: "t_1",
        recipientUserId: "u_1",
        locale: "en",
        title: "x",
        body: "x",
        clickUrl: "javascript:alert(1)",
        createdAt: now,
      }),
    ).toThrow();
  });

  it("accepts up to two action buttons", () => {
    expect(() =>
      NotificationPayloadSchema.parse({
        kind: "approval_request",
        tenantId: "t_1",
        recipientUserId: "u_1",
        locale: "en",
        title: "Approval requested",
        body: "A new request needs your review",
        clickUrl: "/requests/42",
        actions: [
          { action: "approve", title: "Approve" },
          { action: "decline", title: "Decline" },
        ],
        createdAt: now,
      }),
    ).not.toThrow();
  });

  it("rejects more than two action buttons", () => {
    expect(() =>
      NotificationPayloadSchema.parse({
        kind: "approval_request",
        tenantId: "t_1",
        recipientUserId: "u_1",
        locale: "en",
        title: "x",
        body: "x",
        clickUrl: "/x",
        actions: [
          { action: "a", title: "A" },
          { action: "b", title: "B" },
          { action: "c", title: "C" },
        ],
        createdAt: now,
      }),
    ).toThrow();
  });
});

describe("buildPhiSafePayload", () => {
  it("produces a stub-only payload with containsPhi=true", () => {
    const payload = buildPhiSafePayload({
      tenantId: "t_1",
      recipientUserId: "u_1",
      locale: "ar",
      clickUrl: "/prescriptions/4242",
      createdAt: now,
    });
    expect(payload.containsPhi).toBe(true);
    expect(payload.title).toBe("لديك تحديث");
    expect(payload.body).toBe("لديك تحديث");
  });
});
