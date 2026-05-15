import { z } from "zod";
import { RegionSchema, type Region } from "@crossengin/residency";

export const VectorClockEntrySchema = z.object({
  region: RegionSchema,
  counter: z.number().int().nonnegative(),
});
export type VectorClockEntry = z.infer<typeof VectorClockEntrySchema>;

export const VectorClockSchema = z
  .array(VectorClockEntrySchema)
  .superRefine((entries, ctx) => {
    const regions = new Set<Region>();
    entries.forEach((e, i) => {
      if (regions.has(e.region)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "region"],
          message: `duplicate region '${e.region}' in vector clock`,
        });
      }
      regions.add(e.region);
    });
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const curr = entries[i];
      if (prev !== undefined && curr !== undefined && curr.region < prev.region) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "region"],
          message: "vector clock entries must be sorted by region (lexicographic)",
        });
      }
    }
  });
export type VectorClock = z.infer<typeof VectorClockSchema>;

export const EMPTY_VECTOR_CLOCK: VectorClock = [];

export function getCounter(clock: VectorClock, region: Region): number {
  const entry = clock.find((e) => e.region === region);
  return entry?.counter ?? 0;
}

export function incrementVectorClock(clock: VectorClock, region: Region): VectorClock {
  const existing = clock.find((e) => e.region === region);
  if (existing === undefined) {
    return [...clock, { region, counter: 1 }].sort((a, b) => a.region.localeCompare(b.region));
  }
  return clock.map((e) =>
    e.region === region ? { region, counter: e.counter + 1 } : e,
  );
}

export function mergeVectorClocks(
  a: VectorClock,
  b: VectorClock,
): VectorClock {
  const regions = new Set<Region>();
  for (const e of a) regions.add(e.region);
  for (const e of b) regions.add(e.region);
  const out: VectorClockEntry[] = [];
  for (const region of regions) {
    out.push({
      region,
      counter: Math.max(getCounter(a, region), getCounter(b, region)),
    });
  }
  return out.sort((x, y) => x.region.localeCompare(y.region));
}

export type CausalRelation = "equal" | "before" | "after" | "concurrent";

export function compareVectorClocks(a: VectorClock, b: VectorClock): CausalRelation {
  const regions = new Set<Region>();
  for (const e of a) regions.add(e.region);
  for (const e of b) regions.add(e.region);
  let aHasGreater = false;
  let bHasGreater = false;
  for (const region of regions) {
    const aC = getCounter(a, region);
    const bC = getCounter(b, region);
    if (aC > bC) aHasGreater = true;
    if (bC > aC) bHasGreater = true;
    if (aHasGreater && bHasGreater) return "concurrent";
  }
  if (!aHasGreater && !bHasGreater) return "equal";
  if (aHasGreater) return "after";
  return "before";
}

export function isCausallyConcurrent(a: VectorClock, b: VectorClock): boolean {
  return compareVectorClocks(a, b) === "concurrent";
}

export function happensBefore(a: VectorClock, b: VectorClock): boolean {
  return compareVectorClocks(a, b) === "before";
}

export function dominates(a: VectorClock, b: VectorClock): boolean {
  const rel = compareVectorClocks(a, b);
  return rel === "after" || rel === "equal";
}

export const StampedEventSchema = z.object({
  eventId: z.string().min(1),
  originRegion: RegionSchema,
  clock: VectorClockSchema,
  occurredAt: z.string().datetime({ offset: true }),
});
export type StampedEvent = z.infer<typeof StampedEventSchema>;

export function tickEvent(
  prior: VectorClock,
  region: Region,
): VectorClock {
  return incrementVectorClock(prior, region);
}
