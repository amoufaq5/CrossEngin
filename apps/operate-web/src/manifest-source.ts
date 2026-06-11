import {
  resolveManifest,
  tryValidateManifest,
  ManifestSchema,
  type Manifest,
  type ManifestRegistry,
} from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { ERP_RETAIL_PACK_SLUG, buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { ERP_HEALTHCARE_PACK_SLUG, buildErpHealthcarePack } from "@crossengin/pack-erp-healthcare";
import { ERP_GROCERY_PACK_SLUG, buildErpGroceryPack } from "@crossengin/pack-erp-grocery";
import { ERP_CONSTRUCTION_PACK_SLUG, buildErpConstructionPack } from "@crossengin/pack-erp-construction";

const PACK_BUILDERS: Record<string, () => Manifest> = {
  [ERP_CORE_PACK_SLUG]: () => buildErpCorePack(),
  [ERP_RETAIL_PACK_SLUG]: () => buildErpRetailPack(),
  [ERP_HEALTHCARE_PACK_SLUG]: () => buildErpHealthcarePack(),
  [ERP_GROCERY_PACK_SLUG]: () => buildErpGroceryPack(),
  [ERP_CONSTRUCTION_PACK_SLUG]: () => buildErpConstructionPack(),
};

/** Short `--pack <name>` aliases mapped to their canonical slugs. */
export const PACK_ALIASES: Record<string, string> = {
  "erp-core": ERP_CORE_PACK_SLUG,
  "erp-retail": ERP_RETAIL_PACK_SLUG,
  "erp-healthcare": ERP_HEALTHCARE_PACK_SLUG,
  "erp-grocery": ERP_GROCERY_PACK_SLUG,
  "erp-construction": ERP_CONSTRUCTION_PACK_SLUG,
};

export const BUILTIN_PACK_NAMES: readonly string[] = Object.keys(PACK_ALIASES);

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    const build = PACK_BUILDERS[id];
    return build === undefined ? null : build();
  },
};

/**
 * Builds a built-in vertical pack and fully resolves its `meta.extends` lineage
 * against the registry of all packs (retail → core, grocery → retail → core).
 * Throws on an unknown alias or a pack that doesn't cross-validate.
 */
export async function loadBuiltinPack(alias: string): Promise<Manifest> {
  const slug = PACK_ALIASES[alias];
  if (slug === undefined) {
    throw new Error(`unknown pack '${alias}'; known: ${BUILTIN_PACK_NAMES.join(", ")}`);
  }
  const build = PACK_BUILDERS[slug];
  if (build === undefined) throw new Error(`no builder registered for slug '${slug}'`);
  const resolved = await resolveManifest(build(), { registry });
  assertValid(resolved, `pack '${alias}'`);
  return resolved;
}

/** Parses + validates a resolved-manifest JSON document (must cross-validate standalone). */
export function loadManifestFromJson(text: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${(err as Error).message}`);
  }
  const manifest = ManifestSchema.parse(parsed);
  assertValid(manifest, "manifest");
  return manifest;
}

function assertValid(manifest: Manifest, label: string): void {
  const result = tryValidateManifest(manifest);
  if (!result.ok) {
    const detail = result.errors.map((e) => e.message).join("; ");
    throw new Error(`${label} failed validation: ${detail}`);
  }
}
