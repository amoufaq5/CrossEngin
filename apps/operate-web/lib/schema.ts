"use client";

import { useEffect, useState } from "react";

export type UiInputType =
  | "text"
  | "textarea"
  | "email"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "reference";

export interface UiFieldSchema {
  readonly name: string;
  readonly label: string;
  readonly input: UiInputType;
  readonly required: boolean;
  readonly enumValues?: readonly string[];
  readonly referenceTarget?: string;
  readonly classification?: string;
  readonly unique?: boolean;
  readonly readOnly?: boolean;
}

export interface UiTransitionSchema {
  readonly name: string;
  readonly label: string;
  readonly operationId: string;
  readonly stateField: string;
  readonly from: readonly string[];
  readonly to: string;
}

export interface UiEntitySchema {
  readonly name: string;
  readonly slug: string;
  readonly label: string;
  readonly singular: string;
  readonly fields: readonly UiFieldSchema[];
  readonly listColumns: readonly string[];
  readonly sortableFields: readonly string[];
  readonly filterableFields: readonly string[];
  readonly stateField: string | null;
  readonly transitions: readonly UiTransitionSchema[];
  readonly operationIds: Record<"list" | "read" | "create" | "update" | "delete", string>;
}

export interface UiSchema {
  readonly entities: readonly UiEntitySchema[];
  readonly generatedAt: string;
}

let cache: UiSchema | null = null;
let inflight: Promise<UiSchema> | null = null;

export async function fetchSchema(): Promise<UiSchema> {
  if (cache !== null) return cache;
  if (inflight !== null) return inflight;
  inflight = (async () => {
    const res = await fetch("/api/v1/meta/schema", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`schema ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    const schema = (await res.json()) as UiSchema;
    cache = schema;
    return schema;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export interface SchemaState {
  readonly schema: UiSchema | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export function useSchema(): SchemaState {
  const [schema, setSchema] = useState<UiSchema | null>(cache);
  const [loading, setLoading] = useState(cache === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cache !== null) {
      setSchema(cache);
      setLoading(false);
      return;
    }
    let alive = true;
    fetchSchema()
      .then((s) => {
        if (alive) {
          setSchema(s);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  return { schema, loading, error };
}

export function entityBySlug(schema: UiSchema | null, slug: string): UiEntitySchema | undefined {
  return schema?.entities.find((e) => e.slug === slug);
}

export function entityByName(schema: UiSchema | null, name: string): UiEntitySchema | undefined {
  return schema?.entities.find((e) => e.name === name);
}

/** A reference field's value points at another entity; resolve its slug for deep links. */
export function slugForEntityName(schema: UiSchema | null, name: string): string | undefined {
  return entityByName(schema, name)?.slug;
}
