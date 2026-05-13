# @crossengin/compliance

Compliance pack architecture per **ADR-0012**. A pack is a versioned
bundle that contributes entities, traits, roles, permissions, and
workflows to a tenant's manifest at apply time.

## V1 scope

- `CompliancePack` zod schema + types
- `CompliancePackParameter` discriminated union: `string` /
  `long-text` / `integer` / `boolean` / `enum` / `localized-string`
- `resolveCompliancePacks(manifest, { registry })` — additive
  merge after `resolveManifest` (extends), before
  `validateManifest`
- Parameter validation (type, enum membership, integer min/max,
  required check)
- Collision detection: a pack contribution that conflicts with the
  tenant manifest (by entity name, trait name, role key, permission
  entity, workflow key) or with another pack throws
  `CollisionError`
- One worked showcase pack: `21-cfr-part-11`

## API

```ts
import { resolveManifest, validateManifest, applyManifest } from "@crossengin/kernel/manifest";
import { resolveCompliancePacks } from "@crossengin/compliance";
import { pack as part11Pack } from "@crossengin/compliance/packs/21-cfr-part-11";

const registry = {
  async getPack(id: string) {
    if (id === "21-cfr-part-11") return part11Pack;
    return null;
  },
};

// 1. resolve extends inheritance
const r1 = await resolveManifest(manifest, { registry: manifestRegistry });

// 2. resolve compliance packs (merges pack contributions into manifest)
const r2 = await resolveCompliancePacks(r1, { registry });

// 3. validate the fully-resolved manifest
validateManifest(r2);

// 4. emit DDL
const sql = applyManifest(oldManifest, r2, { schema: "t_acme" });
```

## Manifest meta extensions

```jsonc
"meta": {
  "compliancePacks": ["21-cfr-part-11", "eu-gmp"],
  "compliancePackParameters": {
    "21-cfr-part-11": {
      "signatureMethod": "username-password-otp",
      "auditRetentionYears": 7,
      "signatureMeaningStatement": { "en": "I approve", "ar": "أوافق" }
    }
  }
}
```

## Showcase pack: 21-cfr-part-11

Implements the minimum of 21 CFR Part 11 for v1:

- Adds a `Signature` entity per §11.50 (electronic-signature
  manifestation): method, challenge_id, signed_at, signed_by,
  meaning_statement, entity_kind, entity_id. Composed with the
  built-in `auditable` trait.
- Three parameters:
  - `signatureMethod` (enum) — challenge mechanism per §11.10(g) /
    §11.200
  - `auditRetentionYears` (integer, min 7) — retention floor per
    §11.10(e)
  - `signatureMeaningStatement` (localized-string, required) —
    statement displayed at sign per §11.50(a)

Out of v1 (deferred to Phase 2):

- Rego validation policies (needs opa-wasm runtime)
- Pack-imposed transition constraints (`requireESignature` preEffect)
- Citations mapping (`citations.json`)
- Tenant attestations
- Dual-control approval workflow template
- MFA permission floors

## Conflict policy (v1)

Pack-vs-tenant and pack-vs-pack: any contribution colliding with an
existing entity name / trait name / role key / permission entity /
workflow key throws `CollisionError`.

Phase 2 will add ADR-0012's smarter conflict resolution (longest
retention wins; strictest MFA wins; notification constraints all
apply; contradictory rules flagged as errors with citations).

## Deferred to Phase 2

- Pack versioning + deprecation flow (currently identifier is opaque)
- Rego validators
- Audit retention overrides
- Tenant attestation log
- AI Architect `searchCompliancePack` tool
- Pack documentation generation
- Real content for `eu-gmp`, `hipaa`, `gdpr`, `uae-moh` (priority
  set per Round 9)
