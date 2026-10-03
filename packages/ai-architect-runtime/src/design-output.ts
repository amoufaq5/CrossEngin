/**
 * What the model actually produced, as two independent axes.
 *
 * `shape` is what the payload *is*; `wrapper` is how it was *delivered*. Keeping them
 * apart is what makes a fenced manifest and a fenced array land in different places
 * instead of collapsing into one "bad output" bucket.
 */
export const DESIGN_OUTPUT_SHAPES = [
  "empty",
  "no_json",
  "truncated_json",
  "malformed_json",
  "array_not_object",
  "scalar_not_object",
  "object_not_manifest",
  "manifest_shaped_object",
] as const;
export type DesignOutputShape = (typeof DESIGN_OUTPUT_SHAPES)[number];

export const DESIGN_OUTPUT_WRAPPERS = ["none", "code_fence", "surrounding_prose"] as const;
export type DesignOutputWrapper = (typeof DESIGN_OUTPUT_WRAPPERS)[number];

export interface DesignOutputDiagnosis {
  readonly shape: DesignOutputShape;
  readonly wrapper: DesignOutputWrapper;
  /**
   * The recovered top-level object — set for `manifest_shaped_object` and
   * `object_not_manifest`, `null` for every other shape.
   */
  readonly object: Record<string, unknown> | null;
  readonly detail: string;
}

export interface ClassifyDesignOutputOptions {
  /**
   * Overrides "does this object look like an attempt at a manifest?". The default is
   * `looksLikeManifest`; a caller with a different target document supplies its own.
   */
  readonly recognize?: (object: Record<string, unknown>) => boolean;
}

/**
 * Whether an object is an *attempt* at a manifest — not whether it is a valid one.
 * The manifest schema is the only authority on validity; this predicate exists so
 * "the model answered a different question" (`object_not_manifest`) stays separable
 * from "the model tried and got the details wrong" (a schema rejection).
 */
export function looksLikeManifest(object: Record<string, unknown>): boolean {
  if (object["entities"] !== undefined) return true;
  return object["meta"] !== undefined && object["manifestVersion"] !== undefined;
}

const FENCE = "```";

interface FenceExtraction {
  readonly fenced: boolean;
  readonly body: string;
}

function extractFenced(text: string): FenceExtraction {
  const open = text.indexOf(FENCE);
  if (open === -1) return { fenced: false, body: text };
  // The opening fence may carry an info string (```json); the body starts after that line.
  const afterInfo = text.indexOf("\n", open + FENCE.length);
  const bodyStart = afterInfo === -1 ? open + FENCE.length : afterInfo + 1;
  const close = text.indexOf(FENCE, bodyStart);
  // An unclosed fence is still a fence: the model's reply was cut off inside it, and the
  // body up to EOF is what there is to classify (very likely `truncated_json`).
  return { fenced: true, body: close === -1 ? text.slice(bodyStart) : text.slice(bodyStart, close) };
}

type BalanceResult =
  | { readonly kind: "balanced"; readonly end: number }
  | { readonly kind: "unbalanced" };

/** Walks from `start` (an opening `{` or `[`) to its matching close, respecting strings. */
function balance(text: string, start: number): BalanceResult {
  const open = text.charAt(start);
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { kind: "balanced", end: i };
    }
  }
  return { kind: "unbalanced" };
}

function wrapperFor(fenced: boolean, body: string, start: number, end: number): DesignOutputWrapper {
  // A fence wins over surrounding prose when both are present: it is the more specific
  // and more actionable signal — the model is formatting for a chat window, and the
  // prompt's "no code fences" line is being ignored.
  if (fenced) return "code_fence";
  const before = body.slice(0, start).trim();
  const after = body.slice(end + 1).trim();
  return before.length > 0 || after.length > 0 ? "surrounding_prose" : "none";
}

/**
 * Classifies one raw model reply. Recovery is limited on purpose: a code fence is
 * *unwrapping*, and prose around a complete JSON value is *locating* — both leave the
 * JSON bytes untouched, so what is parsed is exactly what the model emitted. Repairing
 * malformed JSON (closing a truncated object, deleting a trailing comma, quoting a bare
 * key) is not done at any point, because the repair would have to invent the parts the
 * model failed to produce and the result would be presented as the model's design. A
 * weak model must read as a weak model; `truncated_json` and `malformed_json` are the
 * diagnosis, not a starting point for guesswork.
 */
export function classifyDesignOutput(
  text: string,
  options: ClassifyDesignOutputOptions = {},
): DesignOutputDiagnosis {
  const recognize = options.recognize ?? looksLikeManifest;
  if (text.trim().length === 0) {
    return { shape: "empty", wrapper: "none", object: null, detail: "model returned no output" };
  }

  const { fenced, body } = extractFenced(text);
  const objectStart = body.indexOf("{");
  const arrayStart = body.indexOf("[");
  const hasObject = objectStart !== -1;
  const hasArray = arrayStart !== -1;

  if (!hasObject && !hasArray) {
    const trimmed = body.trim();
    let scalar: unknown;
    try {
      scalar = JSON.parse(trimmed);
    } catch {
      return {
        shape: "no_json",
        wrapper: fenced ? "code_fence" : "none",
        object: null,
        detail: "reply contains no JSON value — the model answered in prose",
      };
    }
    return {
      shape: "scalar_not_object",
      wrapper: fenced ? "code_fence" : "none",
      object: null,
      detail: `top-level JSON value is ${scalar === null ? "null" : typeof scalar}, not an object`,
    };
  }

  // Whichever bracket opens first is the top-level value. Reading past an opening `[`
  // to the first `{` inside it would silently pass off one array element as the whole
  // design, which is exactly the misdiagnosis this classifier exists to prevent.
  const topIsArray = hasArray && (!hasObject || arrayStart < objectStart);
  const start = topIsArray ? arrayStart : objectStart;
  const balanced = balance(body, start);

  if (balanced.kind === "unbalanced") {
    // There is no closing bracket, so only the text before the opening one can be prose.
    const leading = body.slice(0, start).trim();
    return {
      shape: "truncated_json",
      wrapper: fenced ? "code_fence" : leading.length > 0 ? "surrounding_prose" : "none",
      object: null,
      detail: `JSON ${topIsArray ? "array" : "object"} opens but never closes — the response was cut off mid-structure`,
    };
  }

  const wrapper = wrapperFor(fenced, body, start, balanced.end);
  const slice = body.slice(start, balanced.end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (err) {
    return {
      shape: "malformed_json",
      wrapper,
      object: null,
      detail: `brackets balance but the JSON does not parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (Array.isArray(parsed)) {
    return {
      shape: "array_not_object",
      wrapper,
      object: null,
      detail: `top-level JSON value is an array of ${String(parsed.length)} item(s), not a single manifest object`,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      shape: "scalar_not_object",
      wrapper,
      object: null,
      detail: `top-level JSON value is ${parsed === null ? "null" : typeof parsed}, not an object`,
    };
  }

  const object = parsed as Record<string, unknown>;
  if (!recognize(object)) {
    return {
      shape: "object_not_manifest",
      wrapper,
      object,
      detail: `JSON object has no manifest keys (saw ${Object.keys(object).slice(0, 8).join(", ")})`,
    };
  }
  return { shape: "manifest_shaped_object", wrapper, object, detail: "manifest-shaped JSON object" };
}

/** True when the reply could not be read as a design at all, however it was wrapped. */
export function isUnreadableDesignOutput(shape: DesignOutputShape): boolean {
  return shape !== "manifest_shaped_object";
}
