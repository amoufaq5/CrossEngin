import { z } from "zod";

export const REGIONS = [
  "eu-central",
  "eu-west",
  "us-east",
  "us-west",
  "me-uae",
  "gcc-ksa",
  "apac-sg",
  "ap-south",
] as const;
export type Region = (typeof REGIONS)[number];

export const RegionSchema = z.enum(REGIONS);

export const BROAD_REGIONS = ["eu", "us", "me", "ap", "sa"] as const;
export type BroadRegion = (typeof BROAD_REGIONS)[number];

export const BroadRegionSchema = z.enum(BROAD_REGIONS);

export const BROAD_REGION_OF: Readonly<Record<Region, BroadRegion>> = Object.freeze({
  "eu-central": "eu",
  "eu-west": "eu",
  "us-east": "us",
  "us-west": "us",
  "me-uae": "me",
  "gcc-ksa": "me",
  "apac-sg": "ap",
  "ap-south": "ap",
});

export function broadRegionOf(region: Region): BroadRegion {
  return BROAD_REGION_OF[region];
}

export const REGION_STATUSES = ["planned", "dr_replica", "active", "deprecated"] as const;
export type RegionStatus = (typeof REGION_STATUSES)[number];

export const RegionStatusSchema = z.enum(REGION_STATUSES);

export const CLOUD_PROVIDERS = [
  "supabase",
  "self-hosted",
  "aws",
  "gcp",
  "azure",
  "cloudflare-r2",
] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export const RegionRecordSchema = z.object({
  region: RegionSchema,
  label: z.string().min(1),
  cloudProviderRegion: z.string().min(1),
  cloudProvider: z.enum(CLOUD_PROVIDERS),
  status: RegionStatusSchema,
  yearAvailable: z.number().int().min(2024).max(2100),
  drReplicaOf: RegionSchema.optional(),
  drReplicaIn: RegionSchema.optional(),
  notes: z.string().optional(),
});
export type RegionRecord = z.infer<typeof RegionRecordSchema>;

export const RegionCatalogSchema = z.array(RegionRecordSchema).superRefine((records, ctx) => {
  const seen = new Set<Region>();
  records.forEach((r, i) => {
    if (seen.has(r.region)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "region"],
        message: `duplicate region '${r.region}'`,
      });
    }
    seen.add(r.region);
  });

  const byRegion = new Map(records.map((r) => [r.region, r]));
  records.forEach((r, i) => {
    if (r.drReplicaOf !== undefined && !byRegion.has(r.drReplicaOf)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "drReplicaOf"],
        message: `drReplicaOf references unknown region '${r.drReplicaOf}'`,
      });
    }
    if (r.drReplicaIn !== undefined && !byRegion.has(r.drReplicaIn)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "drReplicaIn"],
        message: `drReplicaIn references unknown region '${r.drReplicaIn}'`,
      });
    }
  });
});
export type RegionCatalog = z.infer<typeof RegionCatalogSchema>;

export const DEFAULT_REGION_CATALOG: RegionCatalog = [
  {
    region: "eu-central",
    label: "EU Central (Frankfurt)",
    cloudProviderRegion: "supabase-eu-central-1",
    cloudProvider: "supabase",
    status: "active",
    yearAvailable: 2026,
    drReplicaIn: "apac-sg",
  },
  {
    region: "eu-west",
    label: "EU West (Ireland)",
    cloudProviderRegion: "supabase-eu-west-1",
    cloudProvider: "supabase",
    status: "planned",
    yearAvailable: 2027,
  },
  {
    region: "us-east",
    label: "US East (Virginia)",
    cloudProviderRegion: "supabase-us-east-1",
    cloudProvider: "supabase",
    status: "planned",
    yearAvailable: 2028,
  },
  {
    region: "us-west",
    label: "US West (Oregon)",
    cloudProviderRegion: "supabase-us-west-1",
    cloudProvider: "supabase",
    status: "planned",
    yearAvailable: 2028,
  },
  {
    region: "me-uae",
    label: "Middle East (UAE)",
    cloudProviderRegion: "self-hosted-uae",
    cloudProvider: "self-hosted",
    status: "planned",
    yearAvailable: 2027,
    notes:
      "Self-hosted Supabase in UAE (AWS me-south-1 or local provider); triggered by first UAE-resident-data tenant.",
  },
  {
    region: "gcc-ksa",
    label: "GCC (Saudi Arabia)",
    cloudProviderRegion: "self-hosted-ksa",
    cloudProvider: "self-hosted",
    status: "planned",
    yearAvailable: 2029,
  },
  {
    region: "apac-sg",
    label: "APAC (Singapore)",
    cloudProviderRegion: "supabase-ap-southeast-1",
    cloudProvider: "supabase",
    status: "dr_replica",
    yearAvailable: 2027,
    drReplicaOf: "eu-central",
  },
  {
    region: "ap-south",
    label: "APAC (Mumbai)",
    cloudProviderRegion: "supabase-ap-south-1",
    cloudProvider: "supabase",
    status: "planned",
    yearAvailable: 2029,
  },
] as const;
