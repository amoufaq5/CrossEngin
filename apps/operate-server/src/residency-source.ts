import { ResidencyProfileSchema } from "@crossengin/residency";
import { InMemoryTenantResidencyDirectory } from "@crossengin/residency-runtime";
import { z } from "zod";

const ResidencyFileSchema = z.object({
  tenants: z.array(z.object({ tenantId: z.string().min(1), profile: ResidencyProfileSchema })),
});

/**
 * Parses + validates a residency file (`{ tenants: [{ tenantId, profile }] }`) into an in-memory
 * tenant→profile directory the region guard routes against. Each profile is validated through the
 * kernel `ResidencyProfileSchema`, so a malformed profile fails at boot rather than at request time.
 */
export function loadResidencyDirectory(json: string): InMemoryTenantResidencyDirectory {
  const parsed = ResidencyFileSchema.parse(JSON.parse(json));
  return new InMemoryTenantResidencyDirectory(parsed.tenants.map((t) => [t.tenantId, t.profile] as const));
}
