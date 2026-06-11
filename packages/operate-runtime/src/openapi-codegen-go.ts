import type { OpenApiDocument, OpenApiOperationObject, OpenApiResponse } from "./openapi.js";
import type { OpenApiSchema } from "./schemas.js";

/**
 * A pure, deterministic OpenAPI 3.1 → **Go** client emitter (P3.41) — the
 * third-language sibling of the TypeScript (P3.38) + Python (P3.40) emitters,
 * driven off the same `OpenApiDocument`. It produces one self-contained `.go` file
 * (Go 1.18+, stdlib only — `net/http` + `encoding/json`): a struct per object
 * schema + a `Client` with an exported method per operation. No third-party
 * dependency.
 */
export interface EmitGoClientOptions {
  /** The emitted Go package name (default `operateclient`). */
  readonly packageName?: string;
}

const DEFAULT_PACKAGE = "operateclient";

/** `#/components/schemas/Product` → `Product`. */
function refName(ref: string): string {
  const i = ref.lastIndexOf("/");
  return i >= 0 ? ref.slice(i + 1) : ref;
}

/** `unit_cost` / `salesOrder` → `UnitCost` / `SalesOrder` (exported Go identifier). */
function goExportName(name: string): string {
  return name
    .split(/[._\-/\s]+/)
    .flatMap((seg) => seg.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
}

/** `product.list` / `salesOrder.create` → `ProductList` / `SalesOrderCreate`. */
export function goMethodName(operationId: string): string {
  return goExportName(operationId);
}

/** The `{param}` placeholders in a path template, in order. */
function pathParamNames(path: string): readonly string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

const SCALAR: Readonly<Record<string, string>> = {
  string: "string",
  integer: "int",
  number: "float64",
  boolean: "bool",
};

/** A JSON-Schema (subset) → a Go type expression. */
export function schemaToGoType(schema: OpenApiSchema | undefined): string {
  if (schema === undefined) return "interface{}";
  if (schema.$ref !== undefined) return refName(schema.$ref);
  if (schema.oneOf !== undefined) return "json.RawMessage";

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const base = types.find((t) => t !== "null");

  if (schema.enum !== undefined) return "string"; // Go has no native enum
  if (base !== undefined && SCALAR[base] !== undefined) return SCALAR[base]!;
  if (base === "array") return `[]${schemaToGoType(schema.items)}`;
  if (base === "object" || schema.properties !== undefined || schema.additionalProperties !== undefined) {
    return "map[string]interface{}";
  }
  return "interface{}";
}

/** Whether a Go type takes a pointer to express "optional" (scalars/structs do; slices/maps/raw don't). */
function needsPointer(goType: string): boolean {
  return !(goType.startsWith("[]") || goType.startsWith("map[") || goType === "json.RawMessage" || goType === "interface{}");
}

/** Emits a `struct`/alias for one named component schema. */
function emitNamedGoType(name: string, schema: OpenApiSchema): string {
  if (schema.oneOf !== undefined || schema.properties === undefined) {
    return `type ${name} = ${schemaToGoType(schema)}`;
  }
  const required = new Set(schema.required ?? []);
  const cols = Object.entries(schema.properties).map(([key, child]) => {
    const base = schemaToGoType(child);
    const optional = !required.has(key);
    const goType = optional && needsPointer(base) ? `*${base}` : base;
    const tag = optional ? `\`json:"${key},omitempty"\`` : `\`json:"${key}"\``;
    return { field: goExportName(key), goType, tag };
  });
  // gofmt-style column alignment: pad the name + type columns with spaces.
  const maxName = Math.max(0, ...cols.map((c) => c.field.length));
  const maxType = Math.max(0, ...cols.map((c) => c.goType.length));
  const fields = cols.map((c) => `\t${c.field.padEnd(maxName)} ${c.goType.padEnd(maxType)} ${c.tag}`);
  return `type ${name} struct {\n${fields.join("\n")}\n}`;
}

/** The success response of an operation (200 → 201 → 204), or undefined. */
function successResponse(op: OpenApiOperationObject): { readonly status: string; readonly response: OpenApiResponse } | undefined {
  for (const status of ["200", "201", "204"]) {
    const response = op.responses[status];
    if (response !== undefined) return { status, response };
  }
  return undefined;
}

/** The Go return type of an operation, or null for a no-content (204) operation. */
function returnTypeFor(op: OpenApiOperationObject): string | null {
  const success = successResponse(op);
  if (success === undefined || success.status === "204") return null;
  const schema = success.response.content?.["application/json"]?.schema;
  if (schema === undefined) return null;
  const items = schema.properties?.["data"]?.items;
  if (schema.properties?.["data"] !== undefined) return `ListResult[${schemaToGoType(items)}]`;
  return schemaToGoType(schema);
}

function bodyTypeFor(op: OpenApiOperationObject): string | undefined {
  const schema = op.requestBody?.content["application/json"]?.schema;
  return schema === undefined ? undefined : schemaToGoType(schema);
}

/** Builds the Go path expression: `"/v1/products/" + url.PathEscape(id) + ...` + query. */
function pathExpr(path: string): string {
  // No spaces around `+` so the output is gofmt-clean.
  const quoted = `"${path.replace(/\{([^}]+)\}/g, (_m, p: string) => `"+url.PathEscape(${p})+"`)}"`;
  return `${quoted}+buildQuery(query)`;
}

/** Emits one client method. */
function emitMethod(method: string, path: string, op: OpenApiOperationObject): string {
  const params = pathParamNames(path);
  const bodyType = bodyTypeFor(op);
  const ret = returnTypeFor(op);

  const args: string[] = [...params.map((p) => `${p} string`)];
  if (bodyType !== undefined) args.push(`body ${bodyType}`);
  args.push("query url.Values");

  const name = goMethodName(op.operationId);
  const verb = JSON.stringify(method.toUpperCase());
  const bodyArg = bodyType !== undefined ? "body" : "nil";

  if (ret === null) {
    return `func (c *Client) ${name}(${args.join(", ")}) error {\n\treturn c.request(${verb}, ${pathExpr(path)}, ${bodyArg}, nil)\n}`;
  }
  return [
    `func (c *Client) ${name}(${args.join(", ")}) (${ret}, error) {`,
    `\tvar out ${ret}`,
    `\terr := c.request(${verb}, ${pathExpr(path)}, ${bodyArg}, &out)`,
    `\treturn out, err`,
    `}`,
  ].join("\n");
}

function preamble(pkg: string): string {
  return `// GENERATED by operate-server \`openapi-client --lang go\` — do not edit by hand.
// A typed stdlib client projected from the served OpenAPI 3.1 document.

package ${pkg}

import (
\t"bytes"
\t"encoding/json"
\t"fmt"
\t"io"
\t"net/http"
\t"net/url"
)

// Client is a typed client for the operate API.
type Client struct {
\tBaseURL string
\tToken   string
\tHTTP    *http.Client
}

// Page is the keyset pagination envelope returned by list operations.
type Page struct {
\tLimit      *int    \`json:"limit,omitempty"\`
\tNextCursor *string \`json:"nextCursor,omitempty"\`
}

// ListResult is the envelope returned by list operations.
type ListResult[T any] struct {
\tData []T  \`json:"data"\`
\tPage Page \`json:"page"\`
}

// APIError is returned for a non-2xx response; Problem carries the RFC 9457 body.
type APIError struct {
\tStatus  int
\tProblem json.RawMessage
}

func (e *APIError) Error() string { return fmt.Sprintf("operate: HTTP %d", e.Status) }

func buildQuery(q url.Values) string {
\tif len(q) == 0 {
\t\treturn ""
\t}
\treturn "?" + q.Encode()
}

func (c *Client) request(method, path string, body any, out any) error {
\tvar rdr io.Reader
\tif body != nil {
\t\tb, err := json.Marshal(body)
\t\tif err != nil {
\t\t\treturn err
\t\t}
\t\trdr = bytes.NewReader(b)
\t}
\treq, err := http.NewRequest(method, c.BaseURL+path, rdr)
\tif err != nil {
\t\treturn err
\t}
\treq.Header.Set("accept", "application/json")
\tif body != nil {
\t\treq.Header.Set("content-type", "application/json")
\t}
\tif c.Token != "" {
\t\treq.Header.Set("authorization", "Bearer "+c.Token)
\t}
\thttpc := c.HTTP
\tif httpc == nil {
\t\thttpc = http.DefaultClient
\t}
\tresp, err := httpc.Do(req)
\tif err != nil {
\t\treturn err
\t}
\tdefer resp.Body.Close()
\tdata, err := io.ReadAll(resp.Body)
\tif err != nil {
\t\treturn err
\t}
\tif resp.StatusCode >= 400 {
\t\treturn &APIError{Status: resp.StatusCode, Problem: json.RawMessage(data)}
\t}
\tif resp.StatusCode == 204 || len(data) == 0 || out == nil {
\t\treturn nil
\t}
\treturn json.Unmarshal(data, out)
}`;
}

/**
 * Emits the complete self-contained Go client file for a served OpenAPI document:
 * the package + stdlib transport, a struct/alias per component schema, and the
 * `Client` methods. Deterministic — the same document always yields the same source.
 */
export function emitOperateGoClient(doc: OpenApiDocument, options: EmitGoClientOptions = {}): string {
  const pkg = options.packageName ?? DEFAULT_PACKAGE;
  const schemas = doc.components?.schemas ?? {};

  const types = Object.entries(schemas)
    .map(([name, schema]) => emitNamedGoType(name, schema))
    .join("\n\n");

  const methods: string[] = [];
  const httpMethods = ["get", "post", "put", "patch", "delete"];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of httpMethods) {
      const op = (item as Record<string, OpenApiOperationObject | undefined>)[method];
      if (op !== undefined) methods.push(emitMethod(method, path, op));
    }
  }

  return `${preamble(pkg)}\n\n${types}\n\n${methods.join("\n\n")}\n`;
}
