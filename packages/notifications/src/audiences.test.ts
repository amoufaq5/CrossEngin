import { describe, expect, it } from "vitest";
import {
  AUDIENCE_KINDS,
  AudienceSchema,
  ONCALL_ROTATION_KINDS,
  OncallRotationSchema,
  OncallShiftSchema,
  findActiveOncallUser,
  isAddressable,
  resolveEscalationChain,
  resolveUserAddress,
  type AddressBook,
  type OncallRotation,
} from "./audiences.js";

const rotation: OncallRotation = {
  rotationId: "oncall_sre01",
  tenantId: null,
  label: "SRE Primary",
  rotationKind: "primary",
  shifts: [
    {
      userId: "11111111-1111-1111-1111-111111111111",
      startsAt: "2026-05-16T08:00:00.000Z",
      endsAt: "2026-05-16T20:00:00.000Z",
      timezone: "UTC",
      backupUserId: "22222222-2222-2222-2222-222222222222",
    },
    {
      userId: "33333333-3333-3333-3333-333333333333",
      startsAt: "2026-05-16T20:00:00.000Z",
      endsAt: "2026-05-17T08:00:00.000Z",
      timezone: "UTC",
      backupUserId: null,
    },
  ],
  escalationChainUserIds: [],
  escalationTimeoutSeconds: 900,
  timezone: "UTC",
};

const addressBook: AddressBook = {
  email: { "11111111-1111-1111-1111-111111111111": "alice@acme.com" },
  sms: { "11111111-1111-1111-1111-111111111111": "+15551234567" },
  push_mobile: {
    "11111111-1111-1111-1111-111111111111": ["device-token-1", "device-token-2"],
  },
  in_app: { "11111111-1111-1111-1111-111111111111": "in_app_inbox_1" },
  voice_call: { "11111111-1111-1111-1111-111111111111": "+15551234567" },
};

describe("constants", () => {
  it("has 6 audience kinds", () => {
    expect(AUDIENCE_KINDS).toHaveLength(6);
  });
  it("has 5 on-call rotation kinds", () => {
    expect(ONCALL_ROTATION_KINDS).toHaveLength(5);
  });
});

describe("AudienceSchema", () => {
  it("accepts specific_user", () => {
    expect(() =>
      AudienceSchema.parse({
        kind: "specific_user",
        userId: "11111111-1111-1111-1111-111111111111",
      }),
    ).not.toThrow();
  });

  it("accepts role_in_tenant", () => {
    expect(() =>
      AudienceSchema.parse({
        kind: "role_in_tenant",
        tenantId: "11111111-1111-1111-1111-111111111111",
        roleSlug: "admin",
      }),
    ).not.toThrow();
  });

  it("rejects role_in_tenant with uppercase roleSlug", () => {
    expect(() =>
      AudienceSchema.parse({
        kind: "role_in_tenant",
        tenantId: "11111111-1111-1111-1111-111111111111",
        roleSlug: "Admin",
      }),
    ).toThrow();
  });

  it("accepts oncall_rotation", () => {
    expect(() =>
      AudienceSchema.parse({
        kind: "oncall_rotation",
        tenantId: null,
        rotationId: "oncall_sre01",
        rotationKind: "primary",
      }),
    ).not.toThrow();
  });

  it("accepts custom_predicate", () => {
    expect(() =>
      AudienceSchema.parse({
        kind: "custom_predicate",
        tenantId: "11111111-1111-1111-1111-111111111111",
        predicate: "user.role === 'cfo' && tenant.tier === 'enterprise'",
        description: "CFOs at enterprise tenants",
      }),
    ).not.toThrow();
  });
});

describe("OncallShiftSchema", () => {
  it("accepts a valid shift", () => {
    expect(() =>
      OncallShiftSchema.parse(rotation.shifts[0]),
    ).not.toThrow();
  });

  it("rejects endsAt <= startsAt", () => {
    expect(() =>
      OncallShiftSchema.parse({
        userId: "11111111-1111-1111-1111-111111111111",
        startsAt: "2026-05-16T10:00:00.000Z",
        endsAt: "2026-05-16T10:00:00.000Z",
        timezone: "UTC",
        backupUserId: null,
      }),
    ).toThrow(/endsAt must be after startsAt/);
  });

  it("rejects backupUserId same as userId", () => {
    expect(() =>
      OncallShiftSchema.parse({
        userId: "11111111-1111-1111-1111-111111111111",
        startsAt: "2026-05-16T10:00:00.000Z",
        endsAt: "2026-05-16T11:00:00.000Z",
        timezone: "UTC",
        backupUserId: "11111111-1111-1111-1111-111111111111",
      }),
    ).toThrow(/backupUserId must differ/);
  });
});

describe("OncallRotationSchema", () => {
  it("accepts a valid primary rotation", () => {
    expect(() => OncallRotationSchema.parse(rotation)).not.toThrow();
  });

  it("rejects escalation_chain rotation with empty chain", () => {
    expect(() =>
      OncallRotationSchema.parse({
        ...rotation,
        rotationKind: "escalation_chain",
        escalationChainUserIds: [],
      }),
    ).toThrow(/non-empty escalationChainUserIds/);
  });
});

describe("findActiveOncallUser", () => {
  it("returns the user whose shift covers now", () => {
    expect(
      findActiveOncallUser(rotation, new Date("2026-05-16T12:00:00Z")),
    ).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("returns the next shift's user after handoff", () => {
    expect(
      findActiveOncallUser(rotation, new Date("2026-05-16T22:00:00Z")),
    ).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("returns null outside any shift", () => {
    expect(
      findActiveOncallUser(rotation, new Date("2026-05-15T00:00:00Z")),
    ).toBeNull();
  });
});

describe("resolveEscalationChain", () => {
  const chain: OncallRotation = {
    ...rotation,
    rotationKind: "escalation_chain",
    escalationChainUserIds: [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
    ],
  };

  it("returns the first user at index 0", () => {
    expect(resolveEscalationChain(chain, 0)).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("returns null past the chain", () => {
    expect(resolveEscalationChain(chain, 99)).toBeNull();
  });

  it("returns null for non-chain rotations", () => {
    expect(resolveEscalationChain(rotation, 0)).toBeNull();
  });
});

describe("resolveUserAddress", () => {
  it("returns email address for email channel", () => {
    expect(
      resolveUserAddress(
        "11111111-1111-1111-1111-111111111111",
        "email",
        addressBook,
      ),
    ).toBe("alice@acme.com");
  });

  it("returns array of device tokens for push", () => {
    expect(
      resolveUserAddress(
        "11111111-1111-1111-1111-111111111111",
        "push_mobile",
        addressBook,
      ),
    ).toEqual(["device-token-1", "device-token-2"]);
  });

  it("returns null for webhook (no per-user address)", () => {
    expect(
      resolveUserAddress(
        "11111111-1111-1111-1111-111111111111",
        "webhook",
        addressBook,
      ),
    ).toBeNull();
  });

  it("returns null for unknown user", () => {
    expect(resolveUserAddress("99999999-9999-9999-9999-999999999999", "email", addressBook)).toBeNull();
  });
});

describe("isAddressable", () => {
  it("returns true when email address exists", () => {
    expect(
      isAddressable(
        "11111111-1111-1111-1111-111111111111",
        "email",
        addressBook,
      ),
    ).toBe(true);
  });

  it("returns false when push tokens are empty", () => {
    const emptyBook: AddressBook = {
      ...addressBook,
      push_mobile: { "11111111-1111-1111-1111-111111111111": [] },
    };
    expect(
      isAddressable("11111111-1111-1111-1111-111111111111", "push_mobile", emptyBook),
    ).toBe(false);
  });
});
