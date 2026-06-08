import type {
  DetailModel,
  FormModel,
  TableModel,
  WebAppModel,
} from "@crossengin/operate-web";

/**
 * The serializable state blob the SSR embeds in the page so the client entry can
 * `hydrateRoot` the *exact same* component tree against the server markup, then
 * drive in-page interactions (pagination / sort) without a full reload. It is a
 * discriminated union over the page kind, carrying only the (already redacted)
 * models + data the SSR rendered — so the client never receives a field the
 * caller couldn't see either. All shapes are plain JSON (no functions / class
 * instances).
 */
export type WebPageState =
  | { readonly kind: "app"; readonly app: WebAppModel; readonly basePath: string }
  | {
      readonly kind: "table";
      readonly app: WebAppModel;
      readonly table: TableModel;
      readonly rows: readonly Readonly<Record<string, unknown>>[];
      readonly nextCursor: string | null;
      readonly basePath: string;
    }
  | {
      readonly kind: "detail";
      readonly app: WebAppModel;
      readonly detail: DetailModel;
      readonly record: Readonly<Record<string, unknown>>;
      readonly basePath: string;
    }
  | {
      readonly kind: "form";
      readonly app: WebAppModel;
      readonly form: FormModel;
      readonly basePath: string;
    };

/** The global the SSR assigns the serialized state to (read by the client entry). */
export const PAGE_STATE_GLOBAL = "__OPERATE_WEB_STATE__";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const SCRIPT_UNSAFE = new RegExp(`[<>${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, "g");
const SCRIPT_ESCAPES: Readonly<Record<string, string>> = {
  "<": "\\u003c",
  ">": "\\u003e",
  [LINE_SEPARATOR]: "\\u2028",
  [PARAGRAPH_SEPARATOR]: "\\u2029",
};

/**
 * Serializes a `WebPageState` to a JSON string safe to embed inside an inline
 * `<script>` element. The only character sequences that can break out of a
 * `<script>` body are `</script>` and (in some HTML parsers) `<!--`, so we
 * escape every `<` and `>` to their `<` / `>` JSON escapes — these stay
 * valid JSON (so `parsePageState` round-trips) but can never form a closing tag.
 * We also escape U+2028 / U+2029, which are literal line terminators in a script
 * body and would break the embedded JS.
 */
export function serializePageState(state: WebPageState): string {
  return JSON.stringify(state).replace(SCRIPT_UNSAFE, (ch) => SCRIPT_ESCAPES[ch] ?? ch);
}

/** Parses a serialized page-state string back into a `WebPageState`. */
export function parsePageState(raw: string): WebPageState {
  return JSON.parse(raw) as WebPageState;
}

/** Options for `buildListQueryUrl` — the optional cursor + sort the client reuses. */
export interface ListQueryUrlOptions {
  readonly cursor?: string | null;
  readonly sort?: string;
  readonly order?: "asc" | "desc";
}

/**
 * Builds the `/ui/:entity` JSON URL the hydrated table fetches for pagination +
 * sort — reusing the existing read-only JSON endpoints (no new server routes).
 * The entity name is path-encoded; cursor / sort / order ride as query params.
 */
export function buildListQueryUrl(entity: string, options: ListQueryUrlOptions = {}): string {
  const params = new URLSearchParams();
  if (options.cursor !== undefined && options.cursor !== null && options.cursor.length > 0) {
    params.set("cursor", options.cursor);
  }
  if (options.sort !== undefined && options.sort.length > 0) {
    params.set("sort", options.sort);
    params.set("order", options.order ?? "asc");
  }
  const qs = params.toString();
  return `/ui/${encodeURIComponent(entity)}${qs.length > 0 ? `?${qs}` : ""}`;
}
