import { describe, expect, it } from "vitest";
import { ManifestSchema } from "./types.js";

const validMeta = { name: "Test", slug: "test/example", version: "1.0.0" } as const;

describe("ManifestSchema — minimum manifest", () => {
  it("parses a manifest with only meta", () => {
    const m = { manifestVersion: "1.0" as const, meta: validMeta };
    expect(ManifestSchema.parse(m)).toEqual(m);
  });

  it("requires manifestVersion", () => {
    expect(() => ManifestSchema.parse({ meta: validMeta })).toThrow();
  });

  it("requires meta", () => {
    expect(() => ManifestSchema.parse({ manifestVersion: "1.0" })).toThrow();
  });

  it("rejects a future manifestVersion", () => {
    expect(() =>
      ManifestSchema.parse({ manifestVersion: "2.0", meta: validMeta }),
    ).toThrow();
  });
});

describe("ManifestSchema — meta", () => {
  it("accepts a simple slug", () => {
    expect(
      ManifestSchema.parse({
        manifestVersion: "1.0",
        meta: { name: "X", slug: "simple", version: "1.0.0" },
      }).meta.slug,
    ).toBe("simple");
  });

  it("accepts a multi-segment slug", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: { name: "X", slug: "operate-pharma/community-pharmacy", version: "1.0.0" },
    };
    expect(ManifestSchema.parse(m).meta.slug).toBe("operate-pharma/community-pharmacy");
  });

  it("rejects slug with uppercase letters", () => {
    expect(() =>
      ManifestSchema.parse({
        manifestVersion: "1.0",
        meta: { name: "X", slug: "Simple", version: "1.0.0" },
      }),
    ).toThrow();
  });

  it("rejects slug with leading slash", () => {
    expect(() =>
      ManifestSchema.parse({
        manifestVersion: "1.0",
        meta: { name: "X", slug: "/leading", version: "1.0.0" },
      }),
    ).toThrow();
  });

  it("rejects slug with underscores", () => {
    expect(() =>
      ManifestSchema.parse({
        manifestVersion: "1.0",
        meta: { name: "X", slug: "with_underscore", version: "1.0.0" },
      }),
    ).toThrow();
  });

  it("rejects non-semver version", () => {
    expect(() =>
      ManifestSchema.parse({
        manifestVersion: "1.0",
        meta: { name: "X", slug: "x", version: "1.0" },
      }),
    ).toThrow();
  });
});

describe("ManifestSchema — entities / traits / relations", () => {
  it("parses entities array", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: validMeta,
      entities: [
        { name: "Patient", fields: [{ name: "first_name", type: { kind: "text" as const } }] },
      ],
    };
    const parsed = ManifestSchema.parse(m);
    expect(parsed.entities).toHaveLength(1);
  });

  it("parses traits and relations alongside entities", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: validMeta,
      entities: [
        { name: "Patient", fields: [{ name: "first_name", type: { kind: "text" as const } }] },
        { name: "Prescriber", fields: [{ name: "license", type: { kind: "text" as const } }] },
      ],
      traits: [
        {
          name: "geocoded",
          fields: [
            { name: "lat", type: { kind: "decimal" as const, precision: 10, scale: 6 } },
          ],
        },
      ],
      relations: [
        {
          kind: "many_to_one" as const,
          from: "Prescription",
          field: "patient",
          to: "Patient",
        },
      ],
    };
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("parses roles and permissions sections", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: validMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" as const } }] },
      ],
      roles: {
        staff: { name: "staff" },
        pharmacist: { name: "pharmacist", inherits: ["staff"] },
      },
      permissions: {
        Prescription: {
          read: { roles: ["pharmacist"] },
          update: { roles: ["pharmacist"], abac: "data.access.allow_update" },
          transitions: {
            verify: { roles: ["pharmacist"] },
          },
          fields: {
            qty: { read: { roles: ["pharmacist"] } },
          },
        },
      },
    };
    const parsed = ManifestSchema.parse(m);
    expect(parsed.roles?.pharmacist?.inherits).toEqual(["staff"]);
    expect(parsed.permissions?.Prescription?.read?.roles).toEqual(["pharmacist"]);
  });

  it("parses a workflows section", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: validMeta,
      workflows: {
        lifecycle: {
          kind: "entityLifecycle" as const,
          entity: "Prescription",
          stateField: "status",
          states: [
            { name: "pending", category: "active" as const },
            { name: "done", category: "terminal" as const },
          ],
          initialState: "pending",
          transitions: [{ name: "complete", from: "pending", to: "done" }],
        },
        dailyCheck: {
          kind: "scheduled" as const,
          schedule: "0 6 * * *",
          action: { kind: "runJob", job: "x" },
        },
      },
    };
    const parsed = ManifestSchema.parse(m);
    expect(Object.keys(parsed.workflows ?? {})).toEqual(["lifecycle", "dailyCheck"]);
  });

  it("parses an extends field on meta", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: { ...validMeta, extends: ["operate-pharma/_base"] },
    };
    const parsed = ManifestSchema.parse(m);
    expect(parsed.meta.extends).toEqual(["operate-pharma/_base"]);
  });

  it("parses an integrations section", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: validMeta,
      integrations: {
        stripe: {
          kind: "outbound.http" as const,
          auth: { kind: "bearer" as const, token: { vault: "stripe.secretKey" } },
          endpoint: "https://api.stripe.com/v1",
          operations: [
            { name: "createCustomer", method: "POST" as const, path: "/customers" },
          ],
        },
        stripeWebhook: {
          kind: "inbound.webhook" as const,
          endpoint: "/api/integrations/webhooks/stripe",
          verification: {
            kind: "hmac" as const,
            header: "Stripe-Signature",
            secret: { vault: "stripe.webhookSecret" },
          },
        },
      },
    };
    const parsed = ManifestSchema.parse(m);
    expect(Object.keys(parsed.integrations ?? {})).toEqual(["stripe", "stripeWebhook"]);
  });

  it("parses a jobs section", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: validMeta,
      jobs: {
        "notify-patient": {
          id: "notify-patient",
          name: "Notify Patient",
          trigger: { kind: "event" as const, eventName: "prescription.verified" },
          onFailure: { strategy: "alert-and-dead-letter" as const },
          idempotent: true,
          inputDataClass: "phi" as const,
          outputDataClass: "internal" as const,
        },
      },
    };
    const parsed = ManifestSchema.parse(m);
    expect(Object.keys(parsed.jobs ?? {})).toEqual(["notify-patient"]);
  });

  it("parses compliancePacks + compliancePackParameters on meta", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: {
        ...validMeta,
        compliancePacks: ["21-cfr-part-11", "hipaa"],
        compliancePackParameters: {
          "21-cfr-part-11": {
            signatureMethod: "smart-card-pin",
            signatureMeaningStatement: { en: "I approve" },
          },
          hipaa: { allowPhiInNotifications: false },
        },
      },
    };
    const parsed = ManifestSchema.parse(m);
    expect(parsed.meta.compliancePacks).toEqual(["21-cfr-part-11", "hipaa"]);
    expect(parsed.meta.compliancePackParameters?.["21-cfr-part-11"]?.["signatureMethod"]).toBe(
      "smart-card-pin",
    );
  });
});
