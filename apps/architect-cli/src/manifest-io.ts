import { readFile, writeFile, access } from "node:fs/promises";

import { ManifestSchema, type Manifest } from "@crossengin/kernel/manifest";
import { manifestHash } from "@crossengin/kernel/manifest";

import type { ManifestSummary } from "./format.js";

export async function readManifestFile(path: string): Promise<Manifest> {
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return ManifestSchema.parse(parsed);
}

export async function readManifestPermissive(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

export async function writeManifestFile(
  path: string,
  manifest: Manifest,
  opts: { readonly force: boolean } = { force: false },
): Promise<void> {
  if (!opts.force) {
    let exists = false;
    try {
      await access(path);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      throw new Error(`refusing to overwrite ${path} without --force`);
    }
  }
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function recordSize(value: Record<string, unknown> | undefined): number {
  if (value === undefined) return 0;
  return Object.keys(value).length;
}

export function buildManifestSummary(manifest: Manifest): ManifestSummary {
  return {
    name: manifest.meta.name,
    slug: manifest.meta.slug,
    version: manifest.meta.version,
    description: manifest.meta.description ?? null,
    extendsParents: manifest.meta.extends?.length ?? 0,
    compliancePacks: manifest.meta.compliancePacks?.length ?? 0,
    counts: {
      entities: manifest.entities?.length ?? 0,
      workflows: recordSize(manifest.workflows),
      views: recordSize(manifest.views),
      reports: recordSize(manifest.reports),
      dashboards: recordSize(manifest.dashboards),
      jobs: recordSize(manifest.jobs),
      integrations: recordSize(manifest.integrations),
      roles: recordSize(manifest.roles),
      traits: manifest.traits?.length ?? 0,
      relations: manifest.relations?.length ?? 0,
      fileTypes: recordSize(manifest.files),
      customWidgets: recordSize(manifest.customWidgets),
    },
    hash: manifestHash(manifest),
  };
}

export function emptyManifest(input: {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
}): Manifest {
  return ManifestSchema.parse({
    manifestVersion: "1.0",
    meta: {
      name: input.name,
      slug: input.slug,
      version: "1.0.0",
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
    entities: [],
  });
}

export type { Manifest };
