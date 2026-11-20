import { z } from "zod";

/**
 * The only shape a tenant identifier may take on a provider's wire (ADR-0456): a fixed prefix and
 * 128 bits of keyed-derivation output in lowercase hex. The derivation lives in
 * `@crossengin/crypto` (`deriveAiTenantPseudonym`); this package states what it will *send*, and
 * an agreement test in the one package that depends on both pins that the two agree.
 *
 * What the pattern proves is narrower than it looks, and the difference is stated so nobody leans
 * on it: it refuses any value not of the `ctp_<32 hex>` shape — a hyphenated tenant id, a bare
 * digest, the wrong length or case — and it **cannot tell a keyed value from an unkeyed one of the
 * same shape**. A UUID with its hyphens removed is exactly 32 lowercase hex characters, so
 * `"ctp_" + tenantId.replaceAll("-", "")` and `"ctp_" + sha256(tenantId).slice(0, 32)` both match.
 * The first of those is the one case a request can also check, because the request carries
 * `tenantId`, so `tenantPseudonymForWire` refuses it; the second is indistinguishable from the real
 * thing without the key. The guarantee that the value is keyed is that its only producer is
 * `deriveAiTenantPseudonym` in `@crossengin/crypto`, reached through the server's
 * `tenantPseudonymForOf` — not this pattern.
 *
 * 36 characters of `[a-z0-9_]` sit inside every limit this repo sends it under: Anthropic's
 * `metadata.user_id` (256) and the OpenAI-compatible `user`, and the 64-character
 * `safety_identifier` OpenAI documents as that field's replacement.
 */
export const TENANT_PSEUDONYM_PATTERN = /^ctp_[0-9a-f]{32}$/;

export const TenantPseudonymSchema = z.string().regex(TENANT_PSEUDONYM_PATTERN);
export type TenantPseudonym = z.infer<typeof TenantPseudonymSchema>;

export function isTenantPseudonym(value: unknown): value is TenantPseudonym {
  return typeof value === "string" && TENANT_PSEUDONYM_PATTERN.test(value);
}

/** Raised by a request builder handed a pseudonym that is not one. Never carries the value. */
export class MalformedTenantPseudonym extends Error {
  constructor() {
    super(
      "refusing to send a provider request: tenantPseudonym does not match ctp_<32 hex>, so it " +
        "may be a raw or unkeyed tenant identifier",
    );
    this.name = "MalformedTenantPseudonym";
  }
}

/**
 * What a request builder puts on the wire for the request's pseudonym: `undefined` when the
 * deployment configured none (the field is then omitted, never filled with something else), the
 * value when it is well formed, and a **throw** otherwise.
 *
 * Throwing rather than dropping the field is the fail-closed direction twice over. A malformed
 * value is a caller bug that may be carrying the tenant id, so it must not be sent; and silently
 * omitting it would make a deployment that believes it attributes abuse per tenant attribute none.
 * The message deliberately does not quote the value, since the value is the thing that may be
 * sensitive.
 */
export function tenantPseudonymForWire(req: {
  readonly tenantId: string;
  readonly tenantPseudonym?: string | undefined;
}): TenantPseudonym | undefined {
  const value = req.tenantPseudonym;
  if (value === undefined) return undefined;
  if (!isTenantPseudonym(value)) throw new MalformedTenantPseudonym();
  if (carriesTenantId(value, req.tenantId)) throw new MalformedTenantPseudonym();
  return value;
}

/**
 * Whether a well-formed pseudonym's hex is the request's own tenant id with its hyphens removed —
 * the one raw-id spelling the pattern admits (a UUID is 32 hex digits). `tenantId` is required on
 * the parameter rather than optional so a call site cannot skip this check by not passing it.
 */
function carriesTenantId(value: TenantPseudonym, tenantId: string): boolean {
  const stripped = tenantId.replaceAll("-", "").toLowerCase();
  return stripped.length > 0 && value.slice(4).includes(stripped);
}
