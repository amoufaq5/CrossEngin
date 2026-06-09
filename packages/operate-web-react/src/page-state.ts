import type {
  CalendarModel,
  DetailModel,
  FormModel,
  KanbanModel,
  KanbanTransitionModel,
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
      /** Whether the caller may PATCH this record (drives the Edit affordance). */
      readonly canEdit: boolean;
      /** Whether the caller may DELETE this record (drives the Delete affordance). */
      readonly canDelete: boolean;
    }
  | {
      readonly kind: "form";
      readonly app: WebAppModel;
      readonly form: FormModel;
      readonly basePath: string;
      /** Present for an edit form (the PATCH target id); absent → a create form (POST). */
      readonly entityId?: string;
      /** Prefill values for an edit form (the redacted record). */
      readonly values?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "kanban";
      readonly app: WebAppModel;
      readonly kanban: KanbanModel;
      readonly rows: readonly Readonly<Record<string, unknown>>[];
      readonly basePath: string;
    }
  | {
      readonly kind: "calendar";
      readonly app: WebAppModel;
      readonly calendar: CalendarModel;
      readonly rows: readonly Readonly<Record<string, unknown>>[];
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

/**
 * Builds the `/ui/:entity[/:id]` JSON URL the hydrated form/detail posts a write
 * to — the P3.8 write routes. With an `id` it targets a single record
 * (PATCH/DELETE); without, the collection (POST create).
 */
export function buildWriteUrl(entity: string, id?: string | null): string {
  const base = `/ui/${encodeURIComponent(entity)}`;
  return id !== undefined && id !== null && id.length > 0 ? `${base}/${encodeURIComponent(id)}` : base;
}

/**
 * Adds the `__state=1` query flag to an `/app/*` href so the server returns the
 * `WebPageState` as JSON (for SPA navigation) instead of a full HTML page,
 * preserving any existing query params. Accepts a path or absolute URL.
 */
export function appStateUrl(href: string): string {
  const url = new URL(href, "http://placeholder.invalid");
  url.searchParams.set("__state", "1");
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs.length > 0 ? `?${qs}` : ""}`;
}

/** Fetches a page's `WebPageState` (the `?__state=1` JSON); injectable for tests. */
export type PageStateFetcher = (url: string) => Promise<WebPageState>;

const defaultPageStateFetcher: PageStateFetcher = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`page-state fetch failed: ${res.status.toString()}`);
  return (await res.json()) as WebPageState;
};

/** Fetches the `WebPageState` for an `/app/*` href via its `?__state=1` JSON form. */
export async function fetchPageState(
  href: string,
  fetcher: PageStateFetcher = defaultPageStateFetcher,
): Promise<WebPageState> {
  return fetcher(appStateUrl(href));
}

/**
 * Decides whether an in-page navigation to `href` should be handled by the SPA
 * router (a same-origin `/app/...` link) rather than a full browser navigation.
 * External links, downloads, and non-`/app` paths fall through to the browser.
 */
export function isInternalAppHref(href: string, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  return url.pathname === "/app" || url.pathname.startsWith("/app/");
}

/**
 * Coerces raw form values (strings from inputs, booleans from checkboxes) into a
 * typed write payload per the form model's field render hints. Read-only fields
 * are dropped (the server would 422 them anyway, and the control is disabled);
 * an empty non-required string field is omitted (so a blank optional field
 * isn't sent as `""`); number hints parse to a `number` (a non-numeric or empty
 * value is dropped); boolean hints become a real boolean. Unknown keys (not a
 * model field) are ignored — the write mask is enforced server-side regardless.
 */
export function coerceFormValues(
  model: FormModel,
  raw: Readonly<Record<string, string | boolean | undefined>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of model.fields) {
    if (field.readOnly) continue;
    const v = raw[field.field];
    if (field.type === "boolean") {
      out[field.field] = v === true || v === "on" || v === "true";
      continue;
    }
    if (v === undefined || v === true) continue;
    if (field.type === "integer" || field.type === "decimal" || field.type === "currency_amount") {
      if (v === "") continue;
      const n = Number(v);
      if (!Number.isNaN(n)) out[field.field] = n;
      continue;
    }
    if (v === "" && !field.required) continue;
    out[field.field] = v;
  }
  return out;
}

/** The outcome of a write (create/update/delete) the hydrated UI submits. */
export interface WriteResult {
  readonly ok: boolean;
  readonly status: number;
  readonly record?: Readonly<Record<string, unknown>>;
  readonly detail?: string;
}

/** Performs one write request; injectable so the form/detail sections test without a network. */
export type WriteFetcher = (
  method: string,
  url: string,
  payload: Record<string, unknown> | null,
) => Promise<WriteResult>;

/** The default `fetch`-backed write fetcher: JSON in/out, reading `{ record }` or a problem `detail`. */
export const defaultWriteFetcher: WriteFetcher = async (method, url, payload) => {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    ...(payload !== null ? { body: JSON.stringify(payload) } : {}),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return {
    ok: res.ok,
    status: res.status,
    ...(json["record"] !== undefined ? { record: json["record"] as Record<string, unknown> } : {}),
    ...(typeof json["detail"] === "string" ? { detail: json["detail"] } : {}),
  };
};

/**
 * Orchestrates a create (no `entityId` → POST) or update (`entityId` → PATCH)
 * write through a `WriteFetcher`. Pure but for the injected fetcher — testable
 * with a fake.
 */
export async function submitFormWrite(args: {
  readonly entity: string;
  readonly entityId?: string | null;
  readonly payload: Record<string, unknown>;
  readonly fetcher: WriteFetcher;
}): Promise<WriteResult> {
  const isEdit = args.entityId !== undefined && args.entityId !== null && args.entityId.length > 0;
  const method = isEdit ? "PATCH" : "POST";
  return args.fetcher(method, buildWriteUrl(args.entity, args.entityId), args.payload);
}

/** Orchestrates a DELETE write through a `WriteFetcher`. */
export async function submitDelete(entity: string, id: string, fetcher: WriteFetcher): Promise<WriteResult> {
  return fetcher("DELETE", buildWriteUrl(entity, id), null);
}

/** Builds the `/ui/:entity/:id/transition` URL the kanban board posts a transition to. */
export function buildTransitionUrl(entity: string, id: string): string {
  return `${buildWriteUrl(entity, id)}/transition`;
}

/**
 * Resolves which kanban transition fires when a card in `fromState` is dropped on
 * the `toState` column: the transition whose `toState` matches the target column
 * and whose `fromStates` includes the card's current state. Returns the
 * transition name, or `null` when no declared transition bridges those states
 * (the drop is a no-op). Pure — the drag UI calls it on drop.
 */
export function planCardTransition(
  transitions: readonly KanbanTransitionModel[],
  fromState: string,
  toState: string,
): string | null {
  if (fromState === toState) return null;
  const match = transitions.find((t) => t.toState === toState && t.fromStates.includes(fromState));
  return match?.name ?? null;
}

/** Orchestrates a transition write (POST /ui/:entity/:id/transition {transition}) through a `WriteFetcher`. */
export async function submitTransition(
  entity: string,
  id: string,
  transition: string,
  fetcher: WriteFetcher,
): Promise<WriteResult> {
  return fetcher("POST", buildTransitionUrl(entity, id), { transition });
}
