import type { OpenApiDocument, OpenApiOperationObject, OpenApiResponse } from "./openapi.js";
import type { OpenApiSchema } from "./schemas.js";

/**
 * A pure, deterministic OpenAPI 3.1 → **PHP** client emitter (P3.44) — the
 * fourth-language sibling of the TS (P3.38) / Python (P3.40) / Go (P3.41) emitters,
 * driven off the same `OpenApiDocument`. It produces one self-contained `.php` file
 * (PHP **8.1+**, stdlib only — `curl` + `json`): a class per object schema (typed
 * readonly promoted properties + a `fromArray` hydrator) + an `OperateClient` class
 * with a method per operation. No third-party dependency (no Guzzle/Jackson-style lib).
 */
export interface EmitPhpClientOptions {
  /** The emitted client class name (default `OperateClient`). */
  readonly className?: string;
}

const DEFAULT_CLASS_NAME = "OperateClient";

/** `#/components/schemas/Product` → `Product`. */
function refName(ref: string): string {
  const i = ref.lastIndexOf("/");
  return i >= 0 ? ref.slice(i + 1) : ref;
}

/** `product.list` / `salesOrder.create` → `productList` / `salesOrderCreate`. */
export function phpMethodName(operationId: string): string {
  const parts = operationId.split(/[._\-/]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "op";
  return parts.map((p, i) => (i === 0 ? p[0]!.toLowerCase() + p.slice(1) : p[0]!.toUpperCase() + p.slice(1))).join("");
}

/** The `{param}` placeholders in a path template, in order. */
function pathParamNames(path: string): readonly string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

const SCALAR: Readonly<Record<string, string>> = {
  string: "string",
  integer: "int",
  number: "float",
  boolean: "bool",
};

/** A JSON-Schema (subset) → a PHP type hint (without the nullable `?` prefix). */
export function schemaToPhpType(schema: OpenApiSchema | undefined): string {
  if (schema === undefined) return "mixed";
  if (schema.$ref !== undefined) return refName(schema.$ref);
  if (schema.oneOf !== undefined) return "array";
  if (schema.enum !== undefined) return "string";

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const base = types.find((t) => t !== "null");
  if (base !== undefined && SCALAR[base] !== undefined) return SCALAR[base]!;
  if (base === "array") return "array";
  if (base === "object" || schema.properties !== undefined || schema.additionalProperties !== undefined) return "array";
  return "mixed";
}

/** A nullable PHP property type (`mixed` is already nullable; everything else gets `?`). */
function nullablePhp(phpType: string): string {
  return phpType === "mixed" ? "mixed" : `?${phpType}`;
}

/** Emits a `class` for one named object schema (lenient: all props nullable, so redaction never breaks hydration). */
function emitNamedPhpClass(name: string, schema: OpenApiSchema): string | null {
  if (schema.properties === undefined) return null; // oneOf/alias schemas are plain arrays in PHP
  const entries = Object.entries(schema.properties);
  const ctorParams = entries.map(([key, child]) => `        public readonly ${nullablePhp(schemaToPhpType(child))} $${key} = null,`);
  const hydrate = entries.map(([key]) => `            ${key}: $d[${JSON.stringify(key)}] ?? null,`);
  return [
    `final class ${name}`,
    `{`,
    `    public function __construct(`,
    ...ctorParams,
    `    ) {}`,
    ``,
    `    /** @param array<string,mixed> $d */`,
    `    public static function fromArray(array $d): self`,
    `    {`,
    `        return new self(`,
    ...hydrate,
    `        );`,
    `    }`,
    `}`,
  ].join("\n");
}

/** The success response of an operation (200 → 201 → 204), or undefined. */
function successResponse(op: OpenApiOperationObject): { readonly status: string; readonly response: OpenApiResponse } | undefined {
  for (const status of ["200", "201", "204"]) {
    const response = op.responses[status];
    if (response !== undefined) return { status, response };
  }
  return undefined;
}

/** The return: a hydrated class name (with `hydrate=true`), `array`, or `void`. */
function returnInfoFor(op: OpenApiOperationObject): { readonly type: string; readonly hydrateClass: string | null } {
  const success = successResponse(op);
  if (success === undefined || success.status === "204") return { type: "void", hydrateClass: null };
  const schema = success.response.content?.["application/json"]?.schema;
  if (schema === undefined) return { type: "void", hydrateClass: null };
  if (schema.$ref !== undefined) {
    const cls = refName(schema.$ref);
    return { type: cls, hydrateClass: cls };
  }
  return { type: "array", hydrateClass: null }; // list envelope / report / object → decoded array
}

/** Emits one client method. */
function emitMethod(method: string, path: string, op: OpenApiOperationObject): string {
  const params = pathParamNames(path);
  const hasBody = op.requestBody?.content["application/json"]?.schema !== undefined;
  const ret = returnInfoFor(op);

  const args: string[] = params.map((p) => `string $${p}`);
  if (hasBody) args.push("array $body");
  args.push("array $query = []");

  // PHP path expression: '/v1/products/' . rawurlencode($id) . '' . $this->query($query)
  const tmpl = path.replace(/\{([^}]+)\}/g, (_m, p: string) => `' . rawurlencode($${p}) . '`);
  const pathExpr = `'${tmpl}' . $this->query($query)`;
  const bodyArg = hasBody ? "$body" : "null";
  const call = `$this->request('${method.toUpperCase()}', ${pathExpr}, ${bodyArg})`;

  const body =
    ret.hydrateClass !== null
      ? `        return ${ret.hydrateClass}::fromArray(${call});`
      : ret.type === "void"
        ? `        ${call};`
        : `        return ${call};`;

  return [`    public function ${phpMethodName(op.operationId)}(${args.join(", ")}): ${ret.type}`, `    {`, body, `    }`].join("\n");
}

const PREAMBLE = `<?php

// GENERATED by operate-server \`openapi-client --lang php\` — do not edit by hand.
// A typed stdlib client (PHP 8.1+, curl + json) projected from the served OpenAPI 3.1 document.

declare(strict_types=1);

final class OperateApiError extends \\RuntimeException
{
    /** @param mixed $problem */
    public function __construct(public readonly int $status, public readonly mixed $problem)
    {
        parent::__construct("operate: HTTP {$status}");
    }
}`;

/**
 * Emits the complete self-contained PHP client file for a served OpenAPI document:
 * the preamble (error type), a class per object schema, and the client class with a
 * method per operation. Deterministic — the same document always yields the same source.
 */
export function emitOperatePhpClient(doc: OpenApiDocument, options: EmitPhpClientOptions = {}): string {
  const className = options.className ?? DEFAULT_CLASS_NAME;
  const schemas = doc.components?.schemas ?? {};

  const classes = Object.entries(schemas)
    .map(([name, schema]) => emitNamedPhpClass(name, schema))
    .filter((c): c is string => c !== null)
    .join("\n\n");

  const methods: string[] = [];
  const httpMethods = ["get", "post", "put", "patch", "delete"];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of httpMethods) {
      const op = (item as Record<string, OpenApiOperationObject | undefined>)[method];
      if (op !== undefined) methods.push(emitMethod(method, path, op));
    }
  }

  const clientClass = `final class ${className}
{
    public function __construct(
        private readonly string $baseUrl,
        private readonly ?string $token = null,
    ) {}

    /** @param array<string,scalar> $query */
    private function query(array $query): string
    {
        return $query === [] ? '' : '?' . http_build_query($query);
    }

    /**
     * @param array<string,mixed>|null $body
     * @return mixed
     */
    private function request(string $method, string $path, ?array $body = null): mixed
    {
        $ch = curl_init(rtrim($this->baseUrl, '/') . $path);
        $headers = ['Accept: application/json'];
        $opts = [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method];
        if ($body !== null) {
            $opts[CURLOPT_POSTFIELDS] = json_encode($body);
            $headers[] = 'Content-Type: application/json';
        }
        if ($this->token !== null) {
            $headers[] = 'Authorization: Bearer ' . $this->token;
        }
        $opts[CURLOPT_HTTPHEADER] = $headers;
        curl_setopt_array($ch, $opts);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($status >= 400) {
            $problem = is_string($raw) ? json_decode($raw, true) : null;
            throw new OperateApiError($status, $problem);
        }
        if ($status === 204 || !is_string($raw) || $raw === '') {
            return null;
        }
        return json_decode($raw, true);
    }

${methods.join("\n\n")}
}`;

  return `${PREAMBLE}\n\n${classes}\n\n${clientClass}\n`;
}
