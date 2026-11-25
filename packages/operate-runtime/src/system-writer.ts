import type { IncomingRequest, ResolvedPrincipal } from "@crossengin/api-gateway";
import type { HandlerOutput, HandlerRegistry } from "@crossengin/api-gateway-runtime";

import { drainList, ReadCeilingExceeded } from "./list-drain.js";
import { routeFromSpec, type RouteSpec } from "./operations.js";
import type { EntityRecord, EntityStore, ListFilter, ListSort } from "./store.js";

/**
 * Who a system write is attributed to: the background work that made it, never a person.
 *
 * Carried on the audit event so a write a job made is filed as that job's — `meta.audit_log` has
 * no user to name, and a row whose actor is merely "nobody" cannot be told apart from a bare api-key
 * write, which also names no person.
 */
export type SystemWriteOrigin =
  | {
      readonly kind: "job";
      readonly jobId: string;
      readonly runId: string;
    }
  | {
      /**
       * Platform provisioning of a tenant's starting data — today only the starter chart of accounts
       * an approved access request (or an operator) creates (ADR-0465). A kind of its own rather than
       * a fake job, because the audit row must say an operator's act caused the write and no run of
       * any declared job did.
       */
      readonly kind: "provisioning";
      readonly operation: "starter_chart";
      /** The access request or console act this provisioning ran for, so the audit rows join to it. */
      readonly provisioningId: string;
    }
  | {
      /**
       * An operator-run maintenance pass correcting a server-owned fact the running server would have
       * written had it existed at the time — today only stamping a legacy bill's withholding from its
       * own recognition entry. Its own kind for `provisioning`'s reason: the row must say neither a
       * job nor a tenant-creating act made the write. The field it corrects is server-owned, so the
       * handler a `buildSystemEntityAccess` dispatch goes through refuses it `field_server_owned`
       * like any other caller's: such a write goes through the store directly, and this origin is
       * what its audit row carries. No dispatch runs under it today; the pass names its audit rows'
       * request ids through `systemRequestId`, so they carry the same prefix a dispatch would.
       */
      readonly kind: "maintenance";
      readonly operation: "bill_withholding_backfill";
      /** The invocation this pass ran as, so every row one run wrote joins to the run. */
      readonly runId: string;
    };

/** The token a system write's minted request id carries, so a log line names the run or provisioning. */
function originToken(origin: SystemWriteOrigin): string {
  switch (origin.kind) {
    case "job":
      return origin.runId;
    case "provisioning":
      return origin.provisioningId;
    case "maintenance":
      return origin.runId;
  }
}

const ORIGIN_REQUEST_PREFIX: Readonly<Record<SystemWriteOrigin["kind"], string>> = {
  job: "req_job",
  provisioning: "req_prov",
  maintenance: "req_maint",
};

/**
 * The identity a system writer acts under.
 *
 * `roles` is what authorizes it, and is read through the manifest's own grants exactly as a request's
 * roles are: the writer is not a bypass. A job acting as a role the manifest does not grant a
 * transition to is refused 403 by the same `rbacCheck` that refuses a person — so what a job may do
 * is a fact a reviewer can read off the manifest and the deployment's one role declaration, rather
 * than an exemption buried in the job's code.
 */
export interface SystemActor {
  /** Primary role first. Must be non-empty; an empty list is a principal no grant can name. */
  readonly roles: readonly string[];
  readonly origin: SystemWriteOrigin;
  /**
   * Whether the tenant may be written at all, asked before **every** write this actor makes
   * (ADR-0469). Required, because the alternative is a seam that defaults to *allow* — the defect
   * restated as a default (ADR-0364, ADR-0386). A system write is not a request, so the
   * request-path tenant-status gate (ADR-0334) is the wrong place to depend on: it is opt-in, and a
   * job writing into a `pending_deletion` tenant's data — the data an Article 17 request has
   * verified and queued for destruction — is the defect that gate exists to prevent.
   */
  readonly standing: TenantStandingReader;
}

/**
 * Whether a tenant's data may be written by background work.
 *
 * Three answers and not a boolean, because *the tenant is blocked* and *nobody could say* lead to
 * opposite dispositions: `blocked` is a fact about the tenant that a retry meets again, so it ends the
 * run; `unknown` is a fact about the read, so it is retried. `status` is the lifecycle state the
 * reader found — a vocabulary this package does not own (`@crossengin/tenant-lifecycle` does, and the
 * reader is built from its `blocksWrites`), so it is carried as a string and never interpreted here.
 */
export type TenantStanding =
  | { readonly kind: "writable" }
  | { readonly kind: "blocked"; readonly status: string }
  | { readonly kind: "unknown"; readonly reason: string };

export type TenantStandingReader = (tenantId: string) => Promise<TenantStanding>;

/**
 * The reader for a deployment that holds **no tenant registry** — `--store memory`, where there is
 * no `meta.tenants` to read and so no lifecycle state a tenant could be in. Named for that case and
 * not `alwaysWritable`, because a deployment that does have a registry and passed this would be
 * restating the defect the required field exists to end.
 */
export const NO_TENANT_REGISTRY_STANDING: TenantStandingReader = async () => ({ kind: "writable" });

/**
 * A system write refused because the tenant's lifecycle state blocks writes. **Not retryable**: the
 * state is a fact about the tenant, so the next attempt meets it again, and burning a job's retry
 * ladder on it would only delay the dead letter that says so. The message carries the state name and
 * nothing from any row.
 */
export class TenantNotWritable extends Error {
  readonly retryable = false;
  constructor(
    readonly tenantId: string,
    readonly status: string,
  ) {
    super(`tenant_not_writable:${status}`);
    this.name = "TenantNotWritable";
  }
}

/** A system write not attempted because the tenant's standing could not be read. Retryable. */
export class TenantStandingUnknown extends Error {
  readonly retryable = true;
  constructor(
    readonly tenantId: string,
    readonly reason: string,
  ) {
    super(`tenant_standing_unknown: ${reason}`);
    this.name = "TenantStandingUnknown";
  }
}

/** Throws the typed refusal for a non-writable answer; a reader that throws is `unknown`. */
async function assertTenantWritable(reader: TenantStandingReader, tenantId: string): Promise<void> {
  let standing: TenantStanding;
  try {
    standing = await reader(tenantId);
  } catch (err) {
    standing = { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
  switch (standing.kind) {
    case "writable":
      return;
    case "blocked":
      throw new TenantNotWritable(tenantId, standing.status);
    case "unknown":
      throw new TenantStandingUnknown(tenantId, standing.reason);
  }
}

/**
 * Principals the system writer minted, mapped to what they act for.
 *
 * A module-private side channel and not a field on `ResolvedPrincipal`, because that type is the
 * gateway's and every resolver produces it: a field there could be set by a resolver, and an
 * attribution any request can claim is not an attribution. Only `forTenant` below adds to this map,
 * so a handler finding an entry knows the write came from in-process work and not from the wire.
 */
const SYSTEM_ORIGINS = new WeakMap<ResolvedPrincipal, SystemWriteOrigin>();

/** What a principal acts for, when the system writer minted it; null for every request principal. */
export function systemWriteOriginOf(principal: ResolvedPrincipal | null): SystemWriteOrigin | null {
  return principal === null ? null : (SYSTEM_ORIGINS.get(principal) ?? null);
}

/**
 * One write's answer, shaped from the handler's own output.
 *
 * `refused` keeps the handler's status and error code verbatim, because the caller decides what to
 * do with each — a 409 `state_changed` on a sweep is a record somebody else already moved, a 422 is a
 * record this work cannot write, and a 5xx is worth a retry. Folding them into one failure would make
 * that choice for every caller at once.
 */
export type SystemWriteResult =
  | { readonly kind: "written"; readonly status: number; readonly record: EntityRecord | null }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly error: string;
      readonly detail: string | null;
      readonly operationId: string;
    };

/** A query over one entity, in the store's own vocabulary. */
export interface SystemReadQuery {
  readonly filters?: readonly ListFilter[];
  readonly sort?: readonly ListSort[];
}

/** Everything a background unit of work may do in one tenant, bound to that tenant by construction. */
export interface TenantEntityAccess {
  readonly tenantId: string;
  /**
   * Throws `TenantNotWritable` / `TenantStandingUnknown` unless the actor's standing reader answers
   * `writable`. Every write calls it; a unit of work calls it first too, so a blocked tenant's run is
   * refused before it reads anything rather than after it has computed what it would have written.
   */
  assertWritable(): Promise<void>;
  create(entity: string, body: Readonly<Record<string, unknown>>): Promise<SystemWriteResult>;
  update(entity: string, id: string, patch: Readonly<Record<string, unknown>>): Promise<SystemWriteResult>;
  transition(entity: string, id: string, transition: string): Promise<SystemWriteResult>;
  read(entity: string, id: string): Promise<EntityRecord | null>;
  /**
   * Every row matching the query, or a `ReadCeilingExceeded` when there are more than `ceiling`.
   * Never a prefix: a sweep that acted on the first page and reported success would leave the rest
   * undone with nothing saying so, which is ADR-0367's rule for an effect.
   */
  readAll(
    entity: string,
    query: SystemReadQuery,
    bounds: { readonly ceiling: number; readonly computing: string },
  ): Promise<readonly EntityRecord[]>;
}

export interface SystemEntityAccess {
  forTenant(tenantId: string, actor: SystemActor): TenantEntityAccess;
  /** Whether this compiled server serves the operation at all — an entity action or a transition. */
  serves(entity: string, operation: "create" | "update" | { readonly transition: string }): boolean;
}

export interface SystemEntityAccessInput {
  /**
   * The registry the gateway dispatches from, read **at call time**. Lazily, because the serving
   * binary decorates entries after compile (the tenant-status gate replaces them in place), and a
   * writer that captured the undecorated handler would write for a suspended tenant that every
   * request is refused for.
   */
  readonly handlers: HandlerRegistry;
  readonly routeSpecs: readonly RouteSpec[];
  /** The compiled store — the wire-typed one every handler reads through. */
  readonly store: EntityStore;
  readonly clock?: { now(): Date };
}

const REQUEST_ID_SAFE = /[^A-Za-z0-9]/g;

/**
 * The request id a system write carries: the origin's prefix, its run or provisioning token reduced
 * to the characters a request id admits, and a sequence. The one spelling, so a write that goes
 * through the store directly (the maintenance pass) and one dispatched below read alike in a log.
 */
export function systemRequestId(origin: SystemWriteOrigin, sequence: number): string {
  const token = originToken(origin).replace(REQUEST_ID_SAFE, "").slice(0, 32);
  return `${ORIGIN_REQUEST_PREFIX[origin.kind]}_${token}_${sequence.toString()}`;
}

/**
 * Background work's way into the entity layer, **through the handlers a request is served by**.
 *
 * A job that wrote through the raw store would write behind every guard and every effect: the
 * double-entry balance, the document locks, the lifecycle rule that a state moves only by
 * transition, the GL postings a transition triggers and the audit row. Those live in the handler —
 * `runWriteGuards` and `runWriteEffects` have one caller each — so this dispatches to the very
 * handler the gateway would, with a principal of kind `system` holding the actor's roles. The one
 * gateway stage it does not re-run is authentication, which has no meaning for in-process work;
 * authorization it does run, because that is the handler's first act.
 *
 * Reads go to the compiled store and not through a list handler. A list handler answers only the
 * filters its view declares and pages by an opaque cursor, so a sweep would have to fetch every row
 * to apply its own predicate — and a read changes nothing a guard protects. The tenant is the one
 * this access was bound to, so a read can no more cross it than a write can.
 */
export function buildSystemEntityAccess(input: SystemEntityAccessInput): SystemEntityAccess {
  const find = (
    entity: string,
    operation: "create" | "update" | { readonly transition: string },
  ): RouteSpec | undefined => {
    for (const spec of input.routeSpecs) {
      if (spec.entity !== entity) continue;
      if (typeof operation === "string") {
        if (spec.action === operation) return spec;
      } else if (spec.action === "transition" && spec.transition?.name === operation.transition) {
        return spec;
      }
    }
    return undefined;
  };
  const now = (): Date => input.clock?.now() ?? new Date();
  let sequence = 0;

  return {
    serves: (entity, operation) => find(entity, operation) !== undefined,
    forTenant(tenantId, actor) {
      if (actor.roles.length === 0) {
        throw new Error("a system actor needs at least one role: authorization is the manifest's grants");
      }
      const dispatch = async (
        spec: RouteSpec | undefined,
        label: string,
        params: Readonly<Record<string, string>>,
        body: Readonly<Record<string, unknown>> | null,
      ): Promise<SystemWriteResult> => {
        if (spec === undefined) {
          return {
            kind: "refused",
            status: 404,
            error: "operation_not_served",
            detail: `this deployment serves no ${label}`,
            operationId: label,
          };
        }
        const handler = input.handlers.resolve(spec.operationId);
        if (handler === null) {
          return {
            kind: "refused",
            status: 404,
            error: "operation_not_served",
            detail: `no handler is registered for ${spec.operationId}`,
            operationId: spec.operationId,
          };
        }
        // After the not-served answers and before anything reaches a handler: a blocked tenant is a
        // throw rather than a `refused` result, because a sweep tallies a `refused` and carries on to
        // the next record, and there is no next record worth reaching in a tenant nothing may write.
        await assertTenantWritable(actor.standing, tenantId);
        sequence += 1;
        const at = now().toISOString();
        const route = routeFromSpec(spec);
        const path = `/${route.pathSegments
          .map((s) => (s.kind === "literal" ? s.value : s.kind === "parameter" ? (params[s.name] ?? "") : "*"))
          .join("/")}`;
        // A fresh principal per call, so the origin map holds nothing a later call could reuse and the
        // weak entry dies with the request.
        const principal: ResolvedPrincipal = {
          // The nil UUID: a system actor is no `meta.users` row, and `principalUserId` answers null
          // for kind `system` whatever this holds, so no write can attribute itself to a person.
          principalId: "00000000-0000-0000-0000-000000000000",
          tenantId,
          principalKind: "system",
          // No credential was presented — this principal never crossed the wire — which is exactly
          // what `anonymous` records.
          authScheme: "anonymous",
          grantedScopes: [...actor.roles],
          mfaProofAgeSeconds: null,
          resolvedAt: at,
        };
        SYSTEM_ORIGINS.set(principal, actor.origin);
        const request: IncomingRequest = {
          id: systemRequestId(actor.origin, sequence),
          receivedAt: at,
          method: spec.method,
          path,
          query: {},
          headers: {},
          host: "localhost",
          scheme: "http",
          bodyBytes: 0,
          bodySha256: null,
          clientIp: "127.0.0.1",
          forwardedFor: [],
          forwardedProto: null,
          forwardedHost: null,
          userAgent: null,
          tlsVersion: null,
          tlsCipher: null,
          clientCertSha256: null,
          correlationId: null,
          traceparent: null,
          tenantHint: null,
          edgeRegion: null,
        };
        const output = await handler({
          request,
          route,
          principal,
          params,
          parsedBody: body === null ? null : { ...body },
        });
        return resultOf(output, spec.operationId);
      };
      return {
        tenantId,
        assertWritable: () => assertTenantWritable(actor.standing, tenantId),
        create: (entity, body) => dispatch(find(entity, "create"), `create on ${entity}`, {}, body),
        update: (entity, id, patch) => dispatch(find(entity, "update"), `update on ${entity}`, { id }, patch),
        transition: (entity, id, transition) =>
          dispatch(find(entity, { transition }), `transition '${transition}' on ${entity}`, { id }, null),
        read: (entity, id) => input.store.get(tenantId, entity, id),
        async readAll(entity, query, bounds) {
          const out: EntityRecord[] = [];
          const outcome = await drainList(
            input.store,
            tenantId,
            entity,
            { filters: query.filters ?? [], sort: query.sort ?? [] },
            { ceiling: bounds.ceiling },
            (records) => {
              out.push(...records);
            },
          );
          if (!outcome.complete) throw new ReadCeilingExceeded(entity, bounds.ceiling, bounds.computing);
          return out;
        },
      };
    },
  };
}

function resultOf(output: HandlerOutput, operationId: string): SystemWriteResult {
  if (output.status >= 200 && output.status < 300) {
    const record =
      output.kind === "json" && output.body !== null && typeof output.body === "object" && !Array.isArray(output.body)
        ? (output.body as EntityRecord)
        : null;
    return { kind: "written", status: output.status, record };
  }
  const body = output.kind === "json" && output.body !== null && typeof output.body === "object" ? output.body : {};
  const error = (body as { error?: unknown }).error;
  const detail = (body as { detail?: unknown }).detail;
  return {
    kind: "refused",
    status: output.status,
    error: typeof error === "string" ? error : `http_${output.status.toString()}`,
    detail: typeof detail === "string" ? detail : null,
    operationId,
  };
}
