import { createHash } from "node:crypto";
import type { Manifest } from "./types.js";

export function canonicalizeForHash(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonicalizeForHash);
    if (items.length > 0 && items.every(isNamedObject)) {
      return items.slice().sort((a, b) => {
        const an = (a as { name: string }).name;
        const bn = (b as { name: string }).name;
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
    }
    return items;
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalizeForHash(obj[key]);
  }
  return sorted;
}

function isNamedObject(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const name = (v as Record<string, unknown>).name;
  return typeof name === "string";
}

function stripManifestResolution(manifest: Manifest): Manifest {
  const meta = { ...manifest.meta };
  delete meta.manifestResolution;
  return { ...manifest, meta };
}

export function canonicalManifestJson(manifest: Manifest): string {
  return JSON.stringify(canonicalizeForHash(stripManifestResolution(manifest)));
}

export function manifestHash(manifest: Manifest): string {
  return createHash("sha256").update(canonicalManifestJson(manifest)).digest("hex");
}
