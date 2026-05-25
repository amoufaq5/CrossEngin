import { z } from "zod";

const SCOPE_REGEX = /^(?:[a-z][a-z0-9_]*|\*):(?:read|write|admin|invoke|\*)$/;

export const ScopeKeySchema = z.string().regex(SCOPE_REGEX, {
  message:
    "scope must be 'resource:action' where action ∈ {read, write, admin, invoke, *} and resource is snake_case or '*'",
});
export type ScopeKey = z.infer<typeof ScopeKeySchema>;

export const ROOT_SCOPE: ScopeKey = "*:*";

export const ScopeSpecSchema = z
  .object({
    key: ScopeKeySchema,
    description: z.string().min(1),
    implies: z.array(ScopeKeySchema).default([]),
    publicGrantable: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.implies.includes(v.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["implies"],
        message: `scope '${v.key}' cannot imply itself`,
      });
    }
    const seen = new Set<ScopeKey>();
    v.implies.forEach((s, i) => {
      if (seen.has(s)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["implies", i],
          message: `duplicate implied scope '${s}'`,
        });
      }
      seen.add(s);
    });
  });
export type ScopeSpec = z.infer<typeof ScopeSpecSchema>;

export const ScopeCatalogSchema = z.array(ScopeSpecSchema).superRefine((entries, ctx) => {
  const keys = new Map<ScopeKey, number>();
  entries.forEach((e, i) => {
    const prior = keys.get(e.key);
    if (prior !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "key"],
        message: `duplicate scope key '${e.key}' (already at index ${prior})`,
      });
    }
    keys.set(e.key, i);
  });
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e === undefined) continue;
    for (let j = 0; j < e.implies.length; j++) {
      const implied = e.implies[j];
      if (implied === undefined) continue;
      if (implied === ROOT_SCOPE) continue;
      if (!keys.has(implied) && implied !== "*:read" && implied !== "*:write") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "implies", j],
          message: `implied scope '${implied}' is not declared in the catalog`,
        });
      }
    }
  }
  const visiting = new Set<ScopeKey>();
  const visited = new Set<ScopeKey>();
  const byKey = new Map<ScopeKey, ScopeSpec>();
  for (const e of entries) byKey.set(e.key, e);
  const dfs = (key: ScopeKey, path: ScopeKey[]): boolean => {
    if (visiting.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `cycle in scope 'implies' graph: ${[...path, key].join(" -> ")}`,
      });
      return true;
    }
    if (visited.has(key)) return false;
    visiting.add(key);
    const spec = byKey.get(key);
    if (spec !== undefined) {
      for (const next of spec.implies) {
        if (dfs(next, [...path, key])) return true;
      }
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  for (const e of entries) dfs(e.key, []);
});
export type ScopeCatalog = z.infer<typeof ScopeCatalogSchema>;

export function expandScopes(
  catalog: ScopeCatalog,
  granted: readonly ScopeKey[],
): readonly ScopeKey[] {
  const byKey = new Map<ScopeKey, ScopeSpec>();
  for (const s of catalog) byKey.set(s.key, s);
  const result = new Set<ScopeKey>();
  const stack: ScopeKey[] = [...granted];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    if (result.has(top)) continue;
    result.add(top);
    const spec = byKey.get(top);
    if (spec !== undefined) stack.push(...spec.implies);
  }
  return [...result].sort();
}

export function hasScope(
  required: ScopeKey,
  granted: readonly ScopeKey[],
  catalog?: ScopeCatalog,
): boolean {
  const effective =
    catalog === undefined ? new Set(granted) : new Set(expandScopes(catalog, granted));
  if (effective.has(ROOT_SCOPE)) return true;
  if (effective.has(required)) return true;
  const [resource, action] = required.split(":");
  if (resource === undefined || action === undefined) return false;
  if (effective.has(`${resource}:*`)) return true;
  if (effective.has(`*:${action}`)) return true;
  return false;
}

export function normalizeScopes(scopes: readonly ScopeKey[]): readonly ScopeKey[] {
  return [...new Set(scopes)].sort();
}
