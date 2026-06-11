import type { OpenApiDocument, OpenApiOperationObject, OpenApiResponse } from "./openapi.js";
import type { OpenApiSchema } from "./schemas.js";

/**
 * A pure, deterministic OpenAPI 3.1 → **Python** client emitter (P3.40) — the
 * second-language sibling of the TypeScript emitter (P3.38), driven off the same
 * `OpenApiDocument`. It produces one self-contained `.py` module (Python 3.11+,
 * stdlib only — `urllib` + `json`): a `TypedDict` per object schema + a
 * `OperateClient` class with a snake_case method per operation. No third-party
 * dependency (no `requests`/`pydantic`).
 */
export interface EmitPythonClientOptions {
  /** The emitted client class name (default `OperateClient`). */
  readonly className?: string;
}

const DEFAULT_CLASS_NAME = "OperateClient";

/** `#/components/schemas/Product` → `Product`. */
function refName(ref: string): string {
  const i = ref.lastIndexOf("/");
  return i >= 0 ? ref.slice(i + 1) : ref;
}

/** `salesOrder` → `sales_order`. */
function camelToSnake(part: string): string {
  return part.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** `salesOrder.create` / `product.list` → `sales_order_create` / `product_list`. */
export function pythonMethodName(operationId: string): string {
  return operationId
    .split(/[._\-/]+/)
    .filter((p) => p.length > 0)
    .map(camelToSnake)
    .join("_");
}

/** The `{param}` placeholders in a path template, in order. */
function pathParamNames(path: string): readonly string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

const SCALAR: Readonly<Record<string, string>> = {
  string: "str",
  integer: "int",
  number: "float",
  boolean: "bool",
};

/** A JSON-Schema (subset) → a Python type expression (3.11 idioms). */
export function schemaToPyType(schema: OpenApiSchema | undefined): string {
  if (schema === undefined) return "Any";
  if (schema.$ref !== undefined) return refName(schema.$ref);
  if (schema.oneOf !== undefined) return "dict[str, Any]"; // union of object variants → an open dict

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = types.includes("null");
  const base = types.find((t) => t !== "null");

  let py: string;
  if (schema.enum !== undefined) {
    const members = schema.enum.filter((v): v is string => v !== null);
    py = members.length > 0 ? `Literal[${members.map((v) => JSON.stringify(v)).join(", ")}]` : "Any";
  } else if (base !== undefined && SCALAR[base] !== undefined) {
    py = SCALAR[base]!;
  } else if (base === "array") {
    py = `list[${schemaToPyType(schema.items)}]`;
  } else if (base === "object" || schema.properties !== undefined || schema.additionalProperties !== undefined) {
    py = "dict[str, Any]";
  } else {
    py = "Any";
  }
  return nullable ? `${py} | None` : py;
}

/** A safe TypedDict key uses class syntax only for identifier keys; else functional syntax. */
function isIdentifier(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** Emits a `TypedDict`/alias for one named component schema. */
function emitNamedPyType(name: string, schema: OpenApiSchema): string {
  if (schema.oneOf !== undefined || schema.properties === undefined) {
    return `${name} = ${schemaToPyType(schema)}`;
  }
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(schema.properties);
  // Functional TypedDict syntax when any key isn't a valid identifier.
  if (!entries.every(([k]) => isIdentifier(k))) {
    const fields = entries
      .map(([k, child]) => {
        const t = schemaToPyType(child);
        return `${JSON.stringify(k)}: ${required.has(k) ? t : `NotRequired[${t}]`}`;
      })
      .join(", ");
    return `${name} = TypedDict(${JSON.stringify(name)}, {${fields}})`;
  }
  const lines = entries.map(([k, child]) => {
    const t = schemaToPyType(child);
    return `    ${k}: ${required.has(k) ? t : `NotRequired[${t}]`}`;
  });
  return `class ${name}(TypedDict):\n${lines.length > 0 ? lines.join("\n") : "    pass"}`;
}

/** The success response of an operation (200 → 201 → 204), or undefined. */
function successResponse(op: OpenApiOperationObject): { readonly status: string; readonly response: OpenApiResponse } | undefined {
  for (const status of ["200", "201", "204"]) {
    const response = op.responses[status];
    if (response !== undefined) return { status, response };
  }
  return undefined;
}

/** The Python return type of an operation. */
function returnTypeFor(op: OpenApiOperationObject): string {
  const success = successResponse(op);
  if (success === undefined || success.status === "204") return "None";
  const schema = success.response.content?.["application/json"]?.schema;
  if (schema === undefined) return "None";
  if (schema.properties?.["data"] !== undefined) return "ListResult"; // list envelope
  return schemaToPyType(schema);
}

function bodyTypeFor(op: OpenApiOperationObject): string | undefined {
  const schema = op.requestBody?.content["application/json"]?.schema;
  return schema === undefined ? undefined : schemaToPyType(schema);
}

/** Emits one client method. */
function emitMethod(method: string, path: string, op: OpenApiOperationObject): string {
  const params = pathParamNames(path);
  const bodyType = bodyTypeFor(op);
  const ret = returnTypeFor(op);

  const args: string[] = ["self", ...params.map((p) => `${p}: str`)];
  if (bodyType !== undefined) args.push(`body: ${bodyType}`);
  args.push("query: dict | None = None");

  const tmpl = path.replace(/\{([^}]+)\}/g, (_m, p: string) => `{urllib.parse.quote(str(${p}))}`);
  const bodyArg = bodyType !== undefined ? ", body" : "";
  const call = `self._request(${JSON.stringify(method.toUpperCase())}, f"${tmpl}{_build_query(query)}"${bodyArg})`;

  return `    def ${pythonMethodName(op.operationId)}(${args.join(", ")}) -> ${ret}:\n        return ${call}  # type: ignore[return-value]`;
}

const PREAMBLE = `"""GENERATED by operate-server \`openapi-client --lang python\` — do not edit by hand.

A typed stdlib client (Python 3.11+) projected from the served OpenAPI 3.1 document.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Literal, NotRequired, TypedDict

ListResult = TypedDict("ListResult", {"data": list, "page": dict})


class OperateApiError(Exception):
    def __init__(self, status: int, problem: Any) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status
        self.problem = problem


def _build_query(query: dict | None) -> str:
    if not query:
        return ""
    pairs = [(k, str(v)) for k, v in query.items() if v is not None]
    return ("?" + urllib.parse.urlencode(pairs)) if pairs else ""`;

/**
 * Emits the complete self-contained Python client module for a served OpenAPI
 * document: the preamble (stdlib transport + helpers), a `TypedDict`/alias per
 * component schema, and the client class with a method per operation.
 * Deterministic — the same document always yields the same source.
 */
export function emitOperatePythonClient(doc: OpenApiDocument, options: EmitPythonClientOptions = {}): string {
  const className = options.className ?? DEFAULT_CLASS_NAME;
  const schemas = doc.components?.schemas ?? {};

  const types = Object.entries(schemas)
    .map(([name, schema]) => emitNamedPyType(name, schema))
    .join("\n\n\n");

  const methods: string[] = [];
  const httpMethods = ["get", "post", "put", "patch", "delete"];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of httpMethods) {
      const op = (item as Record<string, OpenApiOperationObject | undefined>)[method];
      if (op !== undefined) methods.push(emitMethod(method, path, op));
    }
  }

  const clientClass = `class ${className}:
    def __init__(self, base_url: str, token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _request(self, method: str, path: str, body: Any | None = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("accept", "application/json")
        if body is not None:
            req.add_header("content-type", "application/json")
        if self.token:
            req.add_header("authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req) as resp:
                if resp.status == 204:
                    return None
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            problem: Any = None
            try:
                problem = json.loads(err.read())
            except Exception:
                pass
            raise OperateApiError(err.code, problem) from err

${methods.join("\n\n")}`;

  return `${PREAMBLE}\n\n\n${types}\n\n\n${clientClass}\n`;
}
