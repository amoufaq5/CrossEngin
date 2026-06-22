"use client";

import { useReferenceLabel } from "@/lib/reference-cache";
import type { UiSchema } from "@/lib/schema";

/** Renders a reference value as its target record's human label (falling back to the id). */
export function ReferenceLabel({ schema, target, id }: { schema: UiSchema | null; target: string; id: string }) {
  const label = useReferenceLabel(schema, target, id);
  return <>{label}</>;
}
