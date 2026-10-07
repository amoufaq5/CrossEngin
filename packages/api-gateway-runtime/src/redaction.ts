import {
  computeClassifiedFieldRedaction,
  computeClassifiedFieldRedactionForRecords,
  type AbacEnforcement,
  type ClassifiedField,
  type EntityPermissions,
  type Principal,
  type RoleDefinition,
  type RoleName,
  type SensitiveFieldPolicy,
} from "@crossengin/auth";
import { principalAbacAttributes, type ResolvedPrincipal } from "@crossengin/api-gateway";

export interface PrincipalRoles {
  readonly primaryRole: RoleName;
  readonly secondaryRoles?: readonly RoleName[];
}

export const RESPONSE_RECORD_SHAPES = ["record", "page", "none"] as const;

/**
 * Where the records are in one operation's response body.
 *
 * - `record` — the body **is** one record: `read`, `create`, `update`, a workflow transition.
 * - `page` — `{data: [record, …], page: {…}}`: entity `list`, the association list.
 * - `none` — the body carries no record at all: `delete`'s 204, the association `count`'s
 *   `{count}`.
 *
 * **Declared, never probed.** It is tempting to read the shape off the body — "if it has a `data`
 * array it is a page" — and that is a heuristic in an authorization path, which this repo refuses
 * (ADR-0328: declared beats probed). It is also wrong on real data: a record whose own fields
 * include a `data` array would be read as a page and its field policy answered against whichever
 * element happened to be first, and a page whose `data` key was renamed would be read as one
 * record. The shape is a property of the *operation*, which the caller deriving the routes knows
 * for certain, so it is asked for rather than guessed.
 */
export type ResponseRecordShape = (typeof RESPONSE_RECORD_SHAPES)[number];

export interface ResponseRedactionSpec {
  readonly classifiedFields: readonly ClassifiedField[];
  readonly roles: ReadonlyMap<RoleName, RoleDefinition>;
  readonly rolesForPrincipal: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /**
   * Required, for `operationsForEntity`'s reason (ADR-0338): a default that cannot possibly be
   * right for every operation fails silently in the unsafe direction. Here the unsafe default is
   * `record`, which would answer a per-record policy against the page *wrapper* — an object whose
   * keys are `data` and `page` and which carries none of the fields a policy compares. So the
   * operation that knows its own response shape says so.
   *
   * This is also what ends ADR-0338's "one spec object shared across all of an entity's
   * operations": the shape differs per operation, so the spec does too. Everything else in the
   * spec is still shared by reference.
   */
  readonly recordShape: ResponseRecordShape;
  readonly entityPermissions?: EntityPermissions;
  readonly policy?: SensitiveFieldPolicy;
  /**
   * The entity the spec is about, plus the evaluator that discharges an ABAC
   * obligation on one of its field grants. Absent — or present with no
   * evaluator — leaves an obligated field redacted, which is the same answer:
   * omitting this is a caller with no evaluator, never a caller opting out of
   * the obligation.
   */
  readonly abac?: AbacEnforcement;
}

export interface RedactionRegistry {
  specFor(operationId: string): ResponseRedactionSpec | null;
}

export class MapRedactionRegistry implements RedactionRegistry {
  private readonly specs: Map<string, ResponseRedactionSpec> = new Map();

  register(operationId: string, spec: ResponseRedactionSpec): this {
    this.specs.set(operationId, spec);
    return this;
  }

  specFor(operationId: string): ResponseRedactionSpec | null {
    return this.specs.get(operationId) ?? null;
  }
}

const UNPRIVILEGED_ROLE = "__unprivileged__";

export interface ResponseRedaction {
  readonly redacted: readonly string[];
  /**
   * The subset of `redacted` whose role check passed and whose obligation answered `deferred` —
   * the policy needs the record and none was supplied. A field refused on roles, or answered
   * `denied` or `undischargeable`, is **not** here, because re-asking with a record cannot change
   * any of those.
   *
   * So a non-empty list is the signal that this response carries a record-bearing obligation and
   * is worth a second, per-record pass. That is ADR-0342's `deferred` outcome doing the work it was
   * designed for: the deferral *is* the declaration, rather than a second list somewhere naming
   * which fields are record-bearing and drifting from the grants it describes.
   */
  readonly deferred: readonly string[];
}

interface RedactionInputs {
  readonly authPrincipal: Principal;
  readonly safeRoles: ReadonlyMap<RoleName, RoleDefinition>;
  readonly enforcement: AbacEnforcement | undefined;
}

/**
 * Everything both forms need before a single field is decided, built once.
 *
 * Fail-closed: a role the spec's `roles` map doesn't know (anonymous, a stale token role, a typo)
 * is mapped to an unprivileged sentinel rather than throwing, so an unrecognized principal sees the
 * most-redacted view.
 *
 * One builder for the singular and plural forms, so the two cannot come to answer for different
 * principals or different role closures over one spec — the shape ADR-0329 put `privilegedForClass`
 * behind one definition for and ADR-0339 found had diverged anyway.
 */
function redactionInputs(
  spec: ResponseRedactionSpec,
  principal: ResolvedPrincipal | null,
): RedactionInputs {
  const { primaryRole, secondaryRoles } = spec.rolesForPrincipal(principal);
  const requested = [primaryRole, ...(secondaryRoles ?? [])];
  const safeRoles = new Map(spec.roles);
  if (!safeRoles.has(UNPRIVILEGED_ROLE)) {
    safeRoles.set(UNPRIVILEGED_ROLE, { name: UNPRIVILEGED_ROLE });
  }
  const mapped = requested.map((r) => (spec.roles.has(r) ? r : UNPRIVILEGED_ROLE));
  const authPrincipal: Principal = {
    kind: "user",
    tenantId: (principal?.tenantId ?? "") as Principal["tenantId"],
    userId: (principal?.principalId ?? null) as Principal["userId"],
    primaryRole: mapped[0] ?? UNPRIVILEGED_ROLE,
    secondaryRoles: mapped.slice(1),
    // Resolved in the auth stage. `null` means no directory was consulted, which keeps an obligated
    // field redacted rather than letting a policy be answered from attributes nobody gathered.
    abacAttributes: principalAbacAttributes(principal),
    mfaProofAgeSeconds: principal?.mfaProofAgeSeconds ?? null,
  };
  return {
    authPrincipal,
    safeRoles,
    enforcement: spec.abac === undefined ? undefined : { ...spec.abac },
  };
}

function withoutRecord(enforcement: AbacEnforcement): Omit<AbacEnforcement, "record"> {
  const { record: _record, ...rest } = enforcement;
  return rest;
}

/**
 * `record` absent is a caller that **had none** — spread conditionally into the `AbacEnforcement`,
 * never passed as `{}`, which would assert an empty record and let a policy be answered against
 * fields nobody loaded (ADR-0331's distinction, one level in).
 */
export function computeResponseRedaction(
  spec: ResponseRedactionSpec,
  principal: ResolvedPrincipal | null,
  record?: Readonly<Record<string, unknown>>,
): ResponseRedaction {
  const { authPrincipal, safeRoles, enforcement } = redactionInputs(spec, principal);
  const result = computeClassifiedFieldRedaction(
    authPrincipal,
    spec.entityPermissions ?? {},
    safeRoles,
    spec.classifiedFields,
    spec.policy,
    enforcement === undefined
      ? undefined
      : { ...enforcement, ...(record !== undefined ? { record } : {}) },
  );
  return { redacted: result.redacted, deferred: result.deferred };
}

/**
 * The per-record pass as **one** evaluation, positionally aligned with `records`.
 *
 * What this replaces is N calls to {@link computeResponseRedaction}, which is what the two-pass did
 * when it landed: a page of N records asked the deployment's evaluator N × F times, one obligated
 * field at a time, so an evaluator that crosses a process boundary paid a round trip per cell. One
 * `computeClassifiedFieldRedactionForRecords` call pools every (record, field) request into a single
 * `dischargeAbacBatch`, which a deployment answers in one go if it supplied a batch evaluator and
 * one at a time if it did not — identical cost in that second case, which is every deployment today.
 *
 * It also removes a cost that was already there and had nothing to do with the evaluator: the
 * principal, the role closure and the `AbacEnforcement` were rebuilt per record, and `spec.roles`
 * was **copied into a fresh `Map`** per record purely to hold the unprivileged sentinel. All three
 * are built once here.
 *
 * The enforcement passed down carries **no** `record` — the records travel in the array, and the
 * plural auth function takes `Omit<AbacEnforcement, "record">` precisely so one call cannot supply
 * the record twice and leave which of the two wins to a spread order.
 */
export function computeResponseRedactionForRecords(
  spec: ResponseRedactionSpec,
  principal: ResolvedPrincipal | null,
  records: readonly (Readonly<Record<string, unknown>> | null)[],
): readonly ResponseRedaction[] {
  const { authPrincipal, safeRoles, enforcement } = redactionInputs(spec, principal);
  const results = computeClassifiedFieldRedactionForRecords(
    authPrincipal,
    spec.entityPermissions ?? {},
    safeRoles,
    spec.classifiedFields,
    spec.policy,
    enforcement === undefined ? undefined : withoutRecord(enforcement),
    records,
  );
  return results.map((result) => ({ redacted: result.redacted, deferred: result.deferred }));
}

/**
 * The record-free field set, which is what every caller outside the two-pass wanted and still
 * wants: `apps/operate-server`'s audit-read routes redact a trail row, not an entity record.
 */
export function computeRedactedFields(
  spec: ResponseRedactionSpec,
  principal: ResolvedPrincipal | null,
): readonly string[] {
  return computeResponseRedaction(spec, principal).redacted;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Removes the named fields wherever they appear in a JSON value (records,
 * arrays, and `{data: [...]}`-style wrappers are all handled by walking the
 * tree). A redacted field is dropped entirely rather than nulled.
 */
export function redactJsonValue(value: unknown, redacted: ReadonlySet<string>): unknown {
  if (redacted.size === 0) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactJsonValue(v, redacted));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (redacted.has(k)) continue;
      out[k] = redactJsonValue(v, redacted);
    }
    return out;
  }
  return value;
}

/**
 * Resolves the field set for one record, or for no record at all.
 *
 * `null` means *there is no record here* — the page wrapper's own keys, a body that is not an
 * object where the shape said one record would be, a non-object element of `data`. Every such
 * position gets the **record-free** set, and that is the whole safety argument of the two-pass:
 * the per-record pass can only ever **relax** the record-free one (a `deferred` becoming
 * `satisfied`), never tighten it, so falling back to the record-free set is falling back to the
 * stricter answer. Fail-closed by construction rather than by remembering to be careful.
 */
export type RedactedFieldsFor = (
  record: Readonly<Record<string, unknown>> | null,
) => ReadonlySet<string>;

type ShapeRedactor = (body: unknown, redactedFor: RedactedFieldsFor) => unknown;

/**
 * A **total map** rather than a `switch` with a `default`, so a fourth response shape is a compile
 * error here instead of a member silently inheriting whichever branch the chain ended on — which,
 * for a `switch` written in the order of this union, would be `none`: the *permissive* branch,
 * since `none` applies the record-free set by the ordinary whole-tree walk and never looks for a
 * record. A new shape inheriting that would redact a response nobody had decided how to read.
 */
const SHAPE_REDACTORS: Readonly<Record<ResponseRecordShape, ShapeRedactor>> = {
  /** No record in the body, so the record-free set applied by the ordinary walk. */
  none: (body, redactedFor) => redactJsonValue(body, redactedFor(null)),

  /**
   * The body is the record, when it is an object at all. A string, an array or `null` where the
   * operation declared one record is a response this stage cannot locate a record in, so it gets
   * the stricter record-free set.
   */
  record: (body, redactedFor) =>
    isPlainObject(body)
      ? redactJsonValue(body, redactedFor(body))
      : redactJsonValue(body, redactedFor(null)),

  /**
   * `{data: [record, …], page: {…}}`. Each plain-object element of `data` is redacted with **its
   * own** set — the point of the whole increment — and everything else is record-free: the
   * wrapper's other keys (`page: {limit, nextCursor}`, a `cursor`) and any element that is not an
   * object. A wrapper that is not an object, or whose `data` is absent or not an array, falls back
   * to the ordinary walk with the record-free set, which is exactly today's behaviour.
   */
  page: (body, redactedFor) => {
    if (!isPlainObject(body) || !Array.isArray(body["data"])) {
      return redactJsonValue(body, redactedFor(null));
    }
    const base = redactedFor(null);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (base.has(k)) continue;
      if (k !== "data") {
        out[k] = redactJsonValue(v, base);
        continue;
      }
      out[k] = (v as readonly unknown[]).map((element) =>
        isPlainObject(element)
          ? redactJsonValue(element, redactedFor(element))
          : redactJsonValue(element, base),
      );
    }
    return out;
  },
};

export function redactRecords(
  shape: ResponseRecordShape,
  body: unknown,
  redactedFor: RedactedFieldsFor,
): unknown {
  return SHAPE_REDACTORS[shape](body, redactedFor);
}

const NO_FIELDS: ReadonlySet<string> = new Set();

/**
 * Every object position {@link redactRecords} will ask about for this shape, in traversal order —
 * the records, so a caller can compute their field sets in one batch before the rebuild needs them.
 *
 * Implemented by **running `redactRecords` itself** with a collecting `RedactedFieldsFor` and
 * throwing the rebuilt body away. That is the whole point rather than an economy: the enumeration
 * and the rebuild are then *the same traversal definition*, so they cannot disagree about which
 * objects are records. Two independent walks over one shape is the shape this repo keeps finding
 * wrong — a second list with no forcing function, which ADR-0288's `needsAuditEmitter` was and was
 * wrong three times; here there is one definition used twice.
 *
 * Cheap enough not to need a second implementation: `redactJsonValue` returns its argument
 * unchanged for an empty set, so the collecting pass allocates only the per-shape wrapper (`page`'s
 * output object and its mapped `data` array) and copies nothing below it.
 *
 * The empty set is also what makes the enumeration a **superset** of the rebuild's record positions
 * rather than merely equal to it, which is the direction that matters: `page` skips a wrapper key
 * the record-free set names, so a field literally called `data` would stop the real rebuild
 * descending into the array at all. Enumerating with no field set descends unconditionally, so
 * every position the rebuild can reach was enumerated — never the other way round.
 */
export function recordsIn(
  shape: ResponseRecordShape,
  body: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  const found: Readonly<Record<string, unknown>>[] = [];
  redactRecords(shape, body, (record) => {
    if (record !== null) found.push(record);
    return NO_FIELDS;
  });
  return found;
}

/** The shapes `redactRecords` can apply — the map's own keys, so the two cannot disagree. */
export function redactableResponseShapes(): readonly ResponseRecordShape[] {
  return Object.keys(SHAPE_REDACTORS) as readonly ResponseRecordShape[];
}
