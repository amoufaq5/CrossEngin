import { describe, expect, it } from "vitest";
import type { Manifest } from "./types.js";
import { ManifestValidationError } from "./errors.js";
import { manifestClassifiedFields, validateManifest } from "./validate.js";

const baseMetaC = { name: "Test", slug: "test", version: "1.0.0" } as const;

describe("validateManifest — data classification", () => {
  it("accepts a phi field on an auditable entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMetaC,
      entities: [
        {
          name: "Observation",
          traits: ["auditable"],
          fields: [{ name: "value_text", type: { kind: "long_text" }, classification: "phi" }],
        },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects a phi field on a non-auditable entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMetaC,
      entities: [
        {
          name: "Observation",
          fields: [{ name: "value_text", type: { kind: "long_text" }, classification: "phi" }],
        },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/auditable/);
  });

  it("allows a pii field on a non-auditable entity (no audit requirement)", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMetaC,
      entities: [
        {
          name: "Lead",
          fields: [{ name: "email", type: { kind: "email" }, classification: "pii" }],
        },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("inventories every classified field via manifestClassifiedFields", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMetaC,
      entities: [
        {
          name: "Patient",
          traits: ["auditable"],
          fields: [
            { name: "mrn", type: { kind: "text" }, classification: "phi" },
            { name: "given_name", type: { kind: "text" }, classification: "pii" },
            { name: "status", type: { kind: "text" } },
          ],
        },
      ],
    };
    expect(manifestClassifiedFields(m)).toEqual([
      { entity: "Patient", field: "mrn", classification: "phi" },
      { entity: "Patient", field: "given_name", classification: "pii" },
    ]);
  });
});

const baseMeta = { name: "Test", slug: "test", version: "1.0.0" } as const;

describe("validateManifest — entities", () => {
  it("accepts an empty manifest", () => {
    const m: Manifest = { manifestVersion: "1.0", meta: baseMeta };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on duplicate entity names", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] },
        { name: "Patient", fields: [{ name: "b", type: { kind: "text" } }] },
      ],
    };
    expect(() => validateManifest(m)).toThrow(ManifestValidationError);
  });

  it("accepts entities with reference to a known entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] },
        {
          name: "Prescription",
          fields: [{ name: "patient", type: { kind: "reference", target: "Patient" } }],
        },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on reference to an unknown entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "Prescription",
          fields: [{ name: "patient", type: { kind: "reference", target: "Patient" } }],
        },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/Patient/);
  });
});

describe("validateManifest — traits", () => {
  it("throws on duplicate custom trait names", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      traits: [
        { name: "geocoded", fields: [] },
        { name: "geocoded", fields: [] },
      ],
    };
    expect(() => validateManifest(m)).toThrow(ManifestValidationError);
  });

  it("throws when a custom trait shadows a built-in", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      traits: [{ name: "auditable", fields: [] }],
    };
    expect(() => validateManifest(m)).toThrow(/built-in/);
  });

  it("accepts entities referencing a built-in trait", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "Patient",
          fields: [{ name: "a", type: { kind: "text" } }],
          traits: ["auditable"],
        },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("accepts entities referencing a custom trait declared in manifest", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "Patient",
          fields: [{ name: "a", type: { kind: "text" } }],
          traits: ["geocoded"],
        },
      ],
      traits: [
        {
          name: "geocoded",
          fields: [{ name: "lat", type: { kind: "decimal", precision: 10, scale: 6 } }],
        },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on an unknown trait reference", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "Patient",
          fields: [{ name: "a", type: { kind: "text" } }],
          traits: ["mystery"],
        },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/mystery/);
  });

  it("checks trait field references against entity set", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] }],
      traits: [
        {
          name: "with_owner",
          fields: [{ name: "owner", type: { kind: "reference", target: "Owner" } }],
        },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/Owner/);
  });
});

describe("validateManifest — relations", () => {
  it("accepts many_to_one with known entities", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] },
        {
          name: "Prescription",
          fields: [
            { name: "a", type: { kind: "text" } },
            { name: "patient", type: { kind: "reference", target: "Patient" } },
          ],
        },
      ],
      relations: [
        { kind: "many_to_one", from: "Prescription", field: "patient", to: "Patient" },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on many_to_one whose field does not exist on the 'from' entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] },
        { name: "Prescription", fields: [{ name: "a", type: { kind: "text" } }] },
      ],
      relations: [
        { kind: "many_to_one", from: "Prescription", field: "patient", to: "Patient" },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/unknown field 'patient' on entity 'Prescription'/);
  });

  it("does not require a one_to_many's field to be a column — it names the inverse collection", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] },
        { name: "Prescription", fields: [{ name: "a", type: { kind: "text" } }] },
      ],
      relations: [
        { kind: "one_to_many", from: "Patient", field: "prescriptions", to: "Prescription" },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("does not check fields on many_to_many, which has none", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] },
        { name: "Prescription", fields: [{ name: "a", type: { kind: "text" } }] },
      ],
      relations: [{ kind: "many_to_many", left: "Patient", right: "Prescription" }],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on many_to_one with unknown 'to'", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ name: "Prescription", fields: [{ name: "a", type: { kind: "text" } }] }],
      relations: [
        { kind: "many_to_one", from: "Prescription", field: "patient", to: "Patient" },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/Patient/);
  });

  it("throws on many_to_many with unknown 'left'", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ name: "Specialty", fields: [{ name: "a", type: { kind: "text" } }] }],
      relations: [{ kind: "many_to_many", left: "Doctor", right: "Specialty" }],
    };
    expect(() => validateManifest(m)).toThrow(/Doctor/);
  });
});

describe("validateManifest — roles", () => {
  it("accepts a manifest with a flat role set", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: {
        staff: { name: "staff" },
        pharmacist: { name: "pharmacist", inherits: ["staff"] },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws when role.name doesn't match its record key", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: {
        staff: { name: "pharmacist" },
      },
    };
    expect(() => validateManifest(m)).toThrow(/does not match record key/);
  });

  it("throws on a role inheritance cycle", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: {
        a: { name: "a", inherits: ["b"] },
        b: { name: "b", inherits: ["a"] },
      },
    };
    expect(() => validateManifest(m)).toThrow(/inheritance cycle/);
  });

  it("throws when inherits references an unknown role", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: {
        pharmacist: { name: "pharmacist", inherits: ["mystery"] },
      },
    };
    expect(() => validateManifest(m)).toThrow(/unknown role 'mystery'/);
  });
});

describe("validateManifest — permissions", () => {
  const baseRoles = {
    pharmacist: { name: "pharmacist" as const },
    manager: { name: "manager" as const, inherits: ["pharmacist"] },
  };

  it("accepts permissions for declared entities with declared roles", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      roles: baseRoles,
      permissions: {
        Prescription: {
          read: { roles: ["pharmacist", "manager"] },
          update: { roles: ["pharmacist"] },
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on a permission entry for an unknown entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      roles: baseRoles,
      permissions: {
        NonExistent: { read: { roles: ["pharmacist"] } },
      },
    };
    expect(() => validateManifest(m)).toThrow(/unknown entity 'NonExistent'/);
  });

  it("throws when an operation grant references an unknown role", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      roles: baseRoles,
      permissions: {
        Prescription: { read: { roles: ["mystery"] } },
      },
    };
    expect(() => validateManifest(m)).toThrow(/role 'mystery'/);
  });

  it("throws when a transition grant references an unknown role", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      workflows: {
        lifecycle: {
          kind: "entityLifecycle",
          entity: "Prescription",
          stateField: "status",
          states: [{ name: "pending" }, { name: "done", category: "terminal" }],
          initialState: "pending",
          transitions: [{ name: "verify", from: "pending", to: "done" }],
        },
      },
      roles: baseRoles,
      permissions: {
        Prescription: {
          transitions: { verify: { roles: ["mystery"] } },
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/role 'mystery'/);
  });

  it("throws on a field-level permission for an unknown field", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      roles: baseRoles,
      permissions: {
        Prescription: {
          fields: { mystery_field: { read: { roles: ["pharmacist"] } } },
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/unknown field 'mystery_field'/);
  });

  it("accepts a field-level permission for a trait-supplied field (e.g. auditable's created_at)", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "Prescription",
          fields: [{ name: "qty", type: { kind: "integer" } }],
          traits: ["auditable"],
        },
      ],
      roles: baseRoles,
      permissions: {
        Prescription: {
          fields: { created_at: { read: { roles: ["pharmacist"] } } },
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws when a field-level grant references an unknown role", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      roles: baseRoles,
      permissions: {
        Prescription: {
          fields: { qty: { read: { roles: ["mystery"] } } },
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/role 'mystery'/);
  });
});

describe("validateManifest — workflows", () => {
  it("accepts a manifest with workflow + entity + permissions all consistent", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      workflows: {
        lifecycle: {
          kind: "entityLifecycle",
          entity: "Prescription",
          stateField: "status",
          states: [
            { name: "pending", category: "active" },
            { name: "verified", category: "active" },
            { name: "done", category: "terminal" },
          ],
          initialState: "pending",
          transitions: [
            { name: "verify", from: "pending", to: "verified" },
            { name: "complete", from: "verified", to: "done" },
          ],
        },
      },
      roles: { pharmacist: { name: "pharmacist" } },
      permissions: {
        Prescription: {
          transitions: {
            verify: { roles: ["pharmacist"] },
            complete: { roles: ["pharmacist"] },
          },
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws when workflow.entity is not a declared entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      workflows: {
        lifecycle: {
          kind: "entityLifecycle",
          entity: "Mystery",
          stateField: "status",
          states: [{ name: "x", category: "terminal" }],
          initialState: "x",
          transitions: [],
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/unknown entity 'Mystery'/);
  });

  it("propagates workflow validation errors with the workflow path", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      workflows: {
        lifecycle: {
          kind: "entityLifecycle",
          entity: "Prescription",
          stateField: "status",
          states: [{ name: "pending" }],
          initialState: "mystery",
          transitions: [],
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/workflows\.lifecycle\.initialState/);
  });

  it("throws when permissions.transitions references a transition not in any workflow", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      workflows: {
        lifecycle: {
          kind: "entityLifecycle",
          entity: "Prescription",
          stateField: "status",
          states: [{ name: "pending" }, { name: "done", category: "terminal" }],
          initialState: "pending",
          transitions: [{ name: "complete", from: "pending", to: "done" }],
        },
      },
      roles: { pharmacist: { name: "pharmacist" } },
      permissions: {
        Prescription: {
          transitions: { verify: { roles: ["pharmacist"] } },
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(
      /transition 'verify' is not declared in any workflow/,
    );
  });

  it("accepts a transition declared by a workflow even if no permission entry exists", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      workflows: {
        lifecycle: {
          kind: "entityLifecycle",
          entity: "Prescription",
          stateField: "status",
          states: [{ name: "pending" }, { name: "done", category: "terminal" }],
          initialState: "pending",
          transitions: [{ name: "complete", from: "pending", to: "done" }],
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });
});

describe("validateManifest — integrations", () => {
  it("accepts a manifest with valid integrations", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      integrations: {
        stripe: {
          kind: "outbound.http",
          auth: { kind: "bearer", token: { vault: "stripe.key" } },
          endpoint: "https://api.stripe.com/v1",
          operations: [
            { name: "createCustomer", method: "POST", path: "/customers" },
            { name: "createInvoice", method: "POST", path: "/invoices" },
          ],
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on duplicate operation names within an outbound.http integration", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      integrations: {
        stripe: {
          kind: "outbound.http",
          auth: { kind: "none" },
          endpoint: "https://api.example.com",
          operations: [
            { name: "createCustomer", method: "POST", path: "/customers" },
            { name: "createCustomer", method: "PUT", path: "/customers" },
          ],
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/duplicate operation name 'createCustomer'/);
  });

  it("throws on duplicate operation names within an outbound.graphql integration", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      integrations: {
        gql: {
          kind: "outbound.graphql",
          auth: { kind: "none" },
          endpoint: "https://api.example.com/graphql",
          operations: [
            { name: "fetchUser", operationType: "query", document: "query { user { id } }" },
            { name: "fetchUser", operationType: "query", document: "query { user { name } }" },
          ],
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/duplicate operation name 'fetchUser'/);
  });

  it("does not enforce operation-name uniqueness across different integrations", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      integrations: {
        a: {
          kind: "outbound.http",
          auth: { kind: "none" },
          endpoint: "https://a.example.com",
          operations: [{ name: "lookup", method: "GET", path: "/" }],
        },
        b: {
          kind: "outbound.http",
          auth: { kind: "none" },
          endpoint: "https://b.example.com",
          operations: [{ name: "lookup", method: "GET", path: "/" }],
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });
});

describe("validateManifest — jobs", () => {
  it("accepts a manifest with valid jobs", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      jobs: {
        "notify-patient": {
          id: "notify-patient",
          name: "Notify Patient",
          trigger: { kind: "event", eventName: "prescription.verified" },
          onFailure: { strategy: "alert-and-dead-letter" },
          idempotent: true,
          inputDataClass: "phi",
          outputDataClass: "internal",
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects jobs whose id doesn't match the record key", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      jobs: {
        "notify-patient": {
          id: "different-id",
          name: "Notify Patient",
          trigger: { kind: "event", eventName: "prescription.verified" },
          onFailure: { strategy: "dead-letter" },
          idempotent: true,
          inputDataClass: "internal",
          outputDataClass: "internal",
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/does not match its record key/);
  });

  it("rejects workflow-triggered jobs whose workflow isn't declared", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      jobs: {
        runStep: {
          id: "runStep",
          name: "Run Step",
          trigger: { kind: "workflow", workflow: "missing_wf", step: "humanTask" },
          onFailure: { strategy: "dead-letter" },
          idempotent: true,
          inputDataClass: "internal",
          outputDataClass: "internal",
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/unknown workflow 'missing_wf'/);
  });

  it("accepts workflow-triggered jobs when the workflow is declared", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "status", type: { kind: "text" } }] },
      ],
      workflows: {
        prescription_lifecycle: {
          kind: "entityLifecycle",
          entity: "Prescription",
          stateField: "status",
          states: [
            { name: "draft", category: "active" },
            { name: "done", category: "terminal" },
          ],
          initialState: "draft",
          transitions: [{ name: "complete", from: "draft", to: "done" }],
        },
      },
      jobs: {
        runStep: {
          id: "runStep",
          name: "Run Step",
          trigger: {
            kind: "workflow",
            workflow: "prescription_lifecycle",
            step: "humanTask",
          },
          onFailure: { strategy: "dead-letter" },
          idempotent: true,
          inputDataClass: "internal",
          outputDataClass: "internal",
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("accepts a userInvoked job whose invokeRoles are all declared", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: { ops_admin: { name: "ops_admin" }, catalog_admin: { name: "catalog_admin" } },
      jobs: {
        "reindex-catalog": {
          id: "reindex-catalog",
          name: "Reindex Catalog",
          trigger: { kind: "userInvoked", action: "reindex-catalog" },
          onFailure: { strategy: "dead-letter" },
          idempotent: true,
          inputDataClass: "internal",
          outputDataClass: "internal",
          invokeRoles: ["ops_admin", "catalog_admin"],
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects invokeRoles that reference an undeclared role", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: { ops_admin: { name: "ops_admin" } },
      jobs: {
        "reindex-catalog": {
          id: "reindex-catalog",
          name: "Reindex Catalog",
          trigger: { kind: "userInvoked", action: "reindex-catalog" },
          onFailure: { strategy: "dead-letter" },
          idempotent: true,
          inputDataClass: "internal",
          outputDataClass: "internal",
          invokeRoles: ["ghost_role"],
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/invokeRoles references role 'ghost_role'/);
  });

  it("rejects invokeRoles on a non-userInvoked job", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: { ops_admin: { name: "ops_admin" } },
      jobs: {
        "nightly-report": {
          id: "nightly-report",
          name: "Nightly Report",
          trigger: { kind: "scheduled", cron: "0 0 * * *" },
          onFailure: { strategy: "dead-letter" },
          idempotent: true,
          inputDataClass: "internal",
          outputDataClass: "internal",
          invokeRoles: ["ops_admin"],
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/only meaningful on a 'userInvoked'-trigger job/);
  });
});

describe("validateManifest — reports + dashboards", () => {
  const entityFixture = {
    name: "Prescription",
    fields: [{ name: "qty", type: { kind: "integer" as const } }],
  };

  it("accepts a manifest with valid reports + dashboards", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      reports: {
        todayDispensed: {
          kind: "kpi",
          entity: "Prescription",
          measure: { name: "count", kind: "count" },
        },
      },
      dashboards: {
        managerDaily: {
          cells: [
            {
              x: 0,
              y: 0,
              w: 4,
              h: 2,
              widget: { kind: "kpi", report: "todayDispensed" },
            },
          ],
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects a report referencing an unknown entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      reports: {
        bad: {
          kind: "tabular",
          entity: "Missing",
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/'Missing' is not declared/);
  });

  it("rejects a dashboard widget pointing to an unknown report", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      reports: {
        actual: { kind: "kpi", entity: "Prescription", measure: { name: "n", kind: "count" } },
      },
      dashboards: {
        broken: {
          cells: [
            {
              x: 0,
              y: 0,
              w: 4,
              h: 2,
              widget: { kind: "kpi", report: "phantom" },
            },
          ],
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/unknown report 'phantom'/);
  });
});

describe("validateManifest — views", () => {
  const entityFixture = {
    name: "Prescription",
    fields: [{ name: "qty", type: { kind: "integer" as const } }],
  };

  it("accepts a list view referencing a record view + workflow transition", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      workflows: {
        prescriptionLifecycle: {
          kind: "entityLifecycle",
          entity: "Prescription",
          stateField: "status",
          states: [
            { name: "pending", category: "active" },
            { name: "verified", category: "terminal" },
          ],
          initialState: "pending",
          transitions: [{ name: "verify", from: "pending", to: "verified" }],
        },
      },
      views: {
        prescriptionDetail: {
          kind: "record",
          entity: "Prescription",
          sections: [{ id: "main", label: { en: "Main" }, fields: ["qty"] }],
        },
        prescriptionInbox: {
          kind: "list",
          entity: "Prescription",
          columns: [{ field: "qty" }],
          rowAction: { kind: "openRecord", view: "prescriptionDetail" },
          bulkActions: [
            { kind: "workflow", name: "verify", label: { en: "Verify" } },
          ],
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects a view referencing an unknown entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      views: {
        bad: { kind: "list", entity: "Missing", columns: [{ field: "x" }] },
      },
    };
    expect(() => validateManifest(m)).toThrow(/'Missing' is not declared/);
  });

  it("rejects a row-action targeting a missing view", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      views: {
        inbox: {
          kind: "list",
          entity: "Prescription",
          columns: [{ field: "qty" }],
          rowAction: { kind: "openRecord", view: "missingDetail" },
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/unknown view 'missingDetail'/);
  });

  it("rejects a dashboard-kind view referencing a missing dashboard", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      views: {
        view1: {
          kind: "dashboard",
          entity: "Prescription",
          dashboardRef: "phantomDashboard",
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/unknown dashboard 'phantomDashboard'/);
  });

  it("rejects a workflow transition not declared on the entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      views: {
        inbox: {
          kind: "list",
          entity: "Prescription",
          columns: [{ field: "qty" }],
          rowAction: { kind: "workflow", name: "verify" },
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(
      /transition 'verify' not declared on entity 'Prescription'/,
    );
  });
});

describe("validateManifest — view field references", () => {
  const entityFixture = {
    name: "Prescription",
    traits: ["auditable"],
    fields: [
      { name: "qty", type: { kind: "integer" as const } },
      { name: "status", type: { kind: "text" as const } },
      { name: "filled_on", type: { kind: "date" as const } },
      { name: "site", type: { kind: "geo_point" as const } },
      { name: "account_id", type: { kind: "reference" as const, target: "Prescription" } },
    ],
  };

  const withView = (view: unknown): Manifest =>
    ({
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      views: { v: view },
    }) as Manifest;

  it("accepts a list view whose columns, sort and filters all resolve", () => {
    const m = withView({
      kind: "list",
      entity: "Prescription",
      columns: [{ field: "qty" }, { field: "status" }],
      sort: [{ field: "filled_on", direction: "desc" }],
      filters: [{ field: "status", operator: "eq", value: "filled" }],
    });
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects a list column naming a field the entity does not have", () => {
    const m = withView({
      kind: "list",
      entity: "Prescription",
      columns: [{ field: "qty" }, { field: "dosage" }],
    });
    expect(() => validateManifest(m)).toThrow(
      /unknown field 'dosage' on entity 'Prescription'/,
    );
  });

  it("names the exact location of the offending column", () => {
    const m = withView({
      kind: "list",
      entity: "Prescription",
      columns: [{ field: "qty" }, { field: "status" }, { field: "dosage" }],
    });
    expect(() => validateManifest(m)).toThrow(/views\.v\.columns\[2\]\.field/);
  });

  it("rejects an unknown sort field", () => {
    const m = withView({
      kind: "list",
      entity: "Prescription",
      columns: [{ field: "qty" }],
      sort: [{ field: "prescribed_on", direction: "asc" }],
    });
    expect(() => validateManifest(m)).toThrow(/views\.v\.sort\[0\]\.field/);
  });

  it("rejects an unknown filter field", () => {
    const m = withView({
      kind: "list",
      entity: "Prescription",
      columns: [{ field: "qty" }],
      filters: [{ field: "pharmacy", operator: "eq", value: "x" }],
    });
    expect(() => validateManifest(m)).toThrow(/views\.v\.filters\[0\]\.field/);
  });

  it("rejects an unknown field inside a column group", () => {
    const m = withView({
      kind: "list",
      entity: "Prescription",
      columns: [{ field: "qty" }],
      columnGroups: [{ label: { en: "More" }, columns: [{ field: "dosage" }] }],
    });
    expect(() => validateManifest(m)).toThrow(
      /views\.v\.columnGroups\[0\]\.columns\[0\]\.field/,
    );
  });

  it("rejects an unknown field in a record section", () => {
    const m = withView({
      kind: "record",
      entity: "Prescription",
      sections: [{ id: "main", label: { en: "Main" }, fields: ["qty", "dosage"] }],
    });
    expect(() => validateManifest(m)).toThrow(/views\.v\.sections\[0\]\.fields\[1\]/);
  });

  it("rejects an unknown field in a form step", () => {
    const m = withView({
      kind: "form",
      entity: "Prescription",
      steps: [{ id: "s1", label: { en: "Details" }, fields: [{ field: "dosage" }] }],
    });
    expect(() => validateManifest(m)).toThrow(/views\.v\.steps\[0\]\.fields\[0\]\.field/);
  });

  it("rejects an unknown kanban stateField and cardField", () => {
    const base = {
      kind: "kanban",
      entity: "Prescription",
      columns: [{ state: "pending", label: { en: "Pending" } }],
      cardFields: ["qty"],
    };
    expect(() =>
      validateManifest(withView({ ...base, stateField: "phase" })),
    ).toThrow(/views\.v\.stateField/);
    expect(() =>
      validateManifest(withView({ ...base, stateField: "status", cardFields: ["dosage"] })),
    ).toThrow(/views\.v\.cardFields\[0\]/);
  });

  it("rejects an unknown calendar date field", () => {
    const m = withView({
      kind: "calendar",
      entity: "Prescription",
      startField: "dispensed_on",
      titleField: "status",
    });
    expect(() => validateManifest(m)).toThrow(/views\.v\.startField/);
  });

  it("rejects an unknown map geo field", () => {
    const m = withView({
      kind: "map",
      entity: "Prescription",
      geoField: "location",
      layers: [{ id: "l", label: { en: "L" }, kind: "markers" }],
    });
    expect(() => validateManifest(m)).toThrow(/views\.v\.geoField/);
  });

  it("rejects an unknown field in a map layer filter", () => {
    const m = withView({
      kind: "map",
      entity: "Prescription",
      geoField: "site",
      layers: [
        {
          id: "l",
          label: { en: "L" },
          kind: "markers",
          filters: [{ field: "pharmacy", operator: "eq", value: "x" }],
        },
      ],
    });
    expect(() => validateManifest(m)).toThrow(/views\.v\.layers\[0\]\.filters\[0\]\.field/);
  });

  it("accepts a column on a trait-supplied field", () => {
    const m = withView({
      kind: "list",
      entity: "Prescription",
      columns: [{ field: "created_at" }, { field: "updated_by" }],
    });
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("accepts a column on the implicit id primary key", () => {
    const m = withView({
      kind: "list",
      entity: "Prescription",
      columns: [{ field: "id" }],
    });
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("resolves only the root segment of a dotted path, which traverses a reference", () => {
    // `account_id.name` belongs to the target entity; the check stops at `account_id`.
    expect(() =>
      validateManifest(
        withView({
          kind: "list",
          entity: "Prescription",
          columns: [{ field: "account_id.name" }],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateManifest(
        withView({
          kind: "list",
          entity: "Prescription",
          columns: [{ field: "prescriber_id.name" }],
        }),
      ),
    ).toThrow(/unknown field 'prescriber_id\.name'/);
  });

  it("checks no fields on a dashboard or pivot view, which declare none", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      reports: {
        r: { kind: "kpi", entity: "Prescription", measure: { name: "n", kind: "count" } },
      },
      views: {
        v: { kind: "pivot", entity: "Prescription", reportRef: "r" },
      },
    } as Manifest;
    expect(() => validateManifest(m)).not.toThrow();
  });
});

describe("validateManifest — view permissions and states", () => {
  const entityFixture = {
    name: "Prescription",
    fields: [
      { name: "qty", type: { kind: "integer" as const } },
      { name: "status", type: { kind: "text" as const } },
    ],
  };

  const lifecycle = {
    prescriptionLifecycle: {
      kind: "entityLifecycle" as const,
      entity: "Prescription",
      stateField: "status",
      states: [
        { name: "pending", category: "active" as const },
        { name: "verified", category: "terminal" as const },
      ],
      initialState: "pending",
      transitions: [{ name: "verify", from: "pending", to: "verified" }],
    },
  };

  it("rejects a view granting a role that is not declared", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      roles: { pharmacist: { name: "pharmacist" } },
      views: {
        v: {
          kind: "list",
          entity: "Prescription",
          columns: [{ field: "qty" }],
          permissions: { roles: ["auditor"] },
        },
      },
    } as Manifest;
    expect(() => validateManifest(m)).toThrow(
      /views\.v\.permissions\.roles.*'auditor' which is not declared/s,
    );
  });

  it("accepts a view granting a declared role", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      roles: { pharmacist: { name: "pharmacist" } },
      views: {
        v: {
          kind: "list",
          entity: "Prescription",
          columns: [{ field: "qty" }],
          permissions: { roles: ["pharmacist"] },
        },
      },
    } as Manifest;
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects a kanban column pinned to a state no workflow declares", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      workflows: lifecycle,
      views: {
        v: {
          kind: "kanban",
          entity: "Prescription",
          stateField: "status",
          cardFields: ["qty"],
          columns: [
            { state: "pending", label: { en: "Pending" } },
            { state: "dispensed", label: { en: "Dispensed" } },
          ],
        },
      },
    } as Manifest;
    expect(() => validateManifest(m)).toThrow(
      /state 'dispensed' not declared in any workflow for entity 'Prescription'/,
    );
  });

  it("accepts a kanban board whose columns are all declared states", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      workflows: lifecycle,
      views: {
        v: {
          kind: "kanban",
          entity: "Prescription",
          stateField: "status",
          cardFields: ["qty"],
          columns: [
            { state: "pending", label: { en: "Pending" } },
            { state: "verified", label: { en: "Verified" } },
          ],
        },
      },
    } as Manifest;
    expect(() => validateManifest(m)).not.toThrow();
  });
});

describe("validateManifest — search", () => {
  const entityFixture = {
    name: "Prescription",
    fields: [
      { name: "drug", type: { kind: "text" as const } },
      { name: "status", type: { kind: "text" as const } },
    ],
  };

  it("accepts a search section that references declared fields", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      search: {
        entities: {
          Prescription: {
            indexedFields: [{ field: "drug", weight: "A" }],
            facets: ["status"],
          },
        },
        defaultDictionary: "simple",
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects a search entry for an unknown entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      search: {
        entities: {
          Missing: { indexedFields: [{ field: "x" }] },
        },
        defaultDictionary: "simple",
      },
    };
    expect(() => validateManifest(m)).toThrow(/'Missing'/);
  });

  it("rejects an indexed field whose root is not declared on the entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      search: {
        entities: {
          Prescription: {
            indexedFields: [{ field: "patient.name", weight: "A" }],
          },
        },
        defaultDictionary: "simple",
      },
    };
    expect(() => validateManifest(m)).toThrow(
      /indexed field 'patient.name' has no matching root field/,
    );
  });

  it("accepts indexing a trait-supplied field, which the entity resolves to", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ ...entityFixture, traits: ["auditable"] }],
      search: {
        entities: {
          Prescription: {
            indexedFields: [{ field: "drug", weight: "A" }],
            facets: ["created_at"],
          },
        },
        defaultDictionary: "simple",
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects a facet path whose root is not declared on the entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [entityFixture],
      search: {
        entities: {
          Prescription: {
            indexedFields: [{ field: "drug" }],
            facets: ["unknown_facet"],
          },
        },
        defaultDictionary: "simple",
      },
    };
    expect(() => validateManifest(m)).toThrow(
      /facet 'unknown_facet' has no matching root field/,
    );
  });
});
