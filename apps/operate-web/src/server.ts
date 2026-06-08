import type { Manifest } from "@crossengin/kernel/manifest";
import {
  InMemoryEntityStore,
  listConfigForEntity,
  parseFields,
  parseListQuery,
  type EntityStore,
} from "@crossengin/operate-runtime";
import {
  EntityFieldResolver,
  compileDetailModel,
  compileFormModel,
  compileTableModel,
  compileWebApp,
  entityFields,
  redactRecord,
  type CompileOptions,
  type ViewerContext,
} from "@crossengin/operate-web";

import { CLIENT_BUNDLE_PATH, serveClientBundle, type BundleLoader } from "./assets.js";
import {
  renderAppPage,
  renderDetailPage,
  renderFormPage,
  renderTablePage,
} from "./html.js";
import { jsonResponse, problemResponse, splitTarget, type RawWebRequest, type RawWebResponse } from "./http.js";
import { ApiKeyRegistry, WebPrincipalResolver, type JwtVerifyConfig, type WebViewer } from "./principals.js";

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
 *   GET /ui/app              -> WebAppModel
 *   GET /ui/:entity          -> { table, page: { data, nextCursor } }
 *   GET /ui/:entity/new      -> { form }
 *   GET /ui/:entity/:id      -> { detail, record }
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
    if (req.method.toUpperCase() !== "GET") {
      return problemResponse(405, "Method not allowed", `unsupported method ${req.method}`);
    }

    // The hydration bundle is a public static asset (it carries no per-caller
    // data — every model + row is redacted *before* it's embedded in the page),
    // so it is served before auth.
    const { path: rawPath } = splitTarget(req.url);
    if (rawPath === CLIENT_BUNDLE_PATH) {
      return this.bundleLoader !== undefined
        ? serveClientBundle(this.bundleLoader)
        : serveClientBundle();
    }

    const viewer = await this.resolver.resolve(req);
    if (viewer === null) {
      return problemResponse(401, "Unauthorized", "missing or unknown credential");
    }

    const { path, query } = splitTarget(req.url);
    const segments = path.split("/").filter((s) => s.length > 0);
    const viewerCtx: ViewerContext = { roles: viewer.roles };

    // `/ui/...` serves JSON view models; `/app/...` server-renders the same
    // models (already compiled + redacted for this caller) as HTML pages.
    if (segments[0] === "ui") {
      return this.dispatchUi(segments.slice(1), path, viewer, viewerCtx, query);
    }
    if (segments[0] === "app") {
      return this.dispatchApp(segments.slice(1), path, viewer, viewerCtx, query);
    }
    return problemResponse(404, "Not found", `no route for ${path}`);
  }

  private dispatchUi(
    rest: readonly string[],
    path: string,
    viewer: WebViewer,
    viewerCtx: ViewerContext,
    query: Record<string, string | string[]>,
  ): RawWebResponse | Promise<RawWebResponse> {
    if (rest.length === 1 && rest[0] === "app") {
      return jsonResponse(200, compileWebApp(this.manifest, viewerCtx));
    }
    if (rest.length === 1) {
      return this.serveTable(rest[0]!, viewer, viewerCtx, query);
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
    if (rest.length === 0) {
      return renderAppPage(compileWebApp(this.manifest, viewerCtx));
    }
    if (rest.length === 1) {
      return this.serveTableHtml(rest[0]!, viewer, viewerCtx, query);
    }
    if (rest.length === 2 && rest[1] === "new") {
      return this.serveFormHtml(rest[0]!, viewerCtx);
    }
    if (rest.length === 2) {
      return this.serveDetailHtml(rest[0]!, rest[1]!, viewer, viewerCtx);
    }
    return problemResponse(404, "Not found", `no route for ${path}`);
  }

  private unknownEntity(entity: string): RawWebResponse | null {
    return this.entityNames.has(entity) ? null : problemResponse(404, "Not found", `unknown entity '${entity}'`);
  }

  private accessFor(entity: string, viewerCtx: ViewerContext): ReadonlyMap<string, { read: boolean; write: boolean }> {
    const ent = (this.manifest.entities ?? []).find((e) => e.name === entity)!;
    return new EntityFieldResolver(this.manifest, entity, viewerCtx, this.compileOptions).resolve(entityFields(ent));
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
    return renderTablePage(app, table, data, page.nextCursor);
  }

  private async serveDetailHtml(
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
    const app = compileWebApp(this.manifest, viewerCtx);
    const detail = compileDetailModel(this.manifest, entity, viewerCtx, redacted, this.compileOptions);
    return renderDetailPage(app, detail, redacted);
  }

  private serveFormHtml(entity: string, viewerCtx: ViewerContext): RawWebResponse {
    const miss = this.unknownEntity(entity);
    if (miss !== null) return miss;
    const app = compileWebApp(this.manifest, viewerCtx);
    const form = compileFormModel(this.manifest, entity, viewerCtx, "create", this.compileOptions);
    return renderFormPage(app, form);
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
