import type { RouteDefinition, IncomingRequest } from "@crossengin/api-gateway";
import type {
  AbacBatchEvaluator,
  AbacEvaluationInput,
  AbacEvaluator,
  AbacOutcome,
  RoleDefinition,
} from "@crossengin/auth";
import { describe, expect, it } from "vitest";
import { buildIncomingRequest } from "./adapters.js";
import { HandlerRegistry } from "./dispatcher.js";
import {
  MapRedactionRegistry,
  type ResponseRecordShape,
  type ResponseRedactionSpec,
} from "./redaction.js";
import { GatewayRuntime } from "./runtime.js";
import {
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
} from "./stores.js";

const ROLES: ReadonlyMap<string, RoleDefinition> = new Map([
  ["clinician", { name: "clinician" }],
  ["front_desk", { name: "front_desk" }],
]);

function publicRoute(): RouteDefinition {
  return {
    id: "rt_patients001",
    operationId: "patients.list",
    method: "GET",
    pathSegments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "patients" },
    ],
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

function getRequest(): IncomingRequest {
  return buildIncomingRequest({
    id: "req_patients00001",
    receivedAt: "2026-06-03T12:00:00.000Z",
    method: "GET",
    path: "/v1/patients",
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.7",
  });
}

const PATIENT_BODY = {
  data: [
    { id: "p1", mrn: "MRN-001", given_name: "Ada", status: "active" },
    { id: "p2", mrn: "MRN-002", given_name: "Linus", status: "inactive" },
  ],
  cursor: "next",
};

function specForRole(role: string): ResponseRedactionSpec {
  return {
    classifiedFields: [
      { name: "mrn", classification: "phi" },
      { name: "given_name", classification: "pii" },
      { name: "status" },
    ],
    roles: ROLES,
    rolesForPrincipal: () => ({ primaryRole: role }),
    recordShape: "page",
    policy: { privilegedRoles: ["clinician"] },
  };
}

function buildRuntime(role: string): GatewayRuntime {
  return runtimeFor(specForRole(role), PATIENT_BODY);
}

function runtimeFor(spec: ResponseRedactionSpec, body: unknown): GatewayRuntime {
  const routes = new InMemoryRouteRegistry().register(publicRoute());
  const handlers = new HandlerRegistry().register("patients.list", () => ({
    kind: "json",
    status: 200,
    body,
  }));
  return new GatewayRuntime({
    routes,
    handlers,
    principalResolver: new InMemoryPrincipalResolver(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    rateLimitChecker: new InMemoryRateLimitChecker({ limit: 100 }),
    clock: { now: () => new Date("2026-06-03T12:00:00.000Z") },
    redactionRegistry: new MapRedactionRegistry().register("patients.list", spec),
  });
}

function parseBody(bytes: Uint8Array | null): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as Record<string, unknown>;
}

describe("GatewayRuntime — response redaction by classification", () => {
  it("strips PHI/PII fields for a non-privileged principal", async () => {
    const { response, execution } = await buildRuntime("front_desk").handleRequest(getRequest());
    expect(response.status).toBe(200);
    const body = parseBody(response.bodyBytes);
    const rows = body["data"] as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ id: "p1", status: "active" });
    expect(rows[1]).toEqual({ id: "p2", status: "inactive" });
    expect(body["cursor"]).toBe("next");
    const transform = execution.stages.find((s) => s.stage === "transform_response");
    expect(transform?.reason).toBe("redacted_2_fields");
  });

  it("returns the full record for a privileged principal", async () => {
    const { response } = await buildRuntime("clinician").handleRequest(getRequest());
    const body = parseBody(response.bodyBytes);
    const rows = body["data"] as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ id: "p1", mrn: "MRN-001", given_name: "Ada", status: "active" });
  });

  it("recomputes content-length after redaction", async () => {
    const { response } = await buildRuntime("front_desk").handleRequest(getRequest());
    const actual = (response.bodyBytes ?? new Uint8Array()).byteLength;
    expect(Number(response.headers["content-length"])).toBe(actual);
  });

  it("leaves responses untouched when no registry is configured", async () => {
    const routes = new InMemoryRouteRegistry().register(publicRoute());
    const handlers = new HandlerRegistry().register("patients.list", () => ({
      kind: "json",
      status: 200,
      body: PATIENT_BODY,
    }));
    const runtime = new GatewayRuntime({
      routes,
      handlers,
      principalResolver: new InMemoryPrincipalResolver(),
      idempotencyStore: new InMemoryIdempotencyStore(),
      rateLimitChecker: new InMemoryRateLimitChecker({ limit: 100 }),
      clock: { now: () => new Date("2026-06-03T12:00:00.000Z") },
    });
    const { response } = await runtime.handleRequest(getRequest());
    const rows = parseBody(response.bodyBytes)["data"] as Array<Record<string, unknown>>;
    expect(rows[0]).toHaveProperty("mrn");
  });
});

const API_KEY = "ak_clinician_0001";
const CLINICIAN_ID = "00000000-0000-4000-8000-000000000010";

/**
 * The obligation has to be reachable, which means the principal's attributes have to have been
 * *resolved*: since ADR-0341 `dischargeAbac` refuses `undischargeable` on `abacAttributes === null`
 * before the evaluator runs, so an anonymous request would never produce a deferral at all. So
 * these cases authenticate — an api key through an `OpaqueTokenLookup` — and the resolver hands back
 * a principal carrying a department, exactly as the live auth stage does.
 */
function authenticatedRuntime(spec: ResponseRedactionSpec, body: unknown): GatewayRuntime {
  const routes = new InMemoryRouteRegistry().register(publicRoute());
  const handlers = new HandlerRegistry().register("patients.list", () => ({
    kind: "json",
    status: 200,
    body,
  }));
  const principalResolver = new InMemoryPrincipalResolver().register(CLINICIAN_ID, {
    principalId: CLINICIAN_ID,
    tenantId: "00000000-0000-4000-8000-0000000000aa",
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
    abacAttributes: { department: "clinical" },
  });
  return new GatewayRuntime({
    routes,
    handlers,
    principalResolver,
    idempotencyStore: new InMemoryIdempotencyStore(),
    rateLimitChecker: new InMemoryRateLimitChecker({ limit: 100 }),
    clock: { now: () => new Date("2026-06-03T12:00:00.000Z") },
    opaqueTokenLookup: {
      lookup: async (_request, token) =>
        token === API_KEY
          ? {
              principalRef: CLINICIAN_ID,
              scopes: [],
              tenantId: "00000000-0000-4000-8000-0000000000aa",
            }
          : null,
    },
    redactionRegistry: new MapRedactionRegistry().register("patients.list", spec),
  });
}

function authedRequest(): IncomingRequest {
  return buildIncomingRequest({
    id: "req_patients00002",
    receivedAt: "2026-06-03T12:00:00.000Z",
    method: "GET",
    path: "/v1/patients",
    headers: { "x-api-key": API_KEY },
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.7",
  });
}

/**
 * `mrn` carries a record-bearing obligation: readable only on a patient in the principal's own
 * department. Asked with no record the evaluator answers `deferred`, which is the signal to
 * recompute per record — and asked with one it compares, which is the question that was
 * inexpressible before ADR-0342.
 */
function departmentSpec(
  recordShape: ResponseRecordShape,
  seen: AbacEvaluationInput[],
): ResponseRedactionSpec {
  const evaluator: AbacEvaluator = (input) => {
    seen.push(input);
    if (input.record === undefined) return "deferred";
    return input.record["department"] === input.principal.abacAttributes?.["department"]
      ? "satisfied"
      : "denied";
  };
  return {
    classifiedFields: [
      { name: "mrn", classification: "phi" },
      { name: "given_name", classification: "pii" },
    ],
    roles: ROLES,
    rolesForPrincipal: () => ({ primaryRole: "clinician" }),
    recordShape,
    entityPermissions: {
      fields: { mrn: { read: { roles: ["clinician"], abac: "p.same_dept" } } },
    },
    // Privileged for every class, so `given_name` is never withheld and `mrn`'s obligation is the
    // only thing deciding anything.
    policy: { privilegedRoles: ["clinician"] },
    abac: { entity: "Patient", evaluator },
  };
}

const DEPARTMENT_BODY = {
  data: [
    { id: "p1", department: "clinical", mrn: "MRN-001", given_name: "Ada" },
    { id: "p2", department: "billing", mrn: "MRN-002", given_name: "Linus" },
    { id: "p3", department: "clinical", mrn: "MRN-003", given_name: "Grace" },
  ],
  page: { limit: 50, nextCursor: "abc" },
};

describe("GatewayRuntime — per-record redaction (ADR-0342's field_read closure)", () => {
  it("evaluates once for a three-record page when nothing defers", async () => {
    // The fast path's cost claim, which the ADR depends on: one evaluation per response, not one
    // per row. This obligation is discharged without a record, so nothing defers and today's
    // single whole-tree walk applies unchanged.
    const seen: AbacEvaluationInput[] = [];
    const spec: ResponseRedactionSpec = {
      ...departmentSpec("page", seen),
      abac: {
        entity: "Patient",
        evaluator: (input) => {
          seen.push(input);
          return "satisfied";
        },
      },
    };
    const { response, execution } = await authenticatedRuntime(spec, DEPARTMENT_BODY).handleRequest(
      authedRequest(),
    );
    expect(seen).toHaveLength(1);
    const rows = parseBody(response.bodyBytes)["data"] as Array<Record<string, unknown>>;
    for (const row of rows) expect(row).toHaveProperty("mrn");
    const transform = execution.stages.find((s) => s.stage === "transform_response");
    // Nothing was redacted at all, so the stage reports the status rather than a count.
    expect(transform?.reason).toBe("status_200");
  });

  it("evaluates once plus once per record when a field defers, and the records differ", async () => {
    const seen: AbacEvaluationInput[] = [];
    const { response, execution } = await authenticatedRuntime(
      departmentSpec("page", seen),
      DEPARTMENT_BODY,
    ).handleRequest(authedRequest());
    // One record-free pass plus one per record: 1 + 3.
    expect(seen).toHaveLength(4);
    expect(seen[0] !== undefined && "record" in seen[0]).toBe(false);
    expect(seen.slice(1).map((i) => i.record?.["id"])).toEqual(["p1", "p2", "p3"]);

    const rows = parseBody(response.bodyBytes)["data"] as Array<Record<string, unknown>>;
    // Two records in one response, two answers — the whole point of the increment.
    expect(rows[0]).toEqual({ id: "p1", department: "clinical", mrn: "MRN-001", given_name: "Ada" });
    expect(rows[1]).toEqual({ id: "p2", department: "billing", given_name: "Linus" });
    expect(rows[2]).toEqual({
      id: "p3",
      department: "clinical",
      mrn: "MRN-003",
      given_name: "Grace",
    });

    // The record-free count, not a per-row one: `mrn` deferred with no record, so one field.
    const transform = execution.stages.find((s) => s.stage === "transform_response");
    expect(transform?.reason).toBe("redacted_1_fields");
  });

  it("leaves the page wrapper untouched on the per-record path", async () => {
    const seen: AbacEvaluationInput[] = [];
    const { response } = await authenticatedRuntime(
      departmentSpec("page", seen),
      DEPARTMENT_BODY,
    ).handleRequest(authedRequest());
    expect(parseBody(response.bodyBytes)["page"]).toEqual({ limit: 50, nextCursor: "abc" });
  });

  it("applies the record's own set to a `record`-shaped response", async () => {
    const seen: AbacEvaluationInput[] = [];
    const { response } = await authenticatedRuntime(departmentSpec("record", seen), {
      id: "p1",
      department: "clinical",
      mrn: "MRN-001",
      given_name: "Ada",
    }).handleRequest(authedRequest());
    // 1 record-free + 1 for the body itself.
    expect(seen).toHaveLength(2);
    expect(parseBody(response.bodyBytes)).toEqual({
      id: "p1",
      department: "clinical",
      mrn: "MRN-001",
      given_name: "Ada",
    });
  });

  it("keeps a `record`-shaped response redacted when its own record does not match", async () => {
    const seen: AbacEvaluationInput[] = [];
    const { response } = await authenticatedRuntime(departmentSpec("record", seen), {
      id: "p2",
      department: "billing",
      mrn: "MRN-002",
    }).handleRequest(authedRequest());
    expect(parseBody(response.bodyBytes)).toEqual({ id: "p2", department: "billing" });
  });

  it("answers an aliased record consistently", async () => {
    // The per-record sets are keyed by object identity, so one object appearing twice in `data`
    // collapses to one map entry. Both positions must still get that record's own answer, which is
    // the same answer — a record cannot be two things in one response.
    const seen: AbacEvaluationInput[] = [];
    const row = { id: "p1", department: "clinical", mrn: "MRN-001", given_name: "Ada" };
    const { response } = await authenticatedRuntime(departmentSpec("page", seen), {
      data: [row, row],
    }).handleRequest(authedRequest());
    const rows = parseBody(response.bodyBytes)["data"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(row);
    expect(rows[1]).toEqual(row);
  });

  it("applies the base set and asks no record question for a `none`-shaped response", async () => {
    // Fail-closed and vacuous: there is no record, so the deferral stands and the stricter
    // record-free set applies — with no extra evaluation, because there is nothing to ask about.
    const seen: AbacEvaluationInput[] = [];
    const { response, execution } = await authenticatedRuntime(departmentSpec("none", seen), {
      count: 3,
      mrn: "MRN-leaked",
    }).handleRequest(authedRequest());
    expect(seen).toHaveLength(1);
    expect(parseBody(response.bodyBytes)).toEqual({ count: 3 });
    const transform = execution.stages.find((s) => s.stage === "transform_response");
    expect(transform?.reason).toBe("redacted_1_fields");
  });
});

/**
 * Two obligated fields, not one: with F = 1 a pooled call and a per-record call produce the same
 * figure, so the fence below could not tell them apart. Both regimes answer through one predicate,
 * so a difference in the response bytes is a difference in the plumbing and never in two
 * hand-written rules — which is what lets the batch be checked for being cheap *and* right at once.
 */
function sameDepartment(input: AbacEvaluationInput): AbacOutcome {
  if (input.record === undefined) return "deferred";
  return input.record["department"] === input.principal.abacAttributes?.["department"]
    ? "satisfied"
    : "denied";
}

interface FanOutCounts {
  readonly single: AbacEvaluationInput[];
  readonly batch: (readonly AbacEvaluationInput[])[];
}

function fanOutCounts(): FanOutCounts {
  return { single: [], batch: [] };
}

function fanOutSpec(counts: FanOutCounts, withBatch: boolean): ResponseRedactionSpec {
  const evaluator: AbacEvaluator = (input) => {
    counts.single.push(input);
    return sameDepartment(input);
  };
  const evaluateBatch: AbacBatchEvaluator = (inputs) => {
    counts.batch.push(inputs);
    return inputs.map((input, index) => ({ index, outcome: sameDepartment(input) }));
  };
  return {
    classifiedFields: [
      { name: "mrn", classification: "phi" },
      { name: "given_name", classification: "pii" },
    ],
    roles: ROLES,
    rolesForPrincipal: () => ({ primaryRole: "clinician" }),
    recordShape: "page",
    entityPermissions: {
      fields: {
        mrn: { read: { roles: ["clinician"], abac: "p.same_dept" } },
        given_name: { read: { roles: ["clinician"], abac: "p.same_dept" } },
      },
    },
    policy: { privilegedRoles: ["clinician"] },
    abac: {
      entity: "Patient",
      evaluator,
      ...(withBatch ? { evaluateBatch } : {}),
    },
  };
}

const FAN_OUT_BODY = {
  data: [
    { id: "p1", department: "clinical", mrn: "MRN-001", given_name: "Ada" },
    { id: "p2", department: "billing", mrn: "MRN-002", given_name: "Linus" },
    { id: "p3", department: "clinical", mrn: "MRN-003", given_name: "Grace" },
  ],
  page: { limit: 50, nextCursor: "abc" },
};

/** N = 3, F = 2. Named so the arithmetic in the assertions is readable rather than magic. */
const N = 3;
const F = 2;

/** What the per-record pass must produce, whichever regime computed it. */
const FAN_OUT_EXPECTED = {
  data: [
    { id: "p1", department: "clinical", mrn: "MRN-001", given_name: "Ada" },
    { id: "p2", department: "billing" },
    { id: "p3", department: "clinical", mrn: "MRN-003", given_name: "Grace" },
  ],
  page: { limit: 50, nextCursor: "abc" },
};

/**
 * The fence. These are **counts**, and they are the only thing standing between the per-record pass
 * and the N × F fan-out it had when ADR-0343 landed: a regression there is invisible in the
 * response, which is why neither correctness nor cost can be pinned alone. Both regimes are asserted
 * byte-for-byte identical to each other *and* to the expected result, so the batch cannot be
 * correct-and-cheap while being wrong, and cannot be cheap by not being asked.
 *
 * It authenticates, for ADR-0343's own reason: an anonymous request carries
 * `abacAttributes: null`, and `dischargeAbac` refuses `undischargeable` *before* the evaluator —
 * so a fence over an anonymous request would count zero calls in every regime and pass vacuously.
 */
describe("GatewayRuntime — the per-record pass is one evaluator call", () => {
  it("costs two batch calls for the whole response: F then N × F", async () => {
    const counts = fanOutCounts();
    const { response, execution } = await authenticatedRuntime(
      fanOutSpec(counts, true),
      FAN_OUT_BODY,
    ).handleRequest(authedRequest());

    // One per pass, and that is the whole figure for the response: the record-free pass asks about
    // F obligated fields with no record, and the per-record pass pools every remaining cell into
    // one call instead of the N × F it made when ADR-0343 landed. The record-free pass is pooled
    // too, because `computeClassifiedFieldRedaction` routes through the same `dischargeAbacBatch`
    // — which is why F and not 1: the pool is per *call*, not per field.
    expect(counts.batch).toHaveLength(2);
    expect(counts.batch[0]).toHaveLength(F);
    expect(counts.batch[0]?.every((input) => input.record === undefined)).toBe(true);
    expect(counts.batch[1]).toHaveLength(N * F);
    // Zero: a batch evaluator is consulted *instead of* the single one, never beside it, so a
    // non-zero count here would mean a reader had slipped back onto the per-cell path.
    expect(counts.single).toHaveLength(0);
    expect(parseBody(response.bodyBytes)).toEqual(FAN_OUT_EXPECTED);
    const transform = execution.stages.find((s) => s.stage === "transform_response");
    expect(transform?.reason).toBe(`redacted_${F.toString()}_fields`);
  });

  it("asks the batch about every record × field cell exactly once", async () => {
    const counts = fanOutCounts();
    await authenticatedRuntime(fanOutSpec(counts, true), FAN_OUT_BODY).handleRequest(
      authedRequest(),
    );
    // A set, not a sequence: pooling order is not part of the contract (the answers come back
    // indexed), so pinning it would fail a record-major pool against a field-major one for no
    // reason. What matters is that every cell is in the one call and none is there twice.
    expect(
      [...(counts.batch[1] ?? [])]
        .map((input) => `${String(input.record?.["id"])}|${input.field ?? "-"}`)
        .sort(),
    ).toEqual([
      "p1|given_name",
      "p1|mrn",
      "p2|given_name",
      "p2|mrn",
      "p3|given_name",
      "p3|mrn",
    ]);
  });

  it("costs F + N × F single calls with no batch evaluator, and answers identically", async () => {
    // Today's cost, pinned: a deployment that declared no batch must keep paying exactly what it
    // paid, so a change that made the no-batch path cheaper *or* dearer is visible here rather than
    // in a benchmark nobody runs.
    const counts = fanOutCounts();
    const { response } = await authenticatedRuntime(
      fanOutSpec(counts, false),
      FAN_OUT_BODY,
    ).handleRequest(authedRequest());
    expect(counts.batch).toHaveLength(0);
    expect(counts.single).toHaveLength(F + N * F);
    expect(parseBody(response.bodyBytes)).toEqual(FAN_OUT_EXPECTED);
  });

  it("returns byte-identical responses with and without the batch", async () => {
    const batched = await authenticatedRuntime(
      fanOutSpec(fanOutCounts(), true),
      FAN_OUT_BODY,
    ).handleRequest(authedRequest());
    const unbatched = await authenticatedRuntime(
      fanOutSpec(fanOutCounts(), false),
      FAN_OUT_BODY,
    ).handleRequest(authedRequest());
    expect(new TextDecoder().decode(batched.response.bodyBytes ?? new Uint8Array())).toBe(
      new TextDecoder().decode(unbatched.response.bodyBytes ?? new Uint8Array()),
    );
    expect(batched.response.headers["content-length"]).toBe(
      unbatched.response.headers["content-length"],
    );
  });

  it("makes no second call at all when nothing defers", async () => {
    // The fast path, which is every deployment today: the record-free pass and today's whole-tree
    // walk, with the records never enumerated and no per-record pass at any cost.
    const counts = fanOutCounts();
    const spec = fanOutSpec(counts, true);
    const neverDefers: ResponseRedactionSpec = {
      ...spec,
      abac: {
        entity: "Patient",
        evaluator: (input) => {
          counts.single.push(input);
          return "satisfied";
        },
        evaluateBatch: (inputs) => {
          counts.batch.push(inputs);
          return inputs.map((_input, index) => ({ index, outcome: "satisfied" as const }));
        },
      },
    };
    const { response } = await authenticatedRuntime(neverDefers, FAN_OUT_BODY).handleRequest(
      authedRequest(),
    );
    expect(counts.batch).toHaveLength(1);
    expect(counts.batch[0]).toHaveLength(F);
    expect(counts.single).toHaveLength(0);
    expect(parseBody(response.bodyBytes)).toEqual(FAN_OUT_BODY);
  });
});
