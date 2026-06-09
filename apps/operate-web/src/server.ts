import type { Manifest } from "@crossengin/kernel/manifest";
import {
  InMemoryEntityStore,
  listConfigForEntity,
  manifestRouteSpecs,
  parseFields,
  parseListQuery,
  type EntityStore,
  type TransitionSpec,
} from "@crossengin/operate-runtime";
import {
  EntityFieldResolver,
  compileCalendarModel,
  compileDetailModel,
  compileFormModel,
  compileKanbanModel,
  compileMapModel,
  compileTableModel,
  compileWebApp,
  entityFields,
  redactRecord,
  unwritableFields,
  type CompileOptions,
  type ViewerContext,
} from "@crossengin/operate-web";

import { CLIENT_BUNDLE_PATH, serveClientBundle, type BundleLoader } from "./assets.js";
import {
  renderAppPage,
  renderCalendarPage,
  renderDetailPage,
  renderFormPage,
  renderKanbanPage,
  renderTablePage,
} from "./html.js";
import { jsonResponse, problemResponse, splitTarget, type RawWebRequest, type RawWebResponse } from "./http.js";
import { ApiKeyRegistry, WebPrincipalResolver, type JwtVerifyConfig, type WebViewer } from "./principals.js";

/** The second path segment after `/ui/:entity/` that names a GET sub-route, not a record id. */
const UI_SUBROUTES = new Set(["new", "kanban", "calendar", "map"]);

/** Anything that resolves a request to a viewer (an `ApiKeyRegistry` or a `WebPrincipalResolver`). */
export interface WebViewerResolver {
  resolve(req: RawWebRequest): WebViewer | null | Promise<WebViewer | null>;
}

export interface OperateWebServerOptions {
  readonly manifest: Manifest;
  readonly store?: EntityStore;
  /** Resolves each request to a viewer (api-key and/or JWT); null → 401. */
  readonly resolver: WebViewerResolver;
  readonly compileOptions?: CompileOptions;
  /**
   * Loads the client hydration bundle for `GET /assets/operate-web-client.js`.
   * Defaults to reading it from disk; injectable so a test can stub it (or an
   * edge runtime can serve an embedded bundle). When the load returns null the
   * route 503s with a "run build:client" notice.
   */
  readonly bundleLoader?: BundleLoader;
}

/**
 * The framework-neutral serving core: authenticates each request against the
 * principal resolver (API keys + optional JWT), then serves the redaction-aware
 * view models (and the data behind them) as JSON. Every model + every data row
 * is compiled / redacted for the *caller*, so the JSON never carries a field the
 * viewer can't read.
 *
 * Routes:
 *   GET    /ui/app              -> WebAppModel
 *   GET    /ui/:entity          -> { table, page: { data, nextCursor } }
 *   GET    /ui/:entity/kanban   -> { kanban, page: { data, nextCursor } } (404 if no board)
 *   GET    /ui/:entity/calendar -> { calendar, page: { data, nextCursor } } (404 if none)
 *   GET    /ui/:entity/map      -> { map, page: { data, nextCursor } } (404 if no map view)
 *   GET    /ui/:entity/new      -> { form }
 *   GET    /ui/:entity/:id      -> { detail, record }
 *   POST   /ui/:entity          -> 201 { record } (RBAC create + write-mask)
 *   POST   /ui/:entity/:id/transition -> 200 { record } ({transition}; RBAC + from-state 409)
 *   PATCH  /ui/:entity/:id      -> 200 { record } (RBAC update + write-mask)
 *   DELETE /ui/:entity/:id      -> 204 (RBAC delete)
 *
 * Writes enforce the manifest RBAC grant (403) and the per-field write mask (422
 * on any field the viewer can't set); the returned record is redacted for the
 * caller. `/app/*` HTML pages stay read-only (GET).
 */
export class OperateWebServer {
  private readonly manifest: Manifest;
  private readonly store: EntityStore;
  private readonly resolver: WebViewerResolver;
  private readonly compileOptions: CompileOptions;
  private readonly entityNames: ReadonlySet<string>;
  private readonly bundleLoader: BundleLoader | undefined;

  constructor(options: OperateWebServerOptions) {
    this.manifest = options.manifest;
    this.store = options.store ?? new InMemoryEntityStore();
    this.resolver = options.resolver;
    this.compileOptions = options.compileOptions ?? {};
    this.entityNames = new Set((options.manifest.entities ?? []).map((e) => e.name));
    this.bundleLoader = options.bundleLoader;
  }

  /** Exposes the store so a boot script can seed records for the in-memory case. */
  get entityStore(): EntityStore {
    return this.store;
  }

  async dispatch(req: RawWebRequest): Promise<RawWebResponse> {
    const method = req.method.toUpperCase();
    const { path: rawPath } = splitTarget(req.url);

    // The hydration bundle is a public static asset (it carries no per-caller
    // data — every model + row is redacted *before* it's embedded in the page),
    // so it is served before auth (GET only).
    if (method === "GET" && rawPath === CLIENT_BUNDLE_PATH) {
      return this.bundleLoader !== undefined
        ? serveClientBundle(this.bundleLoader)
        : serveClientBundle();
    }

    if (method !== "GET" && method !== "POST" && method !== "PATCH" && method !== "DELETE") {
      return problemResponse(405, "Method not allowed", `unsupported method ${req.method}`);
    }

    const viewer = await this.resolver.resolve(req);
    if (viewer === null) {
      return problemResponse(401, "Unauthorized", "missing or unknown credential");
    }

    const { path, query } = splitTarget(req.url);
    const segments = path.split("/").filter((s) => s.length > 0);
    const viewerCtx: ViewerContext = { roles: viewer.roles };

    // `/ui/...` serves JSON view models (GET) + entity mutations
    // (POST/PATCH/DELETE); `/app/...` server-renders the same models as HTML
    // pages (GET only — the write path is the JSON API).
    if (segments[0] === "ui") {
      return this.dispatchUi(method, segments.slice(1), path, viewer, viewerCtx, query, req.body ?? null);
    }
    if (segments[0] === "app") {
      if (method !== "GET") {
        return problemResponse(405, "Method not allowed", "/app/* pages are read-only; use the /ui JSON API to mutate");
      }
      return this.dispatchApp(segments.slice(1), path, viewer, viewerCtx, query);
    }
    return problemResponse(404, "Not found", `no route for ${path}`);
  }

  private dispatchUi(
    method: string,
    rest: readonly string[],
    path: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    query: Record<string, string | string[]>,
    body: Uint8Array | null,
  ): RawWebResponse | Promise<RawWebResponse> {
    // Mutations: POST /ui/:entity (create) or /ui/:entity/:id/transition, PATCH/DELETE /ui/:entity/:id.
    if (method === "POST") {
      if (rest.length === 1) return this.serveCreate(rest[0]!, viewer, viewerCtx, body);
      if (rest.length === 3 && rest[2] === "transition") {
        return this.serveTransition(rest[0]!, rest[1]!, viewer, viewerCtx, body);
      }
      return problemResponse(404, "Not found", `cannot POST ${path}`);
    }
    if (method === "PATCH") {
      if (rest.length === 2 && !UI_SUBROUTES.has(rest[1]!)) {
        return this.serveUpdate(rest[0]!, rest[1]!, viewer, viewerCtx, body);
      }
      return problemResponse(404, "Not found", `cannot PATCH ${path}`);
    }
    if (method === "DELETE") {
      if (rest.length === 2 && !UI_SUBROUTES.has(rest[1]!)) {
        return this.serveDelete(rest[0]!, rest[1]!, viewer);
      }
      return problemResponse(404, "Not found", `cannot DELETE ${path}`);
    }

    // Reads (GET).
    if (rest.length === 1 && rest[0] === "app") {
      return jsonResponse(200, compileWebApp(this.manifest, viewerCtx));
    }
    if (rest.length === 1) {
      return this.serveTable(rest[0]!, viewer, viewerCtx, query);
    }
    if (rest.length === 2 && rest[1] === "kanban") {
      return this.serveKanban(rest[0]!, viewer, viewerCtx, query);
    }
    if (rest.length === 2 && rest[1] === "calendar") {
      return this.serveCalendar(rest[0]!, viewer, viewerCtx, query);
    }
    if (rest.length === 2 && rest[1] === "map") {
      return this.serveMap(rest[0]!, viewer, viewerCtx, query);
    }
    if (rest.length === 2 && rest[1] === "new") {
      return this.serveForm(rest[0]!, viewerCtx);
    }
    if (rest.length === 2) {
      return this.serveDetail(rest[0]!, rest[1]!, viewer, viewerCtx);
    }
    return problemResponse(404, "Not found", `no route for ${path}`);
  }

  private dispatchApp(
    rest: readonly string[],
    path: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    query: Record<string, string | string[]>,
  ): RawWebResponse | Promise<RawWebResponse> {
    // `?__state=1` is a SPA-navigation request: return the WebPageState as JSON
    // (the same compiled + redacted models the HTML page embeds) so the client
    // router can swap pages without a full reload.
    const stateOnly = query["__state"] === "1";
    if (rest.length === 0) {
      return renderAppPage(compileWebApp(this.manifest, viewerCtx), stateOnly);
    }
    if (rest.length === 1) {
      return this.serveTableHtml(rest[0]!, viewer, viewerCtx, query, stateOnly);
    }
    if (rest.length === 2 && rest[1] === "new") {
      return this.serveFormHtml(rest[0]!, viewerCtx, stateOnly);
    }
    if (rest.length === 2 && rest[1] === "kanban") {
      return this.serveKanbanHtml(rest[0]!, viewer, viewerCtx, query, stateOnly);
    }
    if (rest.length === 2 && rest[1] === "calendar") {
      return this.serveCalendarHtml(rest[0]!, viewer, viewerCtx, query, stateOnly);
    }
    if (rest.length === 2) {
      return this.serveDetailHtml(rest[0]!, rest[1]!, viewer, viewerCtx, stateOnly);
    }
    if (rest.length === 3 && rest[2] === "edit") {
      return this.serveEditFormHtml(rest[0]!, rest[1]!, viewer, viewerCtx, stateOnly);
    }
    return problemResponse(404, "Not found", `no route for ${path}`);
  }

  private unknownEntity(entity: string): RawWebResponse | null {
    return this.entityNames.has(entity) ? null : problemResponse(404, "Not found", `unknown entity '${entity}'`);
  }

  private resolverFor(entity: string, viewerCtx: ViewerContext): EntityFieldResolver {
    return new EntityFieldResolver(this.manifest, entity, viewerCtx, this.compileOptions);
  }

  private accessFor(entity: string, viewerCtx: ViewerContext): ReadonlyMap<string, { read: boolean; write: boolean }> {
    const ent = (this.manifest.entities ?? []).find((e) => e.name === entity)!;
    return this.resolverFor(entity, viewerCtx).resolve(entityFields(ent));
  }

  /** Parses a JSON request body into a record, or returns a 400 problem response. */
  private parseRecordBody(body: Uint8Array | null): { record: Record<string, unknown> } | { error: RawWebResponse } {
    if (body === null || body.byteLength === 0) {
      return { error: problemResponse(400, "Bad request", "a JSON request body is required") };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return { error: problemResponse(400, "Bad request", "request body is not valid JSON") };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: problemResponse(400, "Bad request", "request body must be a JSON object") };
    }
    return { record: parsed as Record<string, unknown> };
  }

  /**
   * Enforces the write path for `entity`: the entity-level RBAC grant for
   * `operation` (403 on denial) + the per-field write mask (422 listing any
   * fields the viewer can't set). Returns the access map for the response
   * redaction on success, or a problem response to short-circuit.
   */
  private authorizeWrite(
    entity: string,
    viewerCtx: ViewerContext,
    operation: "create" | "update",
    record: Record<string, unknown>,
  ): { access: ReadonlyMap<string, { read: boolean; write: boolean }> } | { error: RawWebResponse } {
    const resolver = this.resolverFor(entity, viewerCtx);
    const decision = resolver.canPerform(operation);
    if (!decision.allowed) {
      return { error: problemResponse(403, "Forbidden", decision.reason ?? `cannot ${operation} ${entity}`) };
    }
    const ent = (this.manifest.entities ?? []).find((e) => e.name === entity)!;
    const access = resolver.resolve(entityFields(ent));
    const blocked = unwritableFields(record, access);
    if (blocked.length > 0) {
      return { error: problemResponse(422, "Unprocessable entity", `cannot write field(s): ${blocked.join(", ")}`) };
    }
    return { access };
  }

  private async serveCreate(
    entity: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    body: Uint8Array | null,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const parsed = this.parseRecordBody(body);
    if ("error" in parsed) return parsed.error;
    const authz = this.authorizeWrite(entity, viewerCtx, "create", parsed.record);
    if ("error" in authz) return authz.error;
    const created = await this.store.create(viewer.tenantId, entity, parsed.record);
    return jsonResponse(201, { record: redactRecord(created, authz.access) });
  }

  private async serveUpdate(
    entity: string,
    id: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    body: Uint8Array | null,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const parsed = this.parseRecordBody(body);
    if ("error" in parsed) return parsed.error;
    const authz = this.authorizeWrite(entity, viewerCtx, "update", parsed.record);
    if ("error" in authz) return authz.error;
    const updated = await this.store.update(viewer.tenantId, entity, id, parsed.record);
    if (updated === null) return problemResponse(404, "Not found", `no ${entity} record '${id}'`);
    return jsonResponse(200, { record: redactRecord(updated, authz.access) });
  }

  private async serveDelete(entity: string, id: string, viewer: WebViewer): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const resolver = this.resolverFor(entity, { roles: viewer.roles });
    const decision = resolver.canPerform("delete");
    if (!decision.allowed) {
      return problemResponse(403, "Forbidden", decision.reason ?? `cannot delete ${entity}`);
    }
    const removed = await this.store.remove(viewer.tenantId, entity, id);
    if (!removed) return problemResponse(404, "Not found", `no ${entity} record '${id}'`);
    return { status: 204, headers: {}, body: null };
  }

  /** The entity's `entityLifecycle` transition spec by name (via operate-runtime's route specs). */
  private transitionSpec(entity: string, name: string): TransitionSpec | null {
    for (const spec of manifestRouteSpecs(this.manifest)) {
      if (spec.entity === entity && spec.action === "transition" && spec.transition?.name === name) {
        return spec.transition;
      }
    }
    return null;
  }

  /**
   * Fires a workflow transition on a record: POST /ui/:entity/:id/transition with
   * `{ transition: <name> }`. Authorized by the per-transition RBAC grant (403),
   * validated against the lifecycle's from-states (409 on an invalid current
   * state), then applied as a `stateField -> toState` update. The redacted record
   * is returned. 404 when the named transition isn't declared for the entity.
   */
  private async serveTransition(
    entity: string,
    id: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    body: Uint8Array | null,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const parsed = this.parseRecordBody(body);
    if ("error" in parsed) return parsed.error;
    const name = parsed.record["transition"];
    if (typeof name !== "string" || name.length === 0) {
      return problemResponse(400, "Bad request", "body must carry a 'transition' name");
    }
    const spec = this.transitionSpec(entity, name);
    if (spec === null) return problemResponse(404, "Not found", `no transition '${name}' for '${entity}'`);
    const resolver = this.resolverFor(entity, viewerCtx);
    const decision = resolver.canTransition(name);
    if (!decision.allowed) {
      return problemResponse(403, "Forbidden", decision.reason ?? `cannot fire '${name}'`);
    }
    const record = await this.store.get(viewer.tenantId, entity, id);
    if (record === null) return problemResponse(404, "Not found", `no ${entity} record '${id}'`);
    const current = record[spec.stateField];
    if (typeof current === "string" && !spec.fromStates.includes(current)) {
      return problemResponse(409, "Conflict", `'${name}' cannot fire from '${current}'`);
    }
    const updated = await this.store.update(viewer.tenantId, entity, id, { [spec.stateField]: spec.toState });
    if (updated === null) return problemResponse(404, "Not found", `no ${entity} record '${id}'`);
    const access = this.accessFor(entity, viewerCtx);
    return jsonResponse(200, { record: redactRecord(updated, access) });
  }

  private async serveTable(
    entity: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    query: Record<string, string | string[]>,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const table = compileTableModel(this.manifest, entity, viewerCtx, this.compileOptions);
    const config = listConfigForEntity(this.manifest, entity);
    const fields = parseFields(query);
    const listQuery = { ...parseListQuery(query, config), ...(fields !== null ? { fields } : {}) };
    const page = await this.store.listPage(viewer.tenantId, entity, listQuery);
    const access = this.accessFor(entity, viewerCtx);
    const data = page.records.map((r) => redactRecord(r, access));
    return jsonResponse(200, { table, page: { data, nextCursor: page.nextCursor } });
  }

  private async serveKanban(
    entity: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    query: Record<string, string | string[]>,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const kanban = compileKanbanModel(this.manifest, entity, viewerCtx, this.compileOptions);
    if (kanban === null) return problemResponse(404, "Not found", `no kanban view for '${entity}'`);
    const config = listConfigForEntity(this.manifest, entity);
    const page = await this.store.listPage(viewer.tenantId, entity, parseListQuery(query, config));
    const access = this.accessFor(entity, viewerCtx);
    const data = page.records.map((r) => redactRecord(r, access));
    return jsonResponse(200, { kanban, page: { data, nextCursor: page.nextCursor } });
  }

  private async serveCalendar(
    entity: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    query: Record<string, string | string[]>,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const calendar = compileCalendarModel(this.manifest, entity, viewerCtx, this.compileOptions);
    if (calendar === null) return problemResponse(404, "Not found", `no calendar view for '${entity}'`);
    const config = listConfigForEntity(this.manifest, entity);
    const page = await this.store.listPage(viewer.tenantId, entity, parseListQuery(query, config));
    const access = this.accessFor(entity, viewerCtx);
    const data = page.records.map((r) => redactRecord(r, access));
    return jsonResponse(200, { calendar, page: { data, nextCursor: page.nextCursor } });
  }

  private async serveMap(
    entity: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    query: Record<string, string | string[]>,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const map = compileMapModel(this.manifest, entity, viewerCtx, this.compileOptions);
    if (map === null) return problemResponse(404, "Not found", `no map view for '${entity}'`);
    const config = listConfigForEntity(this.manifest, entity);
    const page = await this.store.listPage(viewer.tenantId, entity, parseListQuery(query, config));
    const access = this.accessFor(entity, viewerCtx);
    const data = page.records.map((r) => redactRecord(r, access));
    return jsonResponse(200, { map, page: { data, nextCursor: page.nextCursor } });
  }

  private async serveDetail(
    entity: string,
    id: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const record = await this.store.get(viewer.tenantId, entity, id);
    if (record === null) return problemResponse(404, "Not found", `no ${entity} record '${id}'`);
    const access = this.accessFor(entity, viewerCtx);
    const redacted = redactRecord(record, access);
    const detail = compileDetailModel(this.manifest, entity, viewerCtx, redacted, this.compileOptions);
    return jsonResponse(200, { detail, record: redacted });
  }

  private serveForm(entity: string, viewerCtx: ViewerContext): RawWebResponse {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const form = compileFormModel(this.manifest, entity, viewerCtx, "create", this.compileOptions);
    return jsonResponse(200, { form });
  }

  private async serveTableHtml(
    entity: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    query: Record<string, string | string[]>,
    stateOnly: boolean,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const app = compileWebApp(this.manifest, viewerCtx);
    const table = compileTableModel(this.manifest, entity, viewerCtx, this.compileOptions);
    const config = listConfigForEntity(this.manifest, entity);
    const fields = parseFields(query);
    const listQuery = { ...parseListQuery(query, config), ...(fields !== null ? { fields } : {}) };
    const page = await this.store.listPage(viewer.tenantId, entity, listQuery);
    const access = this.accessFor(entity, viewerCtx);
    const data = page.records.map((r) => redactRecord(r, access));
    return renderTablePage(app, table, data, page.nextCursor, stateOnly);
  }

  private async serveKanbanHtml(
    entity: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    query: Record<string, string | string[]>,
    stateOnly: boolean,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const kanban = compileKanbanModel(this.manifest, entity, viewerCtx, this.compileOptions);
    if (kanban === null) return problemResponse(404, "Not found", `no kanban view for '${entity}'`);
    const app = compileWebApp(this.manifest, viewerCtx);
    const config = listConfigForEntity(this.manifest, entity);
    const page = await this.store.listPage(viewer.tenantId, entity, parseListQuery(query, config));
    const access = this.accessFor(entity, viewerCtx);
    const data = page.records.map((r) => redactRecord(r, access));
    return renderKanbanPage(app, kanban, data, stateOnly);
  }

  private async serveCalendarHtml(
    entity: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    query: Record<string, string | string[]>,
    stateOnly: boolean,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const calendar = compileCalendarModel(this.manifest, entity, viewerCtx, this.compileOptions);
    if (calendar === null) return problemResponse(404, "Not found", `no calendar view for '${entity}'`);
    const app = compileWebApp(this.manifest, viewerCtx);
    const config = listConfigForEntity(this.manifest, entity);
    const page = await this.store.listPage(viewer.tenantId, entity, parseListQuery(query, config));
    const access = this.accessFor(entity, viewerCtx);
    const data = page.records.map((r) => redactRecord(r, access));
    return renderCalendarPage(app, calendar, data, stateOnly);
  }

  private async serveDetailHtml(
    entity: string,
    id: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    stateOnly: boolean,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const record = await this.store.get(viewer.tenantId, entity, id);
    if (record === null) return problemResponse(404, "Not found", `no ${entity} record '${id}'`);
    const resolver = this.resolverFor(entity, viewerCtx);
    const access = resolver.resolve(entityFields((this.manifest.entities ?? []).find((e) => e.name === entity)!));
    const redacted = redactRecord(record, access);
    const app = compileWebApp(this.manifest, viewerCtx);
    const detail = compileDetailModel(this.manifest, entity, viewerCtx, redacted, this.compileOptions);
    // Edit / Delete affordances are gated by the caller's RBAC grants — the
    // hydrated client only shows a control the server would authorize.
    const permissions = {
      canEdit: resolver.canPerform("update").allowed,
      canDelete: resolver.canPerform("delete").allowed,
    };
    return renderDetailPage(app, detail, redacted, permissions, stateOnly);
  }

  private serveFormHtml(entity: string, viewerCtx: ViewerContext, stateOnly: boolean): RawWebResponse {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const app = compileWebApp(this.manifest, viewerCtx);
    const form = compileFormModel(this.manifest, entity, viewerCtx, "create", this.compileOptions);
    return renderFormPage(app, form, undefined, stateOnly);
  }

  private async serveEditFormHtml(
    entity: string,
    id: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    stateOnly: boolean,
  ): Promise<RawWebResponse> {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const record = await this.store.get(viewer.tenantId, entity, id);
    if (record === null) return problemResponse(404, "Not found", `no ${entity} record '${id}'`);
    const access = this.accessFor(entity, viewerCtx);
    const redacted = redactRecord(record, access);
    const app = compileWebApp(this.manifest, viewerCtx);
    const form = compileFormModel(this.manifest, entity, viewerCtx, "edit", this.compileOptions);
    return renderFormPage(app, form, { entityId: id, values: redacted }, stateOnly);
  }
}

/**
 * Composes a manifest + store + API keys (+ optional JWT/JWKS) into a ready
 * `OperateWebServer`. API-key and JWT auth coexist behind one
 * `WebPrincipalResolver`: a registered key wins, else a Bearer EdDSA JWT is
 * verified against the JWKS and its claims become the viewer.
 */
export function buildOperateWebServer(options: {
  readonly manifest: Manifest;
  readonly store?: EntityStore;
  readonly apiKeySpecs: readonly { key: string; role: string; tenantId: string }[];
  readonly jwt?: JwtVerifyConfig;
  readonly compileOptions?: CompileOptions;
  readonly now?: () => Date;
  readonly bundleLoader?: BundleLoader;
}): OperateWebServer {
  const resolver = new WebPrincipalResolver({
    apiKeys: new ApiKeyRegistry(options.apiKeySpecs),
    ...(options.jwt !== undefined ? { jwt: options.jwt } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return new OperateWebServer({
    manifest: options.manifest,
    ...(options.store !== undefined ? { store: options.store } : {}),
    resolver,
    ...(options.compileOptions !== undefined ? { compileOptions: options.compileOptions } : {}),
    ...(options.bundleLoader !== undefined ? { bundleLoader: options.bundleLoader } : {}),
  });
}
