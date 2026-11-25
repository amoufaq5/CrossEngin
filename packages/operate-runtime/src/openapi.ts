import type { RouteDefinition } from "@crossengin/api-gateway";
import {
  AUTH_SCHEMES,
  AUTH_SCHEME_SECURITY_DOC,
  OPENAPI_PATH_ITEM_FIELD,
  PROBLEM_TYPES,
  RESIDENCY_REGION_HEADER,
  pathParameterSchemaPattern,
  pathTemplateCollisions,
  renderPathTemplate,
} from "@crossengin/api-gateway";
import {
  RESIDENCY_REFUSALS,
  RESIDENCY_UNRESOLVED_RETRY_AFTER_SECONDS,
} from "@crossengin/api-gateway-runtime";
import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity, Trait } from "@crossengin/types/meta-schema";

import { listQueryParameters, LIST_PARAMETER_COMPLEMENT_NOTE } from "./openapi-list-params.js";
import { entityLifecycleShape, entitySchemas, type JsonSchema } from "./openapi-schema.js";
import { entityCamel } from "./slugs.js";
import type { RouteAction, RouteSpec } from "./operations.js";
import type { WriteSurface } from "./write-surface.js";

/**
 * Where this deployment's API description is served, under which operation id, and in which media
 * type — the one spelling of all four, and **here rather than in `openapi-handler.ts`** because the
 * emitter needs them too: it describes its own route's success response, and the handler module
 * imports this one, so putting them there and importing them back would be a module cycle over
 * `const` bindings.
 *
 * The segments are what `compileOperateServer` registers and the rendered path is what a boot line
 * and a document reader are told, so the two cannot come to disagree: the path was otherwise a
 * `["v1", "meta", "openapi"]` array in one file and a `/v1/meta/openapi` string in another, which
 * is the second-spelling shape this increment already had to fix once for `x-api-key`.
 *
 * `OPENAPI_MEDIA_TYPE` is the OpenAPI Initiative's own registration, carrying the version parameter
 * so a reader learns which version it holds without parsing the body. Supplying it is load-bearing
 * rather than cosmetic and it is checked against the adapter: `outgoingResponseFromJson` fills
 * `content-type` **only when absent**, so this survives, where a second header set would be
 * silently discarded.
 */
export const OPENAPI_PATH_SEGMENTS: readonly string[] = ["v1", "meta", "openapi"];
export const OPENAPI_PATH = `/${OPENAPI_PATH_SEGMENTS.join("/")}`;
export const OPENAPI_OPERATION_ID = "meta.openapi.read";
export const OPENAPI_MEDIA_TYPE = "application/openapi+json;version=3.1.0";

/**
 * A fact about this API the document provably cannot carry.
 *
 * `reach` borrows `pg-unreachable-stores.ts`'s distinction, because it is the one that decides what
 * the next reader should do: **`ordering`** means the facts exist and the emitter is not given them,
 * so the gap closes by wiring; **`shape`** means the format cannot express it, so it closes by a
 * format change or not at all. Calling both "not described" is what sends somebody to build the
 * thing that cannot be built honestly.
 */
export const OPENAPI_COVERAGE_KINDS = [
  "undeclared_authorization",
  "undeclared_parameters",
  "undeclared_success_response",
  "surface_outside_registry",
  "per_tenant_surface",
] as const;
export type OpenApiCoverageKind = (typeof OPENAPI_COVERAGE_KINDS)[number];

export interface OpenApiCoverageGap {
  readonly kind: OpenApiCoverageKind;
  readonly reach: "ordering" | "shape";
  readonly detail: string;
}

export const OPENAPI_REFUSALS = [
  "wildcard_path",
  "path_collision",
  "method_not_describable",
  "write_surface_absent",
] as const;
export type OpenApiRefusalKind = (typeof OPENAPI_REFUSALS)[number];

export interface OpenApiRefusal {
  readonly kind: OpenApiRefusalKind;
  readonly detail: string;
  readonly operationIds: readonly string[];
}

export interface OpenApiEmitInput {
  readonly manifest: Manifest;
  /** Every route the serving registry holds — `InMemoryRouteRegistry.list()`, read at request time. */
  readonly routes: readonly RouteDefinition[];
  /** The manifest-derived specs, which carry the entity attribution and the list config. */
  readonly routeSpecs: readonly RouteSpec[];
  /**
   * The manifest-derived specs are the whole of what the schemas need: see `entitySchemas` for why
   * this takes no deployment wiring, which it did until both arms that read one were measured.
   */
  readonly title: string;
  /** Identifies the described contract. The manifest hash, so the version moves iff the API does. */
  readonly version: string;
  /** Declared absences the caller knows about and the emitter cannot see. */
  readonly coverage: readonly OpenApiCoverageGap[];
  /**
   * The compiled server's write surfaces — which fields a client may name. Required: the fields a
   * write effect stamps depend on which effects this server wired, which the manifest alone does
   * not say, and a request schema built without them would publish a stamped field as writable.
   */
  readonly writeSurfaces: ReadonlyMap<string, WriteSurface>;
  /**
   * The region gate this server applies, or `null` for none. Required, so a caller states which:
   * an optional field here would make "no gate" what silence buys, and the gate-configured
   * deployment is exactly the one that would then publish no residency response.
   */
  readonly residency: OpenApiResidencyDeclaration | null;
  /**
   * The tenant-status gate this server applies, or `null` for none (ADR-0471). Required for
   * `residency`'s reason: the shipped compose passes `--tenant-status-gate`, so the deployment an
   * optional field would silently describe wrongly is the one that ships.
   */
  readonly tenantStatus: OpenApiTenantStatusDeclaration | null;
  /**
   * Whether every entity write is recorded by the write audit (ADR-0428), or `null` when nothing
   * records it. A recorder that cannot make the record refuses the write with a 503, so the status
   * exists exactly when a recorder does — `--store memory` builds none, and declaring the 503 there
   * would describe a refusal the server has no path to.
   */
  readonly writeAudit: OpenApiWriteAuditDeclaration | null;
  /**
   * Which of the handler's conditional refusals this server can reach (ADR-0471). Required, so a
   * caller cannot leave a refusal undeclared by omission.
   */
  readonly writeRefusals: OpenApiWriteRefusalDeclaration;
}

/**
 * The two facts about a compiled server's writes the manifest alone does not say.
 *
 * `checks` is whether a write guard, a write effect or the segregation-of-duties check runs. All
 * three refuse through functions this emitter cannot read, so whether a delete or a transition can
 * answer a 422 (and a delete a guard's 409) is known only as "something that can refuse is wired".
 *
 * `stateConditionedEntities` is the handler context's own `lifecycleStateFields` key set: the
 * entities whose update and delete are conditional on the stored state the handler read, and so can
 * answer `state_changed`. Supplied rather than re-derived, because the index also covers the
 * state-locked documents that declare a `state` field and no lifecycle, and a second derivation here
 * would be a second spelling of that rule.
 */
export interface OpenApiWriteRefusalDeclaration {
  readonly checks: boolean;
  readonly stateConditionedEntities: ReadonlySet<string>;
}

/**
 * What the tenant-status gate covers and what it answers, as the gate itself reports it (ADR-0471).
 *
 * `null` on `OpenApiEmitInput.tenantStatus` is a **claim**: no gate is applied, so no operation can
 * answer its 403 or its 503. Present, `gatedOperationIds` is what `applyTenantStatusGate` returned,
 * so the exempt-prefix rule has one spelling; and the problem types, reasons, states and retry delay
 * come from the gate's own constants, because the document describes a body this package cannot
 * import the builder of (`operate-runtime` does not depend on `operate-server`).
 */
export interface OpenApiTenantStatusDeclaration {
  readonly gatedOperationIds: ReadonlySet<string>;
  /** The 403: the workspace's state forbids the request, or the workspace is not provisioned. */
  readonly refused: {
    readonly type: string;
    readonly reasons: readonly string[];
    /** Every state a 403 can name in `tenantStatus`; `null` (not provisioned) is added here. */
    readonly states: readonly string[];
  };
  /** The 503: the workspace's state could not be established, so nothing was run. */
  readonly unavailable: {
    readonly type: string;
    readonly reason: string;
    readonly retryAfterSeconds: number;
  };
}

/**
 * The write audit's reach beyond the entity routes. The entity create/update/delete/transition
 * operations are identified by their `RouteSpec`; an association link or unlink has none, so the
 * compiled server names those operations here.
 */
export interface OpenApiWriteAuditDeclaration {
  readonly associationWriteOperationIds: ReadonlySet<string>;
}

/**
 * What this deployment's residency gate covers, as the gate itself reported it (ADR-0462).
 *
 * `null` on `OpenApiEmitInput.residency` is a **claim**: no region gate is configured, so no
 * operation can answer a residency refusal and the document declares none. Declaring one anyway
 * would be the falsely-complete direction in reverse — a status a generated client is made to
 * handle, and an operator reading the document is told can happen, on a deployment whose code has
 * no path to it.
 *
 * Present, it is not re-derived from flags: `gatedOperationIds` is what `applyResidencyGate`
 * returned, the operations it actually wrapped, so the document and the gate are one fact rather
 * than two spellings of the exempt-prefix rule.
 */
export interface OpenApiResidencyDeclaration {
  /** The operations the post-auth gate wraps. Only these can answer its 503. */
  readonly gatedOperationIds: ReadonlySet<string>;
  /**
   * The header the advisory pre-auth check reads a tenant hint from. That check runs ahead of route
   * matching on every routed request, so it can answer 421 or 403 even on an operation the gate
   * exempts — when, and only when, the caller sends this header.
   */
  readonly tenantHintHeader: string;
}

export type OpenApiEmit =
  | { readonly document: Readonly<Record<string, unknown>>; readonly refused: null }
  | { readonly document: null; readonly refused: OpenApiRefusal };

/**
 * The `components.securitySchemes` object and the `security` requirement that names it, both
 * **derived** from `AUTH_SCHEME_SECURITY_DOC` — the gateway's own total map over every auth scheme,
 * `null` for each one this build does not serve.
 *
 * Derived rather than written here for two reasons that pull the same way. A hand-written pair
 * would be ADR-0288's maintained list in the one place a stale copy is read as a *capability*: a
 * `securitySchemes` entry is a **definition**, so a generator reads it as supported and emits a
 * client method for it, which means publishing one for `api_key_query` would invite exactly the
 * request ADR-0384 exists to refuse. And a sixth served scheme would then be described by nobody,
 * where the map makes it a compile error at the declaration site.
 *
 * `key` is the only field that is not part of the object; everything else is OpenAPI's own field
 * name, so this copies and never translates.
 */
const securityFromServedSchemes = (): {
  readonly schemes: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly requirement: readonly Readonly<Record<string, readonly string[]>>[];
} => {
  const schemes: Record<string, Readonly<Record<string, unknown>>> = {};
  const requirement: Readonly<Record<string, readonly string[]>>[] = [];
  for (const scheme of AUTH_SCHEMES) {
    const doc = AUTH_SCHEME_SECURITY_DOC[scheme];
    if (doc === null) continue;
    const { key, ...object } = doc;
    schemes[key] = object;
    // One requirement object per scheme, which is OpenAPI's OR. A single object carrying both keys
    // would be AND — "present a JWT *and* an api key" — which no route demands.
    requirement.push({ [key]: [] });
  }
  return { schemes, requirement };
};

const problemSchema: JsonSchema = {
  type: "object",
  description:
    "An RFC 9457 problem document. Note that it is the MINORITY error shape on this API: the " +
    "gateway's own denials (401, 403, 404, 429) carry `application/problem+json`, while a handler's " +
    "refusals carry `application/json` with an `{error, detail}` body.",
  properties: {
    type: { type: "string", format: "uri" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
  },
};

const handlerErrorSchema: JsonSchema = {
  type: "object",
  description: "A handler refusal. `error` is a stable code; `detail` names the subject.",
  properties: { error: { type: "string" }, detail: { type: "string" } },
  required: ["error"],
};

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

// ---------------------------------------------------------------------------
// Refusal responses, as shared components composed from the producers that reach an operation.
//
// A status is declared on an operation exactly when something wired on this server can answer it
// there, and its content admits exactly those producers' bodies. Each producer is one *arm*; an
// operation's entry for a status is the component composed from the arms that reach it, named by
// those arms, so two operations reached by the same producers share one component and the document
// holds only components some operation references (no dead component, by construction).
// ---------------------------------------------------------------------------

interface ArmHeader {
  readonly description: string;
  readonly required: boolean;
  readonly schema: JsonSchema;
}

/** One producer of one status: its sentence, the bodies it sends, and the headers it sets. */
interface ResponseArm {
  /** The component-name segment this arm contributes; `""` for an arm every entry carries. */
  readonly key: string;
  readonly sentence: string;
  /** Schema component names this producer answers under `application/problem+json`. */
  readonly problem: readonly string[];
  /** Schema component names this producer answers under `application/json`. */
  readonly json: readonly string[];
  readonly headers?: Readonly<Record<string, ArmHeader>>;
}

// `anyOf` rather than `oneOf`: a residency problem is also a valid `Problem`, so `oneOf` would
// reject the very body it describes. Typed as a plain object because `JsonSchema` models the entity
// schemas and carries no `anyOf`; this is a Media Type Object's schema, not an entity's.
const schemaRef = (name: string): Readonly<Record<string, unknown>> => ({
  $ref: `#/components/schemas/${name}`,
});
const mediaSchema = (names: readonly string[]): Readonly<Record<string, unknown>> =>
  names.length === 1 ? schemaRef(names[0]!) : { anyOf: names.map(schemaRef) };

const uniqueInOrder = (values: readonly string[]): readonly string[] => [...new Set(values)];

/**
 * The Response Object for a set of arms. A header two arms set is required only if every arm in the
 * entry sets it as required — the residency 503 sends `retry-after` and the write audit's does not,
 * so on an entry carrying both a client cannot rely on it.
 */
const composeResponse = (arms: readonly ResponseArm[]): Readonly<Record<string, unknown>> => {
  const problem = uniqueInOrder(arms.flatMap((a) => a.problem));
  const json = uniqueInOrder(arms.flatMap((a) => a.json));
  const headerNames = uniqueInOrder(arms.flatMap((a) => Object.keys(a.headers ?? {})));
  const headers: Record<string, ArmHeader> = {};
  for (const name of headerNames) {
    const declared = arms.flatMap((a) => (a.headers?.[name] !== undefined ? [a.headers[name]] : []));
    headers[name] = {
      description: declared.map((h) => h.description).join(" "),
      required: declared.length === arms.length && declared.every((h) => h.required),
      schema: declared[0]!.schema,
    };
  }
  const content: Record<string, unknown> = {};
  if (problem.length > 0) content["application/problem+json"] = { schema: mediaSchema(problem) };
  if (json.length > 0) content["application/json"] = { schema: mediaSchema(json) };
  return {
    description: arms.map((a) => a.sentence).join(" "),
    ...(headerNames.length > 0 ? { headers } : {}),
    content,
  };
};

/**
 * The role refusal and the unauthenticated refusal are the base arms of every operation's 403 and
 * 401. Each is answered by **two** producers with two shapes, and that is not a hedge: a pipeline
 * denial goes through `problems.ts` (`application/problem+json`, RFC 9457), while a handler refusal
 * is a `{kind: "json"}` output whose body `runtime.ts` preserves verbatim (`application/json`,
 * `{error, detail}`). Declaring one was wrong on **the live producer** — an anonymous `invoice.list`
 * answers `401 {"error":"tenant_required",…}` and an ungranted role `403 {"error":"forbidden",…}`,
 * both `application/json` — and the gateway's 401 is reachable too (eleven `authenticationRequired`
 * sites, all before route matching), so declaring only the other would be the same defect reversed.
 * The gateway's `forbidden` arm is gated on `route.requiredScopes.length > 0`, `[]` on every route in
 * the workspace, so today only the handler produces the 403 — and a deployment declaring a scope gets
 * the other shape with no document change.
 *
 * Components rather than inline entries (ADR-0471; ADR-0462's open question 5): identical on every
 * operation, so inline they cost one copy per operation.
 */
const UNAUTHENTICATED_ARM: ResponseArm = {
  key: "",
  sentence:
    "No usable credential. A credential presented in a scheme this build does not serve is " +
    "refused here by name rather than treated as anonymous (ADR-0384) — including `?api_key=`, " +
    "which is recognised and refused.",
  problem: ["Problem"],
  json: ["HandlerError"],
};

const ROLE_REFUSAL_ARM: ResponseArm = {
  key: "",
  sentence: "The principal's roles do not grant this operation on this entity.",
  problem: ["Problem"],
  json: ["HandlerError"],
};

export const UNAUTHENTICATED_RESPONSE = "Unauthenticated";
export const FORBIDDEN_RESPONSE = "Forbidden";

/**
 * The residency refusal's body, one component every residency response references (ADR-0457's one
 * builder, described once). Enumerations are read off `RESIDENCY_REFUSALS`, the builder's own map,
 * so a fourth refusal or a renamed reason moves the document with it.
 */
const residencyProblemSchema = (): JsonSchema => {
  const specs = Object.values(RESIDENCY_REFUSALS);
  return {
    type: "object",
    description:
      "A residency refusal (ADR-0457): an RFC 9457 problem from the region gate on the " +
      "authenticated tenant, or from the advisory pre-auth check on the tenant hint header. Both " +
      "produce the same bytes. `extensions.reason` is the stable code.",
    properties: {
      type: { type: "string", format: "uri", enum: specs.map((s) => PROBLEM_TYPES[s.key]) },
      title: { type: "string" },
      status: { type: "integer", enum: specs.map((s) => s.status) },
      detail: { type: "string" },
      extensions: {
        type: "object",
        properties: {
          reason: { type: "string", enum: specs.map((s) => s.reason) },
          correctRegion: {
            type: "string",
            description: `The tenant's home region; present on a 421, and also sent as \`${RESIDENCY_REGION_HEADER}\`.`,
          },
          retryAfterSeconds: { type: "integer", description: "Present on a 503." },
        },
        required: ["reason"],
      },
    },
    required: ["type", "title", "status", "detail", "extensions"],
  };
};

export const RESIDENCY_PROBLEM_COMPONENT = "ResidencyProblem";
export const RESIDENCY_MISDIRECTED_RESPONSE = "ResidencyMisdirected";
/** The 503 a residency-gated operation answers when no other declared producer reaches it. */
export const RESIDENCY_AWARE_UNAVAILABLE_RESPONSE = "UnavailableOrResidencyUnresolved";
/** The 403 every operation answers on a region-gated deployment with no tenant-status gate. */
export const RESIDENCY_AWARE_FORBIDDEN_RESPONSE = "ForbiddenOrResidencyViolation";

const responseRef = (name: string): Readonly<Record<string, unknown>> => ({
  $ref: `#/components/responses/${name}`,
});

const residencyMisdirectedResponse = (
  decl: OpenApiResidencyDeclaration,
): Readonly<Record<string, unknown>> => ({
  description:
    "This instance's region may not serve the tenant; retry against the region named in " +
    `\`${RESIDENCY_REGION_HEADER}\` and \`extensions.correctRegion\`. On an operation the region ` +
    `gate exempts (the platform routes), only the advisory pre-auth check answers this, and only ` +
    `when the request carries \`${decl.tenantHintHeader}\`.`,
  headers: {
    [RESIDENCY_REGION_HEADER]: {
      description: "The tenant's home region.",
      required: true,
      schema: { type: "string" },
    },
  },
  content: { "application/problem+json": { schema: ref(RESIDENCY_PROBLEM_COMPONENT) } },
});

/**
 * The residency 403 arm: `decideRegionRouting`'s `deny`, reachable only through a directory that
 * returns a profile allowing no region — which `ResidencyProfileSchema`'s refinement forbids, so
 * neither shipped directory can hold one, while `RegionGuardConfig` takes any directory and the
 * emitter cannot see which. Declared on every routed operation, because the pre-auth hint check runs
 * ahead of route matching for all of them.
 */
const RESIDENCY_FORBIDDEN_ARM: ResponseArm = {
  key: "OrResidencyViolation",
  sentence:
    "Or a residency profile allows no region at all (`residency-violation`), which no profile the " +
    "shipped directories accept can express.",
  problem: [RESIDENCY_PROBLEM_COMPONENT],
  json: [],
};

/**
 * The residency 503 arm, only where the region gate wraps the handler (the hint check passes an
 * unreadable directory on, ADR-0457's addendum). It keeps ADR-0462's generic `Problem` and
 * `HandlerError` arms rather than claiming to be the only 503 producer: a gated operation with no
 * `RouteSpec` (the AI design routes, the job routes) has 503 producers of its own that this emitter
 * cannot see, and the residency-only entry is what those operations are given.
 */
const RESIDENCY_UNAVAILABLE_ARM: ResponseArm = {
  key: "OrResidencyUnresolved",
  sentence:
    "Something this operation depends on could not be established, so the request was refused. " +
    "One producer is the region gate (`residency-unresolved`: the tenant's residency profile could " +
    "not be read, nothing was done); others answer `application/json` with an `{error, detail}` " +
    "body whose `detail` says whether the write was made — read it rather than assuming either way.",
  problem: ["Problem", RESIDENCY_PROBLEM_COMPONENT],
  json: ["HandlerError"],
  headers: {
    "retry-after": {
      description:
        `Seconds to wait; sent with the residency refusal (` +
        `${String(RESIDENCY_UNRESOLVED_RETRY_AFTER_SECONDS)}) and by some other producers, not by all.`,
      required: false,
      schema: { type: "integer" },
    },
  },
};

export const TENANT_STATE_PROBLEM_COMPONENT = "TenantStateProblem";
export const TENANT_STATUS_UNAVAILABLE_PROBLEM_COMPONENT = "TenantStatusUnavailableProblem";

/**
 * The tenant-status gate's 403 body, exactly as `tenantStateProblem` / `tenantUnknownProblem` build
 * it: an RFC 9457 problem whose `tenantStatus` and `reason` are **top-level members**, not an
 * `extensions` object — the gate predates ADR-0457's registry convention, and the document describes
 * the bytes it sends rather than the convention it might have used.
 */
const tenantStateProblemSchema = (decl: OpenApiTenantStatusDeclaration): JsonSchema => ({
  type: "object",
  description:
    "The tenant-status gate refused the request (ADR-0334): the workspace's lifecycle state forbids " +
    "it, or the credential names a workspace that is not provisioned (`tenantStatus: null`). Not " +
    "retryable — the state has to change first.",
  properties: {
    type: { type: "string", format: "uri", enum: [decl.refused.type] },
    title: { type: "string" },
    status: { type: "integer", enum: [403] },
    detail: { type: "string" },
    // `null` is a not-provisioned workspace. A union rather than `enum` with a `null` member, which
    // `JsonSchema` cannot type and which reads the same to a validator.
    tenantStatus: { oneOf: [{ type: "string", enum: [...decl.refused.states] }, { type: "null" }] },
    reason: { type: "string", enum: [...decl.refused.reasons] },
  },
  required: ["type", "title", "status", "detail", "tenantStatus", "reason"],
});

const tenantStatusUnavailableProblemSchema = (decl: OpenApiTenantStatusDeclaration): JsonSchema => ({
  type: "object",
  description:
    "The tenant-status gate could not establish the workspace's lifecycle state, so the request was " +
    "not run. Retryable.",
  properties: {
    type: { type: "string", format: "uri", enum: [decl.unavailable.type] },
    title: { type: "string" },
    status: { type: "integer", enum: [503] },
    detail: { type: "string" },
    reason: { type: "string", enum: [decl.unavailable.reason] },
  },
  required: ["type", "title", "status", "detail", "reason"],
});

const tenantStateForbiddenArm = (decl: OpenApiTenantStatusDeclaration): ResponseArm => ({
  key: "OrTenantStateRefused",
  sentence:
    `Or the tenant-status gate refused it (${decl.refused.reasons.map((r) => `\`${r}\``).join(", ")}): ` +
    "the workspace's lifecycle state forbids this request, or the workspace is not provisioned. " +
    "Not retryable.",
  problem: [TENANT_STATE_PROBLEM_COMPONENT],
  json: [],
});

const tenantStatusUnavailableArm = (decl: OpenApiTenantStatusDeclaration): ResponseArm => ({
  key: "OrTenantStatusUnresolved",
  sentence:
    `The tenant-status gate could not establish the workspace's lifecycle state ` +
    `(\`${decl.unavailable.reason}\`); the request was not run. Retryable.`,
  problem: [TENANT_STATUS_UNAVAILABLE_PROBLEM_COMPONENT],
  json: [],
  headers: {
    "retry-after": {
      description: `${String(decl.unavailable.retryAfterSeconds)} on the tenant-status refusal.`,
      required: true,
      schema: { type: "integer" },
    },
  },
});

/**
 * The write audit's 503 arm (ADR-0428). Its sentence names both outcomes because they tell the caller
 * opposite things: on a transactional store the write was rolled back and a retry is the remedy; on
 * an association link or unlink, which is not one transaction with its record, the write stands and
 * only its record is missing — `auditUnavailable`'s `detail` says which.
 */
const WRITE_AUDIT_UNAVAILABLE_ARM: ResponseArm = {
  key: "OrAuditUnrecorded",
  sentence:
    "The write audit could not record this write (`audit_unavailable`). Inside a transaction the " +
    "write was rolled back and a retry is the remedy; otherwise the write was made and only its " +
    "record is missing. `detail` says which.",
  problem: [],
  json: ["HandlerError"],
};

/**
 * The arm every declared 503 carries, because a 503 is never one producer's (ADR-0471's review). The
 * gateway pipeline answers some itself as an RFC 9457 `Problem` before or after any handler — a
 * principal whose standing cannot be read, a response that was never assembled — so an entry
 * admitting only the tenant gate's or the write audit's body would refuse a real response. Content
 * only, with no header: what those producers send in `retry-after` differs, so the composed entry
 * cannot promise it. It is not declared on its own, which leaves the gateway's 503 undeclared where
 * nothing else declares one; that is the older, incomplete direction rather than a false one.
 */
const GATEWAY_UNAVAILABLE_ARM: ResponseArm = {
  key: "",
  sentence:
    "The gateway pipeline can also answer a 503 of its own as an RFC 9457 problem; `type` (and " +
    "`extensions.error`, where set) says which.",
  problem: ["Problem"],
  json: [],
};

/**
 * The arm for an operation with no `RouteSpec`: its handler is not the entity handler, and the
 * injected routes answer 503s of their own as `application/json` (`ai_unavailable`,
 * `inbox_unavailable`, `job_queue_unavailable`, …) that this emitter cannot enumerate. Measured
 * before the review on the shipped compose, `POST /v1/ai/design` with no provider answered
 * `503 application/json` while its entry admitted only the tenant gate's `application/problem+json`.
 * The residency arm already admits this shape, so it is added only where that arm is absent.
 */
const ROUTE_OWN_UNAVAILABLE_ARM: ResponseArm = {
  key: "OrRouteOwn",
  sentence:
    "This route's own handler may answer 503s this document does not enumerate, as " +
    "`application/json` with an `{error, detail}` body.",
  problem: [],
  json: ["HandlerError"],
};

export const VALIDATION_FAILED_COMPONENT = "ValidationFailed";

/** `validateEntity`'s body: no `detail`, a `fields` list instead. */
const validationFailedSchema: JsonSchema = {
  type: "object",
  description: "The body failed the entity's validation plan; `fields` names each field and why.",
  properties: {
    error: { type: "string", enum: ["validation_failed"] },
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["field", "code", "message"],
      },
    },
  },
  required: ["error", "fields"],
};

/**
 * What an entity route's handler arm answers beyond the 401 and 403, per action — a total map, so a
 * seventh `RouteAction` is a compile error here rather than an action described with no refusals.
 *
 * Derived by reading each arm of `buildSpecHandler` and `writeTxn`, not by guessing:
 *
 * - `conflicts` / `unprocessable` are codes the arm can answer whatever this server wires, so the
 *   status is declared unconditionally where either is non-empty. Some of those codes need more than
 *   the action (`unique_violation` needs a unique field, `reference_not_found` a reference field,
 *   `conflict` the caller's `expectedUpdatedAt`); `CODE_CONDITION` puts that condition in the
 *   sentence rather than claiming every entity can answer them.
 * - `whenStateConditioned` are answered only on an entity whose write is conditional on the state the
 *   handler read (`state_changed`, from `updateIf`/`removeIf`), and `whenReferenced` only on an
 *   entity another entity references (`record_referenced`, which the two Postgres stores raise for a
 *   `restrict` edge). The second is an upper bound: it does not read which edges cascade, and
 *   `--store memory` raises it never.
 * - `checked` says the arm runs the write guards and the write effects (and, for a transition, the
 *   segregation-of-duties check). Those refuse through functions the emitter cannot read — a guard's
 *   own status and code (`lifecycle_state_not_initial`, `invoice_locked`, `period_locked`, the
 *   payment allocation refusals) or an effect's `PostingRefused` — so their 409 and 422 are declared
 *   wherever `checked` holds and the server wires any of them (`OpenApiWriteRefusalDeclaration.checks`).
 *   That too is an upper bound per entity, and the sentence says so: a guard is scoped by entity
 *   inside its own closure, and no declaration of that reach exists to read.
 */
interface ActionHandlerRefusals {
  readonly notFound: boolean;
  readonly conflicts: readonly string[];
  readonly whenStateConditioned: readonly string[];
  readonly whenReferenced: readonly string[];
  readonly unprocessable: readonly string[];
  readonly checked: boolean;
  /** Whether the arm records the write through the write audit, which refuses with a 503. */
  readonly audited: boolean;
}

const NO_REFUSALS = { conflicts: [], whenStateConditioned: [], whenReferenced: [], unprocessable: [] } as const;

export const ACTION_HANDLER_REFUSALS: Readonly<Record<RouteAction, ActionHandlerRefusals>> = {
  list: { ...NO_REFUSALS, notFound: false, checked: false, audited: false },
  read: { ...NO_REFUSALS, notFound: true, checked: false, audited: false },
  create: {
    ...NO_REFUSALS,
    notFound: false,
    conflicts: ["id_conflict", "unique_violation", "server_reference_unresolved"],
    unprocessable: [
      "validation_failed",
      "field_not_declared",
      "field_server_owned",
      "record_id_malformed",
      "reference_not_found",
    ],
    checked: true,
    audited: true,
  },
  update: {
    ...NO_REFUSALS,
    notFound: true,
    conflicts: ["conflict", "unique_violation"],
    whenStateConditioned: ["state_changed"],
    unprocessable: ["validation_failed", "field_not_declared", "field_server_owned", "reference_not_found"],
    checked: true,
    audited: true,
  },
  delete: {
    ...NO_REFUSALS,
    notFound: true,
    whenStateConditioned: ["state_changed"],
    whenReferenced: ["record_referenced"],
    checked: true,
    audited: true,
  },
  transition: {
    ...NO_REFUSALS,
    notFound: true,
    conflicts: ["invalid_transition", "transition_conflict"],
    checked: true,
    audited: true,
  },
};

export const NOT_FOUND_RESPONSE = "NotFound";

const NOT_FOUND_ARM: ResponseArm = {
  key: "",
  sentence: "No record of this entity has this id in the caller's tenant (`not_found`).",
  problem: [],
  json: ["HandlerError"],
};

/**
 * The codes in `conflicts` / `unprocessable` that need more than the action to be reachable, with
 * the condition. They stay in the shared component, so the component is one per action rather than
 * one per entity shape, and the sentence says the condition instead of asserting the code is
 * reachable on every entity: a create of an entity with no unique field cannot answer
 * `unique_violation`, and saying it can was a false sentence on most of the document (ADR-0471's
 * review).
 */
const CODE_CONDITION: Readonly<Record<string, string>> = {
  unique_violation: "on a value the caller supplied for a field the entity declares unique",
  reference_not_found: "when a reference the caller supplied names no record in the tenant",
  server_reference_unresolved:
    "when a reference the server filled (a settings default or an effect's account) names no record",
  conflict: "only when the request carries `expectedUpdatedAt`",
  record_id_malformed: "on a caller-supplied `id`",
};

const codeList = (codes: readonly string[]): string =>
  codes
    .map((c) => (CODE_CONDITION[c] !== undefined ? `\`${c}\` (${CODE_CONDITION[c]})` : `\`${c}\``))
    .join(", ");

const CHECKS_SENTENCE =
  "A write guard or a posting effect wired on this server may also refuse with its own code " +
  "(for example `lifecycle_state_not_initial`, `invoice_locked`, `period_locked`, a payment " +
  "allocation refusal) or `server_reference_unresolved`; which entities a guard covers is decided " +
  "inside the guard, so this is declared on every operation such a check runs on.";

/**
 * The 409 or 422 arm for one action. `extraConflicts` carries the per-entity delete codes, so the
 * component for a delete names only what reaches that delete — `ConflictDelete` plus the segments of
 * the codes present.
 */
const actionRefusalArm = (
  status: "409" | "422",
  action: RouteAction,
  codes: readonly string[],
  checks: boolean,
): ResponseArm => {
  const own =
    codes.length > 0
      ? `The ${action} handler can answer ${codeList(codes)}${status === "409" ? ": the request conflicts with what is stored" : ": the request cannot be applied as sent"}.`
      : "";
  return {
    key: "",
    sentence: [own, checks ? CHECKS_SENTENCE : ""].filter((s) => s !== "").join(" "),
    problem: [],
    json:
      status === "422" && codes.includes("validation_failed")
        ? ["HandlerError", VALIDATION_FAILED_COMPONENT]
        : ["HandlerError"],
  };
};

/**
 * The 400, which is reachable on the `list` action and nowhere else: all four of its producers in
 * `handlers.ts` (`unservedRefused`, `cursorRefused`, `addressingRefused`, `storeRefused`) sit inside
 * `case "list":`, and the association module emits no 400 at all. Declaring it everywhere cost a
 * false sentence on 287 of 338 operations — measured, a read with junk query parameters answers
 * **200**, a delete of a missing id **404**, a failed create **422**.
 */
const LIST_QUERY_REFUSED_RESPONSE: Readonly<Record<string, unknown>> = {
  description:
    "The request names a list surface this deployment does not serve — a filter on a field that " +
    "is not filterable, an operator outside the eight, a search on an entity with no searchable " +
    "field, a cursor not issued for this request, or a sort/filter naming a classified field " +
    "while rows are being withheld.",
  content: { "application/json": { schema: ref("HandlerError") } },
};

/** The response body shape each action produces, so a page is not described as a record. */
const listResponseSchema = (entityRef: string): JsonSchema => ({
  type: "object",
  properties: {
    data: { type: "array", items: ref(entityRef) },
    page: {
      type: "object",
      description:
        "Terminate the walk on `nextCursor === null` and nothing else: a page may be short or " +
        "even empty while the cursor is non-null, because rows a record-level policy withholds are " +
        "dropped after the store's slice (ADR-0345).",
      // `limit` is the page size that was applied, which the real response carries and this
      // declaration omitted — measured, a list answers `page: {"limit":100,"nextCursor":null}`.
      // Both keys are always present and so is `page` itself, which is why all three are required:
      // a client branching on `page === undefined` would be writing a branch the server never takes.
      properties: {
        limit: { type: "integer" },
        nextCursor: { type: ["string", "null"] },
        searchNarrowedBy: {
          type: "array",
          items: { type: "string" },
          description:
            "Present only when a `q` search ran without some of the entity's searchable fields, " +
            "because this deployment stores them as ciphertext. Every row returned is a genuine " +
            "match; a match in a field named here was not looked for, so an empty page does not " +
            "mean nothing matches.",
        },
      },
      required: ["limit", "nextCursor"],
    },
  },
  required: ["data", "page"],
});

/**
 * Builds an OpenAPI 3.1 document for the surface a route registry holds.
 *
 * The input is the **registry's own list**, not `CompiledOperateServer.routeSpecs`: the register's
 * P1.17 names the latter and it is a strict subset. `routeSpecs` is derived from the manifest and
 * so does not grow with a flag, which is what makes the gap widen with configuration — 334 against
 * the registry's **338** on a bare `erp-core` compile, and 334 against the shipped compose's
 * **375**. (Both denominators are correct and they are two different deployments; a reader comparing
 * them without the configuration attached would think one of them wrong.) `routeSpecs` is still
 * taken, for the two things only it carries — which entity a route is about, and its `ListConfig`.
 *
 * It **refuses** rather than reports when a *served* route cannot be rendered, and that split is
 * the design's one load-bearing asymmetry. A declared structural absence (nobody can express which
 * role may call a route) is a named gap a reader can act on; a route silently missing from `paths`
 * is a document that describes a different API, which is the falsely-complete direction (ADR-0337).
 * All three refusals are measured empty today — zero wildcard routes, zero collisions and zero
 * CONNECT routes across all seven packs at both flag sets — so refusing breaks nothing that worked
 * (ADR-0338's rule).
 *
 * `method_not_describable` is the third, and it exists because this function **had that defect
 * while arguing against it**: a CONNECT route was dropped with a bare `continue`, so the document
 * answered `refused: null` over 341 routes and emitted 340 operations, with the path and the
 * operationId nowhere in it and no coverage gap — verified, through a schema-valid route the real
 * registry accepted. The asymmetry was the finding rather than the drop: `wildcard_path` has the
 * same reach, the same zero population and the same one construction site, and was refused, while
 * this was not. A CONNECT route is a *shape* refusal for the same reason — the Path Item Object has
 * no field for the method, so there is no honest way to describe it — which is why
 * `OPENAPI_PATH_ITEM_FIELD` answering `null` is the whole test and no method is named here.
 */
export const buildOpenApiDocument = (input: OpenApiEmitInput): OpenApiEmit => {
  const collisions = pathTemplateCollisions(input.routes);
  if (collisions.length > 0) {
    const first = collisions[0]!;
    return {
      document: null,
      refused: {
        kind: "path_collision",
        detail:
          `${first.method} ${first.template} is served by ${String(first.operationIds.length)} ` +
          `routes, which one Paths Object cannot hold — OpenAPI treats templated paths differing ` +
          `only in a variable's name as the same path. The matcher separates them by registration ` +
          `order, so a document would describe one and omit the other.`,
        operationIds: first.operationIds,
      },
    };
  }
  const wildcards = input.routes.filter(
    (r) => renderPathTemplate(r.pathSegments, "openapi").template === null,
  );
  if (wildcards.length > 0) {
    return {
      document: null,
      refused: {
        kind: "wildcard_path",
        detail:
          "A served route carries a wildcard path segment, which OpenAPI 3.1 cannot express: a " +
          "path variable matches one segment and a wildcard matches any number. Describing it as a " +
          "parameter would send generated clients to a path the server does not serve.",
        operationIds: wildcards.map((r) => r.operationId),
      },
    };
  }
  const undescribableMethods = input.routes.filter(
    (r) => OPENAPI_PATH_ITEM_FIELD[r.method] === null,
  );
  if (undescribableMethods.length > 0) {
    return {
      document: null,
      refused: {
        kind: "method_not_describable",
        detail:
          `A served route uses ${undescribableMethods.map((r) => r.method).join(", ")}, which a ` +
          `Path Item Object has no field for, so OpenAPI 3.1 cannot describe the operation at all. ` +
          `Emitting the document without it would answer success while omitting a route this ` +
          `deployment serves.`,
        operationIds: undescribableMethods.map((r) => r.operationId),
      },
    };
  }

  const traits: readonly Trait[] = input.manifest.traits ?? [];
  const entities: readonly Entity[] = input.manifest.entities ?? [];
  const specByOperation = new Map(input.routeSpecs.map((s) => [s.operationId, s]));
  const schemas: Record<string, JsonSchema> = {
    Problem: problemSchema,
    HandlerError: handlerErrorSchema,
    ...(input.residency !== null ? { [RESIDENCY_PROBLEM_COMPONENT]: residencyProblemSchema() } : {}),
  };
  // The refusal bodies only some deployments answer, added after the operations are built and only
  // if one referenced them: a schema no operation can produce would be a dead component.
  const tenantStatusDecl = input.tenantStatus;
  const lazySchemas: Readonly<Record<string, () => JsonSchema>> = {
    [VALIDATION_FAILED_COMPONENT]: () => validationFailedSchema,
    ...(tenantStatusDecl !== null
      ? {
          [TENANT_STATE_PROBLEM_COMPONENT]: () => tenantStateProblemSchema(tenantStatusDecl),
          [TENANT_STATUS_UNAVAILABLE_PROBLEM_COMPONENT]: () =>
            tenantStatusUnavailableProblemSchema(tenantStatusDecl),
        }
      : {}),
  };
  const undescribableFields: { entity: string; field: string; reason: string }[] = [];

  // Every response component the document carries is registered here by the operation that
  // references it, so a component no operation uses is never emitted.
  const responseComponents: Record<string, Readonly<Record<string, unknown>>> = {};
  const armSchemas = new Set<string>();
  const useResponse = (name: string, arms: readonly ResponseArm[]): Readonly<Record<string, unknown>> => {
    if (responseComponents[name] === undefined) {
      responseComponents[name] = composeResponse(arms);
      for (const arm of arms) for (const schema of [...arm.problem, ...arm.json]) armSchemas.add(schema);
    }
    return responseRef(name);
  };
  if (input.residency !== null) {
    responseComponents[RESIDENCY_MISDIRECTED_RESPONSE] = residencyMisdirectedResponse(input.residency);
  }
  // The entities another entity references, which are the ones whose delete a store can refuse
  // `record_referenced`. Over the resolved fields, so a trait's reference counts (ADR-0361).
  const referencedEntities = new Set<string>();
  for (const entity of entities) {
    for (const f of resolvedFields(entity, traits)) {
      if (f.type.kind === "reference") referencedEntities.add(f.type.target);
    }
  }

  for (const entity of entities) {
    const surface = input.writeSurfaces.get(entity.name);
    if (surface === undefined) {
      return {
        document: null,
        refused: {
          kind: "write_surface_absent",
          detail: `no write surface was supplied for entity '${entity.name}', so its request schemas cannot say which fields the server owns`,
          operationIds: [],
        },
      };
    }
    const built = entitySchemas(entity, traits, entityLifecycleShape(input.manifest, entity.name), surface);
    const base = entityCamel(entity.name);
    const name = `${base.charAt(0).toUpperCase()}${base.slice(1)}`;
    schemas[name] = built.response;
    schemas[`${name}Create`] = built.create;
    schemas[`${name}Update`] = built.update;
    for (const u of built.undescribable) {
      undescribableFields.push({ entity: entity.name, field: u.field, reason: u.reason });
    }
  }

  const paths: Record<string, Record<string, unknown>> = {};
  const missingSuccessResponse: string[] = [];
  for (const route of input.routes) {
    const rendered = renderPathTemplate(route.pathSegments, "openapi");
    const template = rendered.template;
    if (template === null) continue; // unreachable: refused above.
    const field = OPENAPI_PATH_ITEM_FIELD[route.method];
    if (field === null) continue; // unreachable: refused above as `method_not_describable`.

    const spec = specByOperation.get(route.operationId);
    const entityName =
      spec === undefined ? null : `${entityCamel(spec.entity).charAt(0).toUpperCase()}${entityCamel(spec.entity).slice(1)}`;

    // A path parameter is `required: true` by the specification — OpenAPI permits no other value —
    // and carries the matcher's own pattern where the segment declares one, anchored, so a
    // generated client refuses a value the router would not have matched. `pattern: null` is not a
    // laxer claim than the server makes: the segment then matches any single non-empty segment.
    const pathParams = route.pathSegments.flatMap((segment) => {
      if (segment.kind !== "parameter") return [];
      const pattern = pathParameterSchemaPattern(segment);
      return [
        {
          name: segment.name,
          in: "path" as const,
          required: true,
          schema: pattern === null ? { type: "string" } : { type: "string", pattern },
        },
      ];
    });

    const queryParams =
      spec?.action === "list" && spec.listConfig !== undefined
        ? listQueryParameters(spec.listConfig)
        : [];

    const isList = spec?.action === "list";
    const responses: Record<string, unknown> = {
      "401": useResponse(UNAUTHENTICATED_RESPONSE, [UNAUTHENTICATED_ARM]),
    };
    const tenantStatus =
      input.tenantStatus !== null && input.tenantStatus.gatedOperationIds.has(route.operationId)
        ? input.tenantStatus
        : null;
    const forbiddenArms: ResponseArm[] = [
      ROLE_REFUSAL_ARM,
      ...(input.residency !== null ? [RESIDENCY_FORBIDDEN_ARM] : []),
      ...(tenantStatus !== null ? [tenantStateForbiddenArm(tenantStatus)] : []),
    ];
    responses["403"] = useResponse(`${FORBIDDEN_RESPONSE}${forbiddenArms.map((a) => a.key).join("")}`, forbiddenArms);
    if (isList) responses["400"] = LIST_QUERY_REFUSED_RESPONSE;

    if (spec !== undefined) {
      const refusals = ACTION_HANDLER_REFUSALS[spec.action];
      const action = `${spec.action.charAt(0).toUpperCase()}${spec.action.slice(1)}`;
      if (refusals.notFound) responses["404"] = useResponse(NOT_FOUND_RESPONSE, [NOT_FOUND_ARM]);
      const stateConditioned =
        refusals.whenStateConditioned.length > 0 &&
        input.writeRefusals.stateConditionedEntities.has(spec.entity);
      const referenced = refusals.whenReferenced.length > 0 && referencedEntities.has(spec.entity);
      const conflicts = [
        ...refusals.conflicts,
        ...(stateConditioned ? refusals.whenStateConditioned : []),
        ...(referenced ? refusals.whenReferenced : []),
      ];
      const checks = refusals.checked && input.writeRefusals.checks;
      if (conflicts.length > 0 || checks) {
        responses["409"] = useResponse(
          `Conflict${action}${stateConditioned ? "StateConditioned" : ""}${referenced ? "Referenced" : ""}`,
          [actionRefusalArm("409", spec.action, conflicts, checks)],
        );
      }
      if (refusals.unprocessable.length > 0 || checks) {
        responses["422"] = useResponse(`Unprocessable${action}`, [
          actionRefusalArm("422", spec.action, refusals.unprocessable, checks),
        ]);
      }
    }

    if (input.residency !== null) responses["421"] = responseRef(RESIDENCY_MISDIRECTED_RESPONSE);
    const audited =
      input.writeAudit !== null &&
      ((spec !== undefined && ACTION_HANDLER_REFUSALS[spec.action].audited) ||
        input.writeAudit.associationWriteOperationIds.has(route.operationId));
    const unavailableArms: ResponseArm[] = [
      ...(input.residency !== null && input.residency.gatedOperationIds.has(route.operationId)
        ? [RESIDENCY_UNAVAILABLE_ARM]
        : []),
      ...(tenantStatus !== null ? [tenantStatusUnavailableArm(tenantStatus)] : []),
      ...(audited ? [WRITE_AUDIT_UNAVAILABLE_ARM] : []),
    ];
    if (unavailableArms.length > 0) {
      // A declared 503 always admits the gateway's own, and on a route that is not the entity
      // handler (and not an association write, whose one 503 is the audit's) that route's own too.
      const isAssociationWrite = input.writeAudit?.associationWriteOperationIds.has(route.operationId) === true;
      if (spec === undefined && !isAssociationWrite && !unavailableArms.includes(RESIDENCY_UNAVAILABLE_ARM)) {
        unavailableArms.push(ROUTE_OWN_UNAVAILABLE_ARM);
      }
      unavailableArms.push(GATEWAY_UNAVAILABLE_ARM);
      responses["503"] = useResponse(`Unavailable${unavailableArms.map((a) => a.key).join("")}`, unavailableArms);
    }

    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      ...(pathParams.length + queryParams.length > 0
        ? { parameters: [...pathParams, ...queryParams] }
        : {}),
      responses,
    };

    if (route.operationId === OPENAPI_OPERATION_ID) {
      // The one route with no `RouteSpec` whose response this module owns and can therefore
      // describe. Worth doing rather than leaving to the generic gap below, because it is the
      // sharpest member: the document could not describe its own success response, which also hid
      // its non-default media type — a generated client had no way to learn it from the document.
      responses["200"] = {
        description: "This document.",
        content: { [OPENAPI_MEDIA_TYPE]: { schema: { type: "object" } } },
      };
    } else if (spec === undefined || entityName === null) {
      missingSuccessResponse.push(`${route.method} ${template}`);
    }

    if (spec !== undefined && entityName !== null) {
      if (spec.action === "list") {
        responses["200"] = {
          description: `A page of ${spec.entity} records.`,
          content: { "application/json": { schema: listResponseSchema(entityName) } },
        };
        operation["description"] = LIST_PARAMETER_COMPLEMENT_NOTE;
      } else if (spec.action === "create") {
        operation["requestBody"] = {
          required: true,
          content: { "application/json": { schema: ref(`${entityName}Create`) } },
        };
        responses["201"] = {
          description: `The created ${spec.entity}.`,
          content: { "application/json": { schema: ref(entityName) } },
        };
      } else if (spec.action === "update") {
        operation["requestBody"] = {
          required: true,
          content: { "application/json": { schema: ref(`${entityName}Update`) } },
        };
        responses["200"] = {
          description: `The updated ${spec.entity}.`,
          content: { "application/json": { schema: ref(entityName) } },
        };
      } else if (spec.action === "delete") {
        responses["204"] = { description: `The ${spec.entity} was deleted.` };
      } else if (spec.action === "transition") {
        // A transition takes NO body and silently discards one, measured: `invoke` with
        // `{state:"HACKED"}` answered 200 with the state the workflow declares. So the document
        // emits no `requestBody` — describing one would invite a payload the server throws away.
        responses["200"] = {
          description: `The ${spec.entity} after the \`${spec.transition?.name ?? "transition"}\` transition.`,
          content: { "application/json": { schema: ref(entityName) } },
        };
      } else {
        responses["200"] = {
          description: `A ${spec.entity} record.`,
          content: { "application/json": { schema: ref(entityName) } },
        };
      }
    }

    paths[template] ??= {};
    paths[template][field] = operation;
  }

  for (const name of armSchemas) {
    const build = lazySchemas[name];
    if (build !== undefined && schemas[name] === undefined) schemas[name] = build();
  }

  const coverage: OpenApiCoverageGap[] = [
    {
      kind: "undeclared_authorization",
      reach: "ordering",
      detail:
        "Which role may call an operation is not described. `RouteDefinition` carries no role or " +
        "permission field and `requiredScopes` is `[]` on every route in this workspace, so the " +
        "registry sees none of it; authorization lives in the manifest's `permissions` and is read " +
        "by `rbacCheck` inside each handler. The facts exist and this emitter is not given them.",
    },
    {
      kind: "undeclared_parameters",
      reach: "ordering",
      detail:
        "Only the entity-list operations declare query parameters, because only their route specs " +
        "carry a `ListConfig`. An operation with no `parameters` key is NOT a claim that it takes " +
        "none — the association and platform routes have their own readers this emitter cannot see.",
    },
    {
      kind: "surface_outside_registry",
      reach: "ordering",
      detail:
        "A deployment may serve paths this document cannot reach. Health probes, a login route and " +
        "webhook receivers are mounted as interceptors *ahead* of route matching, so they are in " +
        "no route registry and `paths` is silent about them. `paths` is therefore a complete " +
        "account of the routed surface and a lower bound on the served one.",
    },
    // Reported rather than refused, and the direction is why: a route described with only its
    // denials is falsely-INcomplete — a generated client gets no success type for it and the
    // document says the route can only fail — where a route missing from `paths` entirely is
    // falsely-complete. The first costs a capability, the second describes a different API. What
    // makes it a gap rather than a silence is that the set is *named*: these are the registry routes
    // with no `RouteSpec`, so this emitter has no entity to derive a body schema from.
    ...(missingSuccessResponse.length > 0
      ? [
          {
            kind: "undeclared_success_response" as const,
            reach: "ordering" as const,
            detail:
              `${String(missingSuccessResponse.length)} operation(s) declare only their denials, ` +
              `because the route carries no \`RouteSpec\` and so names no entity whose schema a ` +
              `success body could reference: ${missingSuccessResponse.join(", ")}. Each returns a ` +
              `real body; the shapes are not derivable from the manifest, so the facts exist one ` +
              `level up and this emitter is not given them.`,
          },
        ]
      : []),
    ...input.coverage,
  ];

  const security = securityFromServedSchemes();
  const document: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: input.title,
      version: input.version,
      description:
        "Derived from this deployment's own route registry and manifest. `info.version` is the " +
        "manifest hash, so it moves exactly when the described contract does.",
    },
    components: {
      schemas,
      responses: responseComponents,
      securitySchemes: security.schemes,
    },
    // Every gateway route needs a credential — measured, an anonymous request is 401 — and either
    // scheme satisfies it. What is NOT expressible is which ROLE, which `undeclared_authorization`
    // names: a `security` requirement carries scopes, and `requiredScopes` is empty on every route.
    security: security.requirement,
    paths,
    "x-crossengin-coverage": coverage,
    ...(undescribableFields.length > 0 ? { "x-crossengin-undescribable-fields": undescribableFields } : {}),
  };
  return { document, refused: null };
};
