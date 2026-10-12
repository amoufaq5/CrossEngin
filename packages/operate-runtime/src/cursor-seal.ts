import { aeadOpen, aeadSeal } from "@crossengin/crypto";

import type { ListSort } from "./store.js";

/**
 * The version tag a sealed cursor carries, at a **fixed offset** rather than as something to
 * recognise.
 *
 * A value starting with this is sealed and anything else is a legacy plaintext keyset token. That is
 * a declared format and not a probe, which is ADR-0329's rule — a verifier selects the version from
 * an explicit field and never by inferring it from whether something is attached — and the reason it
 * matters here is that the two formats are not distinguishable by inspection: a plaintext cursor is
 * base64url of JSON and a sealed one is base64url of bytes, so "does it parse as `{k, id}`?" would
 * read a sealed cursor whose random nonce happened to decode into JSON as plaintext. The `s1.`
 * spelling leaves room for an `s2.` with a different envelope, which an `s1.` reader will then refuse
 * rather than misread.
 */
export const SEALED_CURSOR_PREFIX = "s1.";

/**
 * What a cursor is bound to: the request it may be replayed in.
 *
 * Not the principal, deliberately. Two callers in one tenant are served slices of one store
 * ordering — row filtering is post-hoc, at the handler — so A's position *is* a sound position for
 * B, and binding to the principal would refuse a legitimate replay (a shared link, a second
 * credential for one person, a key rotated between pages) while buying no confidentiality: the
 * position it discloses is the same position either caller's own walk would reach.
 */
export interface CursorSealContext {
  readonly tenantId: string;
  readonly entity: string;
  /** The **effective** sort the page was ordered by, which is what the keyset is aligned to. */
  readonly sort: readonly ListSort[];
}

/**
 * Why a sealed cursor could not be opened — **one** reason, and that is a fact about the
 * cryptography rather than a simplification of it.
 *
 * GCM authentication fails identically for a tampered ciphertext, a cursor sealed for another
 * tenant, one sealed for another entity, one sealed under a different sort, and one sealed under a
 * key since rotated: the context is an *input to the authenticator*, not a field that comes back out
 * to be compared. So there is nothing to distinguish, and two reasons would claim a distinction the
 * primitive does not make — a caller told "wrong tenant" would be reading a guess.
 */
export const CURSOR_REFUSALS = ["not_for_this_request"] as const;
export type CursorRefusal = (typeof CURSOR_REFUSALS)[number];

/**
 * What came in: a sealed cursor opened, a legacy plaintext one passed through, or a refusal.
 *
 * `plain` and `opened` are separate members although both carry a usable value, because the caller
 * may want to know which it got — a legacy cursor carries no context binding, so the confinement a
 * sealed one buys does not cover it.
 */
export type OpenedCursor =
  | { readonly kind: "plain"; readonly value: string }
  | { readonly kind: "opened"; readonly value: string }
  | { readonly kind: "refused"; readonly reason: CursorRefusal };

export interface CursorSealer {
  seal(plain: string, ctx: CursorSealContext): string;
  open(raw: string, ctx: CursorSealContext): OpenedCursor;
}

/** Resolves the per-tenant AEAD key. A wrong-length key throws, which is a boot-grade fault. */
export type CursorKeySource = (tenantId: string) => Uint8Array;

/**
 * The context binding, as **canonical JSON of `[tenantId, entity, sortSpec]`**.
 *
 * An array of strings rather than a delimiter-joined string: JSON renders it unambiguously by
 * construction, where a `\n`- or `:`-joined form would rest on an assumption about which characters
 * an entity or field name cannot contain — and if that assumption were ever wrong, two different
 * contexts would produce one AAD and a cursor would open under a request it was not issued for,
 * which is the whole thing this function exists to prevent. There is no object here and so no key
 * order to canonicalise; the ordering that *is* significant is the sort's own, which is preserved.
 */
export function cursorSealAad(ctx: CursorSealContext): Uint8Array {
  const sortSpec = ctx.sort.map((s) => `${s.field}:${s.direction}`);
  return Buffer.from(JSON.stringify([ctx.tenantId, ctx.entity, sortSpec]), "utf8");
}

/**
 * The cursor envelope: seal on the way out, open on the way in.
 *
 * **The keyset cursor is opaque to the client, not to the store**, which is what makes this cheap —
 * the stores go on producing and consuming the plaintext keyset they always did, and nothing below
 * the handler knows this exists.
 *
 * A **legacy plaintext cursor is accepted**, so a rollout does not break the walks already in
 * flight. That is safe for confidentiality on a narrow argument: a client can only ever construct a
 * plaintext cursor whose contents it already knows, so accepting one discloses nothing it did not
 * already hold. The threat closed here is a caller *reading ours* — a position derived from a row
 * the filter withheld — and not a caller *forging one*, which was always possible because the format
 * was public and remains possible for as long as the legacy path is open. The cost is stated rather
 * than hidden: a legacy cursor carries no context binding, so none of the confinement below reaches
 * it.
 */
export function buildCursorSealer(keyFor: CursorKeySource): CursorSealer {
  return {
    seal(plain: string, ctx: CursorSealContext): string {
      const sealed = aeadSeal(keyFor(ctx.tenantId), Buffer.from(plain, "utf8"), cursorSealAad(ctx));
      return SEALED_CURSOR_PREFIX + Buffer.from(sealed).toString("base64url");
    },

    open(raw: string, ctx: CursorSealContext): OpenedCursor {
      if (!raw.startsWith(SEALED_CURSOR_PREFIX)) return { kind: "plain", value: raw };
      const body = Buffer.from(raw.slice(SEALED_CURSOR_PREFIX.length), "base64url");
      const opened = aeadOpen(keyFor(ctx.tenantId), body, cursorSealAad(ctx));
      // **`refused`, never `plain`.** Treating a value that claimed to be sealed and failed to open
      // as a legacy plaintext token would decode it to nothing and silently restart the walk from
      // the beginning — a tampered cursor answering 200 with page one, which reads as the walk
      // working. The tag said what this is; failing to open it is a refusal and not a fall-through.
      if (opened === null) return { kind: "refused", reason: "not_for_this_request" };
      return { kind: "opened", value: Buffer.from(opened).toString("utf8") };
    },
  };
}
