/**
 * The boot-time decision about **sealing the entity-list keyset cursor**.
 *
 * This module is the deployment half of cursor sealing: where the key comes from, and what a
 * deployment is told — or refused — when it has the problem and no key. It performs no sealing
 * and no encryption. `buildCursorSealer` seals and opens; `@crossengin/crypto` derives the key
 * and holds the AEAD.
 *
 * What it exists to end is the residual of entity-list row filtering. A cursor is
 * `base64url(JSON.stringify({k: [...sort values], id}))` — plainly reversible, not a token — and
 * it is derived from the last row of the **store's** slice, which under row filtering may be a
 * row the caller is never shown. So the cursor discloses a withheld row's sort values and its
 * id, on every page, and at `limit=1` a caller can walk the whole table collecting the ids of
 * rows they were denied. Nothing about the request is wrong, so there is no request-time refusal
 * available and no per-request fix a caller could apply.
 *
 * **Sealing is uniform, not per entity.** When a secret is present every entity-list cursor is
 * sealed, including the cursors of entities with no row filtering at all. Three reasons, and the
 * first is the one that decides it: one format going forward beats a per-entity matrix, because
 * a cursor minted under one regime and presented under another is a value the deployment has to
 * be able to read either way, and a matrix makes that a per-entity question on every request. It
 * costs one AES-GCM operation per page, which is nothing beside the query it accompanies. And it
 * means cursors stop being a readable surface *at all*, rather than only where somebody
 * remembered to close them — the per-entity alternative is a hand-maintained set keyed on which
 * grants happen to carry a record-bearing policy today, which is the shape of list this repo has
 * found wrong four times.
 */

import { deriveTenantCursorKey, parseCursorEncryptionSecret } from "@crossengin/crypto";
import {
  buildCursorSealer,
  type CursorKeySource,
  type CursorSealer,
} from "@crossengin/operate-runtime";

/**
 * The deployment secret every tenant's cursor key is derived from.
 *
 * From the **environment and never from argv**: argv is readable via `ps` (ADR-0301), and
 * `COLUMN_ENCRYPTION_SECRET` is the immediate precedent — one deployment secret from which a
 * per-tenant key is derived, with nothing stored.
 *
 * A **separate** variable from the column secret rather than a second use of it. The two keys
 * protect different things with different lifetimes: a column key must stay derivable for as
 * long as the ciphertext is at rest, so rotating it is a data migration, while a cursor key
 * protects a value whose whole lifetime is one caller's pagination — rotating it invalidates
 * cursors in flight and nothing else. One variable would couple the cheap rotation to the
 * expensive one, in the direction that makes the cheap one unavailable.
 */
export const CURSOR_ENCRYPTION_SECRET_VAR = "CURSOR_ENCRYPTION_SECRET";

/**
 * The opt-out named in the refusal. A constant rather than a string literal per message, so the
 * refusal cannot name a flag the CLI does not parse.
 */
export const ALLOW_CURSOR_DISCLOSURE_FLAG = "--allow-cursor-disclosure";

export const CURSOR_SEALING_MODES = ["sealed", "plaintext_accepted", "absent"] as const;
export type CursorSealingMode = (typeof CURSOR_SEALING_MODES)[number];

/**
 * One line per mode. A **total map** rather than a switch, so a fourth mode is a compile error
 * instead of a mode inheriting whichever branch a chain ended on — and the direction that
 * matters is that an unconsidered mode must not be described as sealed.
 *
 * `absent` names the refusal it can produce, because the mode alone is not a fault: a deployment
 * whose manifest withholds no rows has nothing to disclose, and that is most of them. The
 * refusal is `checkAbacObligations`', which is the only place that knows whether any grant
 * filters rows.
 */
const MODE_DETAIL: Readonly<Record<CursorSealingMode, string>> = {
  sealed:
    `every entity-list cursor is sealed with a per-tenant key derived from ` +
    `${CURSOR_ENCRYPTION_SECRET_VAR}, including for entities whose rows are not filtered`,
  plaintext_accepted:
    `${CURSOR_ENCRYPTION_SECRET_VAR} is not set and ${ALLOW_CURSOR_DISCLOSURE_FLAG} was given, ` +
    `so every entity-list cursor stays reversible base64url JSON and a row withheld from a page ` +
    `can be the one whose sort values and id it carries back`,
  absent:
    `${CURSOR_ENCRYPTION_SECRET_VAR} is not set, so every entity-list cursor is reversible ` +
    `base64url JSON — refused at boot (cursor_discloses_withheld_rows) only if a grant filters ` +
    `rows out of a page, and otherwise nothing is withheld for a cursor to disclose`,
};

/**
 * The per-tenant key source the sealer calls per page.
 *
 * The eager parse and the tenant-keyed cache are `buildColumnKeySource`'s, for exactly its
 * stated reasons: the secret is validated **once, before any closure is returned**, so a weak
 * secret fails at boot naming the measured figures rather than on the first page of a list; and
 * the cache is keyed on the tenant id alone because a generation is fixed for the life of one
 * source, so a rotation is a new source rather than an invalidation.
 *
 * The one thing that is not shared with that function is the consequence of a rotation, and it
 * is the gentler one: a new generation makes every cursor in flight unopenable, which is a
 * caller restarting its pagination. A column key's generations have to coexist because the
 * ciphertext they wrote is at rest.
 */
export function buildCursorKeySource(
  rawSecret: string,
  opts: { readonly generation?: number } = {},
): CursorKeySource {
  const secret = parseCursorEncryptionSecret(rawSecret);
  const generation = opts.generation;
  const cache = new Map<string, Uint8Array>();
  return (tenantId: string): Uint8Array => {
    const hit = cache.get(tenantId);
    if (hit !== undefined) return hit;
    // The derivation is loaded through the same package as the parser, so the two cannot
    // disagree about what an acceptable secret is; its refusal of an empty tenant id is allowed
    // to propagate rather than being turned into one shared key, which would seal every
    // tenant's cursors under a value any of them could open.
    const derived =
      generation === undefined
        ? deriveTenantCursorKey(secret, tenantId)
        : deriveTenantCursorKey(secret, tenantId, generation);
    cache.set(tenantId, derived);
    return derived;
  };
}

export interface CursorSealingResolution {
  readonly mode: CursorSealingMode;
  /** Present iff `mode` is `sealed`; the other two modes are today's plaintext cursor. */
  readonly sealer: CursorSealer | null;
}

/**
 * The three-way resolution: a secret, a knowing acceptance, or neither.
 *
 * **A secret wins over the flag, and the flag must not suppress sealing.** The flag *accepts* a
 * disclosure; it does not request one. A deployment that set a secret and also passed the flag —
 * a compose file carrying both through a migration, most likely — gets sealed cursors, because
 * reading the flag as "do not seal" would make the safe configuration defeatable by the thing an
 * operator passes while arranging it. That is ADR-0338's `PlaintextFallbackRefused` direction:
 * a silent downgrade from sealed to plaintext is the failure, not the upgrade.
 *
 * Presence is `trim().length > 0`, the spelling the column secret's reader already uses, so an
 * environment variable set to the empty string reads as unset rather than reaching the parser as
 * a nought-byte secret. The **untrimmed** string is what the derivation sees, since the bytes an
 * operator supplied are the secret.
 */
export function resolveCursorSealing(input: {
  readonly secret: string | null;
  readonly allowDisclosure: boolean;
}): CursorSealingResolution {
  const secret = input.secret;
  if (secret !== null && secret.trim().length > 0) {
    return { mode: "sealed", sealer: buildCursorSealer(buildCursorKeySource(secret)) };
  }
  return { mode: input.allowDisclosure ? "plaintext_accepted" : "absent", sealer: null };
}

/** The boot line. Carries the mode first, because that is what an operator greps for. */
export function formatCursorSealing(mode: CursorSealingMode): string {
  return `cursor sealing: ${mode} — ${MODE_DETAIL[mode]}`;
}
