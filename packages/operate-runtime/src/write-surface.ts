import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";

/**
 * What a client may name in a create or update body, per entity.
 *
 * Before this, the create handler built `{created_at, ...body, updated_at}` and the update handler
 * `{...raw, updated_at}`, and `validateBody` walked the entity's *rules* rather than the body's
 * *keys*. So a client could set the record id on a PATCH, back-date `created_at`, put a `tenant_id`
 * key in the stored document, write an FX booking rate a write effect owns, and store any key the
 * manifest never declared — kept and served back by the JSONB and in-memory stores, silently
 * dropped by the column store, so one request had two answers.
 *
 * A key is one of three things: a declared field (the entity's **resolved** fields, so a trait's
 * are in), a field the server owns (below), or nothing — and nothing is refused rather than ignored,
 * because ignoring it is the column store's silent drop restated as policy.
 */
export const SERVER_OWNED_REASONS = [
  "record_id",
  "implicit_column",
  "actor_stamp",
  "effect_stamp",
  "sequence_allocated",
] as const;
export type ServerOwnedReason = (typeof SERVER_OWNED_REASONS)[number];

/**
 * Whether a client may supply each class of server-owned field, per operation — a total map so a
 * sixth class is a compile error rather than a field that inherits whichever answer an `if` gave it.
 *
 * Two classes are admitted on create and every class is refused on update:
 *
 * - `record_id` on create is how an onboarding import keeps the ids its source system already
 *   handed out (ADR-0417 documents it). An id that already exists is a 409, not an overwrite.
 * - `sequence_allocated` on create is `applySequenceDefaults`' documented import path — "a
 *   caller-supplied value is always preserved". Refusing it would break an import that keeps
 *   legacy document numbers, which works today (ADR-0338's rule). Its hazard, a number the
 *   allocator later issues again, is the unique-index question and not this one.
 *
 * Every other class is refused on create because the server writes it on that same request — the
 * timestamps and the actor from the request itself, a booking rate or a withholding total from the
 * document's own recognition edge, which skips a value that is already present. A client value
 * there is not a default the server fills around; it is a value the server would otherwise have
 * computed, replaced. And on update nothing is admitted: renumbering an issued document breaks every
 * entry whose number derives from it, and re-dating or re-attributing a record is the defect.
 */
export const SERVER_OWNED_ADMITTED: Readonly<
  Record<ServerOwnedReason, { readonly create: boolean; readonly update: boolean }>
> = {
  record_id: { create: true, update: false },
  implicit_column: { create: false, update: false },
  actor_stamp: { create: false, update: false },
  effect_stamp: { create: false, update: false },
  sequence_allocated: { create: true, update: false },
};

/** The sentence a refusal carries for each class; it says who writes the field and when. */
export const SERVER_OWNED_REASON_TEXT: Readonly<Record<ServerOwnedReason, string>> = {
  record_id: "the record id is chosen on create and never changed",
  implicit_column: "the server stamps this column on every write",
  actor_stamp: "the server records the authenticated principal here on every write",
  effect_stamp: "a write effect stamps this field when the document reaches the state that posts it",
  sequence_allocated: "the number is allocated on create and an issued number is not changed",
};

/** Columns every entity table has whether or not the manifest names them (`IMPLICIT_COLUMN_CONSEQUENCE`). */
const IMPLICIT_COLUMNS = ["tenant_id", "created_at", "updated_at"] as const;

/** The built-in trait whose two actor fields the handlers stamp, and the fields themselves. */
export const ACTOR_STAMP_TRAIT = "auditable";
export const CREATED_BY_FIELD = "created_by";
export const UPDATED_BY_FIELD = "updated_by";

/**
 * The optimistic-concurrency token an update body may carry beside its fields. Not a field: the
 * update handler strips it before the write surface is asked, so it is one spelling for the handler
 * that reads it and the request schema that has to admit it under `additionalProperties: false`.
 */
export const EXPECTED_UPDATED_AT_KEY = "expectedUpdatedAt";

/** A field a write effect stamps onto the document that triggered it. */
export interface EffectStamp {
  readonly entity: string;
  readonly field: string;
}

export interface WriteSurface {
  readonly entity: string;
  /** The entity's resolved field names — what the served table has, trait fields included. */
  readonly declared: ReadonlySet<string>;
  readonly serverOwned: ReadonlyMap<string, ServerOwnedReason>;
  /** Whether the entity carries `created_by`/`updated_by` from the built-in `auditable` trait. */
  readonly stampsActor: boolean;
}

export function buildWriteSurfaces(
  manifest: Manifest,
  effectStamps: readonly EffectStamp[],
): ReadonlyMap<string, WriteSurface> {
  const out = new Map<string, WriteSurface>();
  const customTraits = manifest.traits ?? [];
  for (const entity of manifest.entities ?? []) {
    const fields = resolvedFields(entity, customTraits);
    const serverOwned = new Map<string, ServerOwnedReason>();
    serverOwned.set("id", "record_id");
    for (const c of IMPLICIT_COLUMNS) serverOwned.set(c, "implicit_column");
    // Keyed on the built-in trait and not on the field name: an entity that declares its own
    // `created_by` has said what it holds, and the server overwriting it would be the same defect
    // pointed the other way.
    const stampsActor = (entity.traits ?? []).includes(ACTOR_STAMP_TRAIT);
    if (stampsActor) {
      serverOwned.set(CREATED_BY_FIELD, "actor_stamp");
      serverOwned.set(UPDATED_BY_FIELD, "actor_stamp");
    }
    for (const f of fields) {
      if (f.default?.kind === "sequence") serverOwned.set(f.name, "sequence_allocated");
    }
    for (const s of effectStamps) {
      if (s.entity === entity.name) serverOwned.set(s.field, "effect_stamp");
    }
    out.set(entity.name, {
      entity: entity.name,
      declared: new Set(fields.map((f) => f.name)),
      serverOwned,
      stampsActor,
    });
  }
  return out;
}

export type WriteSurfaceRefusal =
  | { readonly kind: "not_declared"; readonly field: string }
  | { readonly kind: "server_owned"; readonly field: string; readonly reason: ServerOwnedReason };

/** The first key in `keys` a client may not supply for this operation, else null. */
export function writeSurfaceRefusal(
  surface: WriteSurface,
  keys: readonly string[],
  op: "create" | "update",
): WriteSurfaceRefusal | null {
  for (const field of keys) {
    // Server ownership is asked first: `created_at` is declared on an `auditable` entity, and the
    // answer a client needs is "the server writes it", not "it is not a field".
    const reason = surface.serverOwned.get(field);
    if (reason !== undefined) {
      if (!SERVER_OWNED_ADMITTED[reason][op]) return { kind: "server_owned", field, reason };
      continue;
    }
    if (!surface.declared.has(field)) return { kind: "not_declared", field };
  }
  return null;
}

/**
 * The shape a caller-supplied record id must have. The Postgres stores mint a fresh id for one that
 * does not match it and the in-memory store keeps any string, so an id outside it was either
 * silently replaced or kept depending on the store; it is refused instead. The same pattern as
 * `RECORD_ID_RE` in `operate-runtime-pg`'s `records.ts`, which a test reads as text.
 */
export const CALLER_RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export function callerRecordIdIsWellFormed(value: unknown): boolean {
  return typeof value === "string" && CALLER_RECORD_ID_PATTERN.test(value);
}
