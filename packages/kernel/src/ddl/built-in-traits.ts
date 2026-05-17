import type { Field } from "@crossengin/types/meta-schema";

const AUDITABLE_FIELDS: readonly Field[] = [
  {
    name: "created_at",
    type: { kind: "datetime" },
    required: true,
    default: { kind: "expression", expression: "now()" },
  },
  {
    name: "updated_at",
    type: { kind: "datetime" },
    required: true,
    default: { kind: "expression", expression: "now()" },
  },
  { name: "created_by", type: { kind: "uuid" } },
  { name: "updated_by", type: { kind: "uuid" } },
];

const SOFT_DELETABLE_FIELDS: readonly Field[] = [
  { name: "deleted_at", type: { kind: "datetime" }, indexed: true },
  { name: "deleted_by", type: { kind: "uuid" } },
];

const VERSIONED_FIELDS: readonly Field[] = [
  {
    name: "version",
    type: { kind: "integer", min: 1 },
    required: true,
    default: { kind: "literal", value: 1 },
  },
];

const GXP_SIGNED_FIELDS: readonly Field[] = [
  {
    name: "e_signature_required",
    type: { kind: "boolean" },
    required: true,
    default: { kind: "literal", value: true },
  },
];

export const BUILT_IN_TRAIT_FIELDS: ReadonlyMap<string, readonly Field[]> = new Map([
  ["auditable", AUDITABLE_FIELDS],
  ["soft_deletable", SOFT_DELETABLE_FIELDS],
  ["versioned", VERSIONED_FIELDS],
  ["tenant_owned", []],
  ["gxp_signed", GXP_SIGNED_FIELDS],
  ["part_11_compliant", []],
]);
