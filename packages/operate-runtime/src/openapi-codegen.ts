import type { OpenApiDocument, OpenApiOperationObject, OpenApiResponse } from "./openapi.js";
import type { OpenApiSchema } from "./schemas.js";

/**
 * A pure, deterministic OpenAPI 3.1 → TypeScript client emitter (P3.38). It turns
 * the `OpenApiDocument` operate-server serves at `GET /v1/openapi.json` into a
 * single self-contained `.ts` module: a typed interface per component schema + a
 * `fetch`-based client with one method per operation. Works purely off the
 * document (the published contract) — no internal descriptor coupling, no external
 * codegen tool, no runtime dependency in the emitted module beyond global `fetch`.
 */
export interface EmitClientOptions {
  /** The exported client factory name (default `createOperateClient`). */
  readonly clientName?: string;
}

const DEFAULT_CLIENT_NAME = "createOperateClient";

/** `#/components/schemas/Product` → `Product`. */
function refName(ref: string): string {
  const i = ref.lastIndexOf("/");
  return i >= 0 ? ref.slice(i + 1) : ref;
}

/** `product.list` / `sales-order.create` → `productList` / `salesOrderCreate`. */
export function operationMethodName(operationId: string): string {
  const parts = operationId.split(/[._\-/]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "op";
  return parts
    .map((p, i) => (i === 0 ? p[0]!.toLowerCase() + p.slice(1) : p[0]!.toUpperCase() + p.slice(1)))
    .join("");
}

/** The `{param}` placeholders in a path template, in order. */
function pathParamNames(path: string): readonly string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

const SCALAR: Readonly<Record<string, string>> = {
  string: "string",
  integer: "number",
  number: "number",
  boolean: "boolean",
};

/** A JSON-Schema (subset) → a TypeScript type expression. */
export function schemaToTsType(schema: OpenApiSchema | undefined): string {
  if (schema === undefined) return "unknown";
  if (schema.$ref !== undefined) return refName(schema.$ref);
  if (schema.oneOf !== undefined) return schema.oneOf.map(schemaToTsType).join(" | ");

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = types.includes("null");
  const base = types.find((t) => t !== "null");

  // An enum already enumerates its allowed members (including `null` if present),
  // so it carries its own nullability.
  if (schema.enum !== undefined) {
    return schema.enum.map((v) => (v === null ? "null" : JSON.stringify(v))).join(" | ");
  }

  let ts: string;
  if (base !== undefined && SCALAR[base] !== undefined) {
    ts = SCALAR[base]!;
  } else if (base === "array") {
    const item = schemaToTsType(schema.items);
    ts = /[ |&]/.test(item) ? `(${item})[]` : `${item}[]`;
  } else if (base === "object" || schema.properties !== undefined || schema.additionalProperties !== undefined) {
    if (schema.properties !== undefined) {
      ts = inlineObjectType(schema);
    } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
      const v = schema.additionalProperties === true ? "unknown" : schemaToTsType(schema.additionalProperties);
      ts = `Record<string, ${v}>`;
    } else {
      ts = "Record<string, unknown>";
    }
  } else {
    ts = "unknown";
  }
  return nullable ? `${ts} | null` : ts;
}

function inlineObjectType(schema: OpenApiSchema): string {
  const required = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties ?? {}).map(([key, child]) => {
    const opt = required.has(key) ? "" : "?";
    return `${tsPropKey(key)}${opt}: ${schemaToTsType(child)}`;
  });
  return props.length > 0 ? `{ ${props.join("; ")} }` : "Record<string, never>";
}

/** A safe object-key literal (quotes non-identifiers). */
function tsPropKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** Emits the `export interface`/`export type` for one named component schema. */
function emitNamedSchema(name: string, schema: OpenApiSchema): string {
  if (schema.oneOf !== undefined) {
    return `export type ${name} =\n  | ${schema.oneOf.map(schemaToTsType).join("\n  | ")};`;
  }
  if (schema.properties !== undefined) {
    const required = new Set(schema.required ?? []);
    const lines = Object.entries(schema.properties).map(([key, child]) => {
      const opt = required.has(key) ? "" : "?";
      return `  readonly ${tsPropKey(key)}${opt}: ${schemaToTsType(child)};`;
    });
    return `export interface ${name} {\n${lines.join("\n")}\n}`;
  }
  return `export type ${name} = ${schemaToTsType(schema)};`;
}

/** The success response of an operation (200 → 201 → 204), or undefined. */
function successResponse(op: OpenApiOperationObject): { readonly status: string; readonly response: OpenApiResponse } | undefined {
  for (const status of ["200", "201", "204"]) {
    const response = op.responses[status];
    if (response !== undefined) return { status, response };
  }
  return undefined;
}

/** The TS return type of an operation, mapping the list envelope to `ListResult<T>`. */
function returnTypeFor(op: OpenApiOperationObject): string {
  const success = successResponse(op);
  if (success === undefined || success.status === "204") return "void";
  const schema = success.response.content?.["application/json"]?.schema;
  if (schema === undefined) return "void";
  // `{ data: T[], page }` list envelope → ListResult<T>
  const dataItems = schema.properties?.["data"]?.items;
  if (schema.properties?.["data"]?.type === "array" || dataItems !== undefined) {
    return `ListResult<${schemaToTsType(dataItems)}>`;
  }
  return schemaToTsType(schema);
}

/** The request-body TS type of an operation, or undefined when it takes no body. */
function bodyTypeFor(op: OpenApiOperationObject): string | undefined {
  const schema = op.requestBody?.content["application/json"]?.schema;
  return schema === undefined ? undefined : schemaToTsType(schema);
}

/** Emits one client method `name: (...args) => Promise<Ret>`. */
function emitMethod(method: string, path: string, op: OpenApiOperationObject): string {
  const params = pathParamNames(path);
  const bodyType = bodyTypeFor(op);
  const ret = returnTypeFor(op);

  const sig: string[] = params.map((p) => `${p}: string`);
  if (bodyType !== undefined) sig.push(`body: ${bodyType}`);
  sig.push("query?: QueryParams");

  // Build the path template: substitute params, append the query string.
  const tmpl = path.replace(/\{([^}]+)\}/g, (_m, p: string) => `\${encodeURIComponent(${p})}`);
  const bodyArg = bodyType !== undefined ? ", body" : "";
  const call = `request("${method.toUpperCase()}", \`${tmpl}\${buildQuery(query)}\`${bodyArg})`;

  return `  ${operationMethodName(op.operationId)}: (${sig.join(", ")}): Promise<${ret}> =>\n    ${call} as Promise<${ret}>,`;
}

const PREAMBLE = `// GENERATED by operate-server \`openapi-client\` — do not edit by hand.
// A typed fetch client projected from the served OpenAPI 3.1 document.

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ListResult<T> {
  readonly data: readonly T[];
  readonly page: { readonly limit?: number; readonly nextCursor?: string | null };
}

export class OperateApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails;
  constructor(status: number, problem: ProblemDetails) {
    super(problem.title ?? \`HTTP \${status}\`);
    this.name = "OperateApiError";
    this.status = status;
    this.problem = problem;
  }
}

function buildQuery(query?: QueryParams): string {
  if (query === undefined) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) parts.push(\`\${encodeURIComponent(k)}=\${encodeURIComponent(String(v))}\`);
  }
  return parts.length > 0 ? \`?\${parts.join("&")}\` : "";
}`;

/**
 * Emits the complete self-contained TypeScript client module for a served
 * OpenAPI document: the preamble (transport types + helpers), an interface/type
 * per component schema, and the `createOperateClient` factory with a method per
 * operation. Deterministic — the same document always yields the same source.
 */
export function emitOperateClientModule(doc: OpenApiDocument, options: EmitClientOptions = {}): string {
  const clientName = options.clientName ?? DEFAULT_CLIENT_NAME;
  const schemas = doc.components?.schemas ?? {};

  const interfaces = Object.entries(schemas)
    .map(([name, schema]) => emitNamedSchema(name, schema))
    .join("\n\n");

  const methods: string[] = [];
  const httpMethods = ["get", "post", "put", "patch", "delete"];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of httpMethods) {
      const op = (item as Record<string, OpenApiOperationObject | undefined>)[method];
      if (op !== undefined) methods.push(emitMethod(method, path, op));
    }
  }

  const factory = `export function ${clientName}(options: ClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch;
  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.token !== undefined) headers["authorization"] = \`Bearer \${options.token}\`;
    const res = await doFetch(\`\${options.baseUrl}\${path}\`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined;
    const payload: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw new OperateApiError(res.status, (payload ?? {}) as ProblemDetails);
    return payload;
  }
  return {
${methods.join("\n")}
  };
}`;

  return `${PREAMBLE}\n\n${interfaces}\n\n${factory}\n`;
}
