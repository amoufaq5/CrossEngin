import type { OpenApiSchema } from "@crossengin/operate-runtime";
import type { ZodTypeAny } from "zod";

import {
  CalendarModelSchema,
  DashboardModelSchema,
  DetailModelSchema,
  FormModelSchema,
  KanbanModelSchema,
  MapModelSchema,
  PivotModelSchema,
  TableModelSchema,
  WebAppModelSchema,
} from "./model.js";

/**
 * The slice of a zod type's internal `_def` this converter reads. zod 3's
 * `_def.typeName` discriminator + these fields are stable across 3.x; the
 * converter is defensive (unknown kinds → an open `{}` schema), so a new zod
 * construct degrades gracefully rather than throwing.
 */
interface ZodDef {
  readonly typeName?: string;
  readonly innerType?: ZodTypeAny;
  readonly type?: ZodTypeAny;
  readonly value?: unknown;
  readonly values?: readonly string[];
  readonly shape?: () => Record<string, ZodTypeAny>;
  readonly options?: readonly ZodTypeAny[];
  readonly valueType?: ZodTypeAny;
}

function defOf(type: ZodTypeAny): ZodDef {
  return (type as unknown as { _def: ZodDef })._def;
}

/**
 * Converts a (model-shaped) zod schema to a minimal OpenAPI/JSON-Schema object —
 * the subset operate-web's `model.ts` uses (object / string / number / boolean /
 * array / enum / literal / discriminated-union / optional / unknown). Used to
 * publish the view-model *shapes* in the discovery descriptor without
 * hand-authoring them (so they can't drift from the zod source of truth).
 */
export function zodToOpenApiSchema(type: ZodTypeAny): OpenApiSchema {
  const def = defOf(type);
  switch (def.typeName) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodLiteral": {
      const v = def.value;
      if (typeof v === "string") return { type: "string", enum: [v] };
      if (typeof v === "number") return { type: "number" };
      if (typeof v === "boolean") return { type: "boolean" };
      return {};
    }
    case "ZodEnum":
      return { type: "string", enum: def.values !== undefined ? [...def.values] : [] };
    case "ZodArray":
      return { type: "array", items: def.type !== undefined ? zodToOpenApiSchema(def.type) : {} };
    case "ZodObject": {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, OpenApiSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        const childDef = defOf(child);
        if (childDef.typeName === "ZodOptional" && childDef.innerType !== undefined) {
          properties[key] = zodToOpenApiSchema(childDef.innerType);
        } else {
          properties[key] = zodToOpenApiSchema(child);
          required.push(key);
        }
      }
      return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
    }
    case "ZodDiscriminatedUnion":
    case "ZodUnion":
      return { oneOf: (def.options ?? []).map(zodToOpenApiSchema) };
    case "ZodOptional":
    case "ZodNullable":
      return def.innerType !== undefined ? zodToOpenApiSchema(def.innerType) : {};
    case "ZodRecord":
      return { type: "object", additionalProperties: def.valueType !== undefined ? zodToOpenApiSchema(def.valueType) : true };
    default:
      return {};
  }
}

/**
 * The view-model *shapes* a UI client receives from the `/ui` routes, as OpenAPI
 * schemas (P3.35). Caller-independent — the model *shape* is the same for every
 * viewer (only the data + which fields appear are redacted per-caller); a client
 * uses these to type the `table`/`detail`/`form`/… envelopes.
 */
export function webModelSchemas(): Readonly<Record<string, OpenApiSchema>> {
  return {
    WebAppModel: zodToOpenApiSchema(WebAppModelSchema),
    TableModel: zodToOpenApiSchema(TableModelSchema),
    DetailModel: zodToOpenApiSchema(DetailModelSchema),
    FormModel: zodToOpenApiSchema(FormModelSchema),
    KanbanModel: zodToOpenApiSchema(KanbanModelSchema),
    CalendarModel: zodToOpenApiSchema(CalendarModelSchema),
    MapModel: zodToOpenApiSchema(MapModelSchema),
    DashboardModel: zodToOpenApiSchema(DashboardModelSchema),
    PivotModel: zodToOpenApiSchema(PivotModelSchema),
  };
}
