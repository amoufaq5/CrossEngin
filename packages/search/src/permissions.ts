import { z } from "zod";

export const PERMISSION_TAG_REGEX = /^([a-z][a-z0-9_]*):([A-Za-z0-9_./@-]+)$/;

export const PermissionTagSchema = z.string().regex(PERMISSION_TAG_REGEX, {
  message: "permission tag must be '<key>:<value>' (lowercase key, ASCII value)",
});
export type PermissionTag = z.infer<typeof PermissionTagSchema>;

export interface ParsedPermissionTag {
  readonly key: string;
  readonly value: string;
}

export function parsePermissionTag(tag: string): ParsedPermissionTag {
  const match = tag.match(PERMISSION_TAG_REGEX);
  if (match === null) {
    throw new Error(`invalid permission tag: ${tag}`);
  }
  const [, key, value] = match;
  if (key === undefined || value === undefined) {
    throw new Error(`invalid permission tag: ${tag}`);
  }
  return { key, value };
}

export function formatPermissionTag(key: string, value: string): PermissionTag {
  return PermissionTagSchema.parse(`${key}:${value}`);
}

export interface PermissionTagInput {
  readonly role: string;
  readonly secondaryRoles?: readonly string[];
  readonly abacAttributes?: Readonly<Record<string, string | number | boolean>>;
}

export function deriveSessionTags(input: PermissionTagInput): readonly PermissionTag[] {
  const tags: PermissionTag[] = [];
  tags.push(formatPermissionTag("role", input.role));
  for (const sec of input.secondaryRoles ?? []) {
    tags.push(formatPermissionTag("role", sec));
  }
  for (const [k, v] of Object.entries(input.abacAttributes ?? {})) {
    tags.push(formatPermissionTag(k, String(v)));
  }
  return tags;
}

export interface PermissionFilterInput {
  readonly sessionTags: readonly PermissionTag[];
  readonly resourceTags: readonly PermissionTag[];
  readonly requireAll?: readonly string[];
}

export function isAuthorizedForResource(input: PermissionFilterInput): boolean {
  const resourceByKey = new Map<string, Set<string>>();
  for (const tag of input.resourceTags) {
    const { key, value } = parsePermissionTag(tag);
    let set = resourceByKey.get(key);
    if (set === undefined) {
      set = new Set();
      resourceByKey.set(key, set);
    }
    set.add(value);
  }

  if (resourceByKey.has("role")) {
    const sessionRoles = new Set<string>();
    for (const tag of input.sessionTags) {
      const { key, value } = parsePermissionTag(tag);
      if (key === "role") sessionRoles.add(value);
    }
    const allowedRoles = resourceByKey.get("role") ?? new Set();
    let matched = false;
    for (const role of sessionRoles) {
      if (allowedRoles.has(role)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }

  for (const requiredKey of input.requireAll ?? []) {
    const sessionValuesForKey = new Set<string>();
    for (const tag of input.sessionTags) {
      const { key, value } = parsePermissionTag(tag);
      if (key === requiredKey) sessionValuesForKey.add(value);
    }
    const resourceValuesForKey = resourceByKey.get(requiredKey) ?? new Set();
    let matched = false;
    for (const v of sessionValuesForKey) {
      if (resourceValuesForKey.has(v)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }

  return true;
}

export function typesenseFilterExpression(sessionTags: readonly PermissionTag[]): string {
  if (sessionTags.length === 0) return "permission_tags:=*";
  const escaped = sessionTags.map((t) => `\`${t.replace(/`/g, "")}\``);
  return `permission_tags:=[${escaped.join(",")}]`;
}
