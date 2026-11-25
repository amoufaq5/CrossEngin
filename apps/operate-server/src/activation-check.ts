import { AbacObligationsUnevaluable, checkAbacObligations } from "./abac-obligations.js";
import type { CursorSealingMode } from "./cursor-encryption.js";
import { TenantGatewayCache, type GatewayBuildRefusalKind } from "./tenant-gateway-cache.js";
import { permittedParentSentence, type TenantManifestLineage } from "./tenant-manifest-lineage.js";

/**
 * Whether a proposal this deployment is about to activate can be **served**, asked before the
 * activation is written (ADR-0470).
 *
 * The activate route checked the proposal's status and its review and then wrote `status = 'active'`
 * with a 200, and nothing asked whether the tenant's gateway could be built from it. One that could
 * not — a `meta.extends` naming a parent this deployment does not permit, a cycle, an inherited
 * entity redeclared without `overrides: true`, an ABAC obligation nothing here can discharge — became
 * a **503 on every request** the tenant made afterwards, discovered by its users rather than by the
 * person who activated it (register P2.9's Q5 remainder, and ADR-0397's open question 1). Every one
 * of those refusals is a property of the manifest read against this deployment, so it is knowable at
 * activation, and the answer belongs to the one person who can act on it.
 *
 * **It runs the gateway cache's own sequence by running the gateway cache.** A one-shot
 * `TenantGatewayCache` is handed this one manifest as its source and a `build` that runs the ABAC
 * obligation check `buildOperateHttpServer` runs and then stops. So lineage resolution, the schema
 * parse, `tryValidateManifest` and — the part that matters — the refusal *classification* are the
 * cache's own code rather than a second spelling of them: `refusalKindOf` and its error-name map are
 * module-private there by design ("this is the weak link in the mechanism, which is why it sits in
 * exactly one place"), and copying them here would make it two places. The cost of composing rather
 * than calling a dedicated method is the `build` below, which never returns a server: it records that
 * it was reached and throws, and the cache files that throw as `unknown` — read here as *passed*,
 * because the flag says the checks before it ran clean.
 *
 * What it does **not** cover, and must not claim to: the two refusals a real build can raise from the
 * *store* rather than the manifest. `ColumnEncryptionUnavailable` (ADR-0338) is thrown by
 * `ColumnMappedEntityStore`'s constructor from the column plan, and `TenantSchemaStranded` by the
 * per-tenant schema registry on `--store pg-columns` — both need the provisioning a check must not do.
 * A manifest refused for either still activates and answers 503 afterwards, as before.
 */

/** Why an activation is refused: one of the gateway's own build refusals, or a manifest that does not validate. */
export type ActivationRefusalKind = GatewayBuildRefusalKind | "manifest_invalid";

export interface ActivationRefusal {
  readonly kind: ActivationRefusalKind;
  /** What is wrong and what to do, in one sentence an activating tenant admin can act on. */
  readonly sentence: string;
  /**
   * The specifics, where they are the tenant's own: validation issues, and a lineage refusal's
   * message (which names the parent and the entity in the tenant's manifest). Empty for an ABAC
   * refusal, whose message names this deployment's policy keys — the 503 path's reason for keeping
   * `err.message` out of a response, which a tenant-facing route inherits.
   */
  readonly issues: readonly string[];
}

/** `null` admits the activation. */
export type ActivationCheck = (
  tenantId: string,
  manifest: Record<string, unknown>,
) => Promise<ActivationRefusal | null>;

export interface ActivationCheckOptions {
  /** The same lineage the deployment's `TenantGatewayCache` is built with. */
  readonly lineage: TenantManifestLineage;
  /**
   * The deployment's ABAC policy layer, or `null` when none is declared — `null` rather than an
   * optional field, for `checkAbacObligations`' own reason: an absent declaration reads as *no
   * evaluator*, which refuses every obligation, and that must be what the caller said rather than
   * what it forgot.
   */
  readonly abac: {
    readonly answerableKeys: ReadonlySet<string>;
    readonly recordBearingKeys: ReadonlySet<string>;
  } | null;
  /** The deployment's cursor sealing mode, which the obligation check reads. */
  readonly cursorSealing: CursorSealingMode;
}

const MAX_ISSUES = 10;

/**
 * One sentence per kind — a total map, so a new refusal kind in the cache is a compile error here
 * rather than a refusal with no remedy. Two of the seven cannot arise from this check (see the module
 * comment) and still carry a true sentence, because a total map with a hole is what it exists to
 * prevent.
 */
function sentenceFor(kind: ActivationRefusalKind, permittedParent: string | null): string {
  const sentences: Record<ActivationRefusalKind, string> = {
    lineage_parent_unknown:
      `this manifest extends a parent this deployment does not serve (${permittedParentSentence(permittedParent)}); ` +
      "change meta.extends, then activate again",
    lineage_cycle: "this manifest's meta.extends lineage contains a cycle and cannot be composed",
    lineage_override_undeclared:
      "this manifest redeclares an entity it inherits without overrides: true; rename the entity, or " +
      "mark it overrides: true to replace the inherited one",
    abac_obligation_unevaluable:
      "this manifest declares an ABAC obligation this deployment cannot discharge, so its gateway " +
      "would refuse to start; remove the obligation or ask the operator to declare the policy",
    column_encryption_unavailable:
      "this manifest classifies a field this deployment cannot encrypt at rest",
    tenant_schema_stranded: "this tenant's schema cannot be served by this manifest",
    unknown: "this manifest could not be checked against this deployment; try again",
    manifest_invalid: "this manifest does not validate; fix the issues listed, then activate again",
  };
  return sentences[kind];
}

/** Thrown by the probe `build` once every check before it has passed; never escapes this module. */
class ActivationChecksPassed extends Error {
  constructor() {
    super("activation checks passed");
    this.name = "ActivationChecksPassed";
  }
}

/**
 * Whether a refusal's message is the tenant's own to read. A total map, so a new kind says which it
 * is rather than inheriting an answer from how its name is spelled.
 */
const REFUSAL_DETAIL_IS_TENANTS: Record<ActivationRefusalKind, boolean> = {
  lineage_parent_unknown: true,
  lineage_cycle: true,
  lineage_override_undeclared: true,
  abac_obligation_unevaluable: false,
  column_encryption_unavailable: false,
  tenant_schema_stranded: false,
  unknown: false,
  manifest_invalid: true,
};

interface ProbeObservation {
  invalid: readonly string[] | null;
  refused: { readonly kind: GatewayBuildRefusalKind; readonly detail: string } | null;
  reachedBuild: boolean;
}

export function buildActivationCheck(opts: ActivationCheckOptions): ActivationCheck {
  const answerableKeys = opts.abac?.answerableKeys ?? new Set<string>();
  const recordBearingKeys = opts.abac?.recordBearingKeys ?? new Set<string>();
  const permitted = opts.lineage.permittedParentSlug;
  return async (tenantId, manifest) => {
    // A holder object rather than three `let`s, so what the callbacks record is read back without
    // a cast: TypeScript keeps a closure-assigned `let` narrowed to its initializer.
    const seen: ProbeObservation = { invalid: null, refused: null, reachedBuild: false };
    const probe = new TenantGatewayCache({
      source: { activeManifestFor: async () => manifest },
      lineage: opts.lineage,
      build: (resolved) => {
        // `buildOperateHttpServer`'s own first act, with the same inputs (ADR-0340's placement).
        const obligations = checkAbacObligations({
          manifest: resolved,
          answerableKeys,
          recordBearingKeys,
          cursorSealing: opts.cursorSealing,
        });
        if (obligations.refusal !== null) throw new AbacObligationsUnevaluable(obligations);
        seen.reachedBuild = true;
        throw new ActivationChecksPassed();
      },
      onInvalidManifest: (_tenant, issues) => {
        seen.invalid = issues;
      },
      onBuildRefused: (_tenant, kind, detail) => {
        seen.refused = { kind, detail };
      },
    });
    await probe.serverFor(tenantId);
    if (seen.invalid !== null) {
      return {
        kind: "manifest_invalid",
        sentence: sentenceFor("manifest_invalid", permitted),
        issues: seen.invalid.slice(0, MAX_ISSUES),
      };
    }
    // Reached and passed: the cache filed the probe's own throw as a refusal, which is the price of
    // composing it, and the flag is what says that refusal was ours.
    if (seen.reachedBuild) return null;
    if (seen.refused !== null) {
      const { kind, detail } = seen.refused;
      return {
        kind,
        sentence: sentenceFor(kind, permitted),
        issues: REFUSAL_DETAIL_IS_TENANTS[kind] ? [detail.slice(0, 500)] : [],
      };
    }
    // Neither a refusal nor the probe reached: a resolution this check does not recognise. Refused
    // rather than admitted, since admitting a manifest nothing checked is the defect this exists for.
    return { kind: "unknown", sentence: sentenceFor("unknown", permitted), issues: [] };
  };
}
