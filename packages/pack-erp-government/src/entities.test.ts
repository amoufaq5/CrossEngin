import { EntitySchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";
import {
  CASE_ENTITY,
  CITIZEN_ENTITY,
  ERP_GOVERNMENT_ENTITIES,
  PERMIT_ENTITY,
} from "./entities.js";

describe("government entities", () => {
  it("all parse against the kernel EntitySchema", () => {
    for (const e of ERP_GOVERNMENT_ENTITIES) {
      expect(() => EntitySchema.parse(e)).not.toThrow();
    }
  });

  it("are all on the auditable trait", () => {
    for (const e of ERP_GOVERNMENT_ENTITIES) {
      expect(e.traits).toContain("auditable");
    }
  });

  it("classifies the national id as regulated", () => {
    expect(CITIZEN_ENTITY.fields.find((f) => f.name === "national_id")?.classification).toBe(
      "regulated",
    );
    // the plain mailing address is NOT sensitive
    expect(
      CITIZEN_ENTITY.fields.find((f) => f.name === "mailing_address")?.classification,
    ).toBeUndefined();
  });

  it("classifies contact fields as PII and the permit fee as commercial_sensitive", () => {
    expect(CITIZEN_ENTITY.fields.find((f) => f.name === "contact_email")?.classification).toBe(
      "pii",
    );
    expect(CITIZEN_ENTITY.fields.find((f) => f.name === "contact_phone")?.classification).toBe(
      "pii",
    );
    expect(PERMIT_ENTITY.fields.find((f) => f.name === "fee_amount")?.classification).toBe(
      "commercial_sensitive",
    );
  });

  it("Citizen references the core Account; Case and Permit reference Citizen", () => {
    expect(CITIZEN_ENTITY.fields.find((f) => f.name === "account_id")?.type).toEqual({
      kind: "reference",
      target: "Account",
    });
    expect(CASE_ENTITY.fields.find((f) => f.name === "citizen_id")?.type).toEqual({
      kind: "reference",
      target: "Citizen",
    });
    expect(PERMIT_ENTITY.fields.find((f) => f.name === "citizen_id")?.type).toEqual({
      kind: "reference",
      target: "Citizen",
    });
  });

  it("puts the regulated national_id on an auditable entity", () => {
    // regulated fields must live on an auditable entity or validation fails
    expect(CITIZEN_ENTITY.traits).toContain("auditable");
  });
});
