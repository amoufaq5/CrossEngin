import { z } from "zod";
import { RegionSchema, type Region } from "@crossengin/residency";

export const CRDT_KINDS = [
  "g_counter",
  "pn_counter",
  "or_set",
  "lww_register",
  "lww_map",
  "mv_register",
] as const;
export type CrdtKind = (typeof CRDT_KINDS)[number];
export const CrdtKindSchema = z.enum(CRDT_KINDS);

const Iso8601 = z.string().datetime({ offset: true });

export const GCounterSchema = z.object({
  kind: z.literal("g_counter"),
  perRegion: z.record(z.string(), z.number().int().nonnegative()),
});
export type GCounter = z.infer<typeof GCounterSchema>;

export const PNCounterSchema = z.object({
  kind: z.literal("pn_counter"),
  positive: z.record(z.string(), z.number().int().nonnegative()),
  negative: z.record(z.string(), z.number().int().nonnegative()),
});
export type PNCounter = z.infer<typeof PNCounterSchema>;

export const OrSetEntrySchema = z.object({
  value: z.string().min(1),
  addedTags: z.array(z.string().min(1)),
  removedTags: z.array(z.string().min(1)),
});
export type OrSetEntry = z.infer<typeof OrSetEntrySchema>;

export const OrSetSchema = z.object({
  kind: z.literal("or_set"),
  entries: z.array(OrSetEntrySchema),
});
export type OrSet = z.infer<typeof OrSetSchema>;

export const LwwRegisterSchema = z
  .object({
    kind: z.literal("lww_register"),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    timestamp: Iso8601,
    originRegion: RegionSchema,
  })
  .strict();
export type LwwRegister = z.infer<typeof LwwRegisterSchema>;

export const LwwMapEntrySchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  timestamp: Iso8601,
  originRegion: RegionSchema,
  tombstone: z.boolean().default(false),
});
export type LwwMapEntry = z.infer<typeof LwwMapEntrySchema>;

export const LwwMapSchema = z.object({
  kind: z.literal("lww_map"),
  entries: z.array(LwwMapEntrySchema),
});
export type LwwMap = z.infer<typeof LwwMapSchema>;

export const MvRegisterEntrySchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  timestamp: Iso8601,
  originRegion: RegionSchema,
});
export type MvRegisterEntry = z.infer<typeof MvRegisterEntrySchema>;

export const MvRegisterSchema = z.object({
  kind: z.literal("mv_register"),
  entries: z.array(MvRegisterEntrySchema).min(1),
});
export type MvRegister = z.infer<typeof MvRegisterSchema>;

export const CrdtSchema = z.discriminatedUnion("kind", [
  GCounterSchema,
  PNCounterSchema,
  OrSetSchema,
  LwwRegisterSchema,
  LwwMapSchema,
  MvRegisterSchema,
]);
export type Crdt = z.infer<typeof CrdtSchema>;

export function gCounterValue(counter: GCounter): number {
  return Object.values(counter.perRegion).reduce((acc, v) => acc + v, 0);
}

export function gCounterIncrement(counter: GCounter, region: Region, by: number = 1): GCounter {
  if (by < 0) throw new Error("G-Counter cannot decrement (use PN-Counter)");
  return {
    kind: "g_counter",
    perRegion: { ...counter.perRegion, [region]: (counter.perRegion[region] ?? 0) + by },
  };
}

export function gCounterMerge(a: GCounter, b: GCounter): GCounter {
  const out: Record<string, number> = {};
  const regions = new Set([...Object.keys(a.perRegion), ...Object.keys(b.perRegion)]);
  for (const r of regions) {
    out[r] = Math.max(a.perRegion[r] ?? 0, b.perRegion[r] ?? 0);
  }
  return { kind: "g_counter", perRegion: out };
}

export function pnCounterValue(counter: PNCounter): number {
  const pos = Object.values(counter.positive).reduce((acc, v) => acc + v, 0);
  const neg = Object.values(counter.negative).reduce((acc, v) => acc + v, 0);
  return pos - neg;
}

export function pnCounterMerge(a: PNCounter, b: PNCounter): PNCounter {
  const positive: Record<string, number> = {};
  const negative: Record<string, number> = {};
  const regions = new Set([
    ...Object.keys(a.positive),
    ...Object.keys(a.negative),
    ...Object.keys(b.positive),
    ...Object.keys(b.negative),
  ]);
  for (const r of regions) {
    positive[r] = Math.max(a.positive[r] ?? 0, b.positive[r] ?? 0);
    negative[r] = Math.max(a.negative[r] ?? 0, b.negative[r] ?? 0);
  }
  return { kind: "pn_counter", positive, negative };
}

export function orSetMembers(set: OrSet): readonly string[] {
  return set.entries
    .filter((e) => e.addedTags.some((t) => !e.removedTags.includes(t)))
    .map((e) => e.value);
}

export function orSetMerge(a: OrSet, b: OrSet): OrSet {
  const byValue = new Map<string, OrSetEntry>();
  for (const entry of [...a.entries, ...b.entries]) {
    const existing = byValue.get(entry.value);
    if (existing === undefined) {
      byValue.set(entry.value, {
        value: entry.value,
        addedTags: [...entry.addedTags],
        removedTags: [...entry.removedTags],
      });
    } else {
      existing.addedTags = [...new Set([...existing.addedTags, ...entry.addedTags])];
      existing.removedTags = [...new Set([...existing.removedTags, ...entry.removedTags])];
    }
  }
  return { kind: "or_set", entries: [...byValue.values()] };
}

export function lwwRegisterMerge(a: LwwRegister, b: LwwRegister): LwwRegister {
  const aMs = new Date(a.timestamp).getTime();
  const bMs = new Date(b.timestamp).getTime();
  if (aMs > bMs) return a;
  if (bMs > aMs) return b;
  return a.originRegion < b.originRegion ? a : b;
}

export function lwwMapMerge(a: LwwMap, b: LwwMap): LwwMap {
  const byKey = new Map<string, LwwMapEntry>();
  for (const entry of [...a.entries, ...b.entries]) {
    const existing = byKey.get(entry.key);
    if (existing === undefined) {
      byKey.set(entry.key, entry);
      continue;
    }
    const eMs = new Date(entry.timestamp).getTime();
    const xMs = new Date(existing.timestamp).getTime();
    if (eMs > xMs) byKey.set(entry.key, entry);
    else if (eMs === xMs && entry.originRegion < existing.originRegion) {
      byKey.set(entry.key, entry);
    }
  }
  return { kind: "lww_map", entries: [...byKey.values()] };
}

export function lwwMapGet(map: LwwMap, key: string): LwwMapEntry["value"] | undefined {
  const entry = map.entries.find((e) => e.key === key);
  if (entry === undefined || entry.tombstone) return undefined;
  return entry.value;
}

export function mvRegisterMerge(a: MvRegister, b: MvRegister): MvRegister {
  const merged = [...a.entries];
  for (const e of b.entries) {
    const dup = merged.find(
      (x) =>
        x.timestamp === e.timestamp && x.originRegion === e.originRegion && x.value === e.value,
    );
    if (dup === undefined) merged.push(e);
  }
  return { kind: "mv_register", entries: merged };
}
