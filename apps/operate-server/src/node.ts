import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

import { StripeClient } from "@crossengin/billing-stripe";
import { createNodePgConnection, parsePgEnvConfig } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  InMemoryEntityStore,
  InMemorySequenceAllocator,
  InMemorySettingsStore,
  LicenseEntitlementResolver,
  buildPlanCatalog,
  entityEventEffect,
  type WriteEffect,
  type BillingPortalWiring,
  type EntitlementResolver,
  type PlanLimitsLookup,
  type EntityStore,
  type SequenceAllocator,
  type SettingsStore,
} from "@crossengin/operate-runtime";
import { type PgConnection } from "@crossengin/kernel-pg";
import {
  ColumnMappedEntityStore,
  PostgresEntitlementResolver,
  PostgresEntityStore,
  PostgresSequenceAllocator,
  PostgresSettingsStore,
  PostgresSubscriptionStore,
  ingestStripeWebhook,
} from "@crossengin/operate-runtime-pg";

import type { PruneOptions, ServeOptions } from "./cli.js";
import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import { loadBuiltinPack, loadManifestFromJson } from "./manifest-source.js";
import {
  relationPairsFromManifest,
  sweepDanglingLinksForTenants,
  type MultiTenantSweepReport,
} from "./link-sweep.js";
import { JwksRefreshPoller, RemoteJwksProvider } from "./jwks.js";
import {
  buildJwksProvider,
  parseApiKeySpec,
  parseJwksKeySpec,
  type JwksKeySpec,
  type JwtVerifyConfig,
} from "./principals.js";
import { OperateHttpServer, buildOperateHttpServer, type WebhookRoute } from "./server.js";
import { JobScheduler, PostgresTenantSource, StaticTenantSource, type TenantSource } from "./scheduler.js";
import { PostgresEntityEventSink } from "./entity-events.js";
import { PostgresJobInvoker, buildActionRoleMap, mergeActionRoleMaps } from "./job-invoke.js";
import { invokeRolesByAction } from "@crossengin/jobs";

function firstHeader(v: string | readonly string[] | undefined): string | undefined {
  return v === undefined ? undefined : Array.isArray(v) ? v[0] : (v as string);
}

function jsonRaw(status: number, body: unknown): RawHttpResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { status, headers: { "content-type": "application/json", "content-length": bytes.byteLength.toString() }, body: bytes };
}

/** The slice of Node's `IncomingMessage` the adapter reads. */
export interface NodeReqLike extends AsyncIterable<Uint8Array> {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
}

/** The slice of Node's `ServerResponse` the adapter writes. */
export interface NodeResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(chunk?: Uint8Array): void;
}

async function readBody(req: NodeReqLike): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Builds a Node `http` request listener over an `OperateHttpServer`: collects
 * the body, dispatches through the gateway, and writes the `RawHttpResponse`. A
 * dispatch throw becomes a 500 problem document rather than a hung socket.
 */
export function createNodeRequestListener(
  server: OperateHttpServer,
): (req: NodeReqLike, res: NodeResLike) => Promise<void> {
  return async (req, res) => {
    try {
      const body = await readBody(req);
      const raw: RawHttpRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        remoteAddress: req.socket?.remoteAddress ?? null,
      };
      const response = await server.dispatch(raw, body);
      res.writeHead(response.status, response.headers);
      res.end(response.body ?? undefined);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "https://crossengin.io/problems/internal-error",
          title: "Internal server error",
          status: 500,
          detail,
          extensions: {},
        }),
      );
      res.writeHead(500, {
        "content-type": "application/problem+json",
        "content-length": payload.byteLength.toString(),
      });
      res.end(payload);
    }
  };
}

async function resolveJwtConfig(
  options: ServeOptions,
): Promise<{ config: JwtVerifyConfig | null; poller: JwksRefreshPoller | null }> {
  const specs: JwksKeySpec[] = options.jwksKeys.map(parseJwksKeySpec);
  if (options.jwksFile !== null) {
    const parsed = JSON.parse(await readFile(options.jwksFile, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`--jwks-file must be a JSON array of {kid, publicKeyBase64}`);
    for (const k of parsed as JwksKeySpec[]) {
      if (typeof k.kid !== "string" || typeof k.publicKeyBase64 !== "string") {
        throw new Error(`--jwks-file entries must be {kid, publicKeyBase64}`);
      }
      specs.push({ kid: k.kid, publicKeyBase64: k.publicKeyBase64 });
    }
  }
  if (specs.length === 0 && options.jwksUrl === null) return { config: null, poller: null };
  if (options.jwtIssuer === null || options.jwtAudience === null) {
    throw new Error("--jwt-issuer and --jwt-audience are required when a JWKS is configured");
  }
  let poller: JwksRefreshPoller | null = null;
  let jwksProvider;
  if (options.jwksUrl !== null) {
    const remote = new RemoteJwksProvider({ url: options.jwksUrl });
    jwksProvider = remote;
    if (options.jwksRefreshMs !== null) {
      poller = new JwksRefreshPoller({ provider: remote, intervalMs: options.jwksRefreshMs });
    }
  } else {
    jwksProvider = buildJwksProvider(specs);
  }
  return { config: { jwksProvider, issuer: options.jwtIssuer, audience: options.jwtAudience }, poller };
}

interface ResolvedStores {
  readonly store: EntityStore;
  readonly allocator: SequenceAllocator;
  readonly settingsStore: SettingsStore;
  /** The Postgres connection (present only for pg stores), reused for billing wiring. */
  readonly conn?: PgConnection;
}

async function resolveStore(options: ServeOptions, manifest: Manifest): Promise<ResolvedStores> {
  if (options.store === "memory") {
    return {
      store: new InMemoryEntityStore(),
      allocator: new InMemorySequenceAllocator(),
      settingsStore: new InMemorySettingsStore(),
    };
  }
  const conn = createNodePgConnection(parsePgEnvConfig());
  const schema = options.schema ?? undefined;
  const allocator = new PostgresSequenceAllocator(conn, schema);
  const settingsStore = new PostgresSettingsStore(conn, schema);
  if (options.store === "pg-columns") {
    const store = new ColumnMappedEntityStore(conn, manifest, options.schema !== null ? { schema: options.schema } : {});
    await store.ensureSchema();
    return { store, allocator, settingsStore, conn };
  }
  const store = new PostgresEntityStore(conn, options.schema !== null ? { schema: options.schema } : {});
  return { store, allocator, settingsStore, conn };
}

export interface RunningServer {
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

/**
 * Boots the full server from `ServeOptions`: loads + resolves the manifest
 * (pack or file), builds the entity store (in-memory or Postgres), wires the
 * API keys, and starts listening. Returns a handle for graceful shutdown.
 */
export async function serve(options: ServeOptions): Promise<RunningServer> {
  const manifest =
    options.manifestPath !== null
      ? loadManifestFromJson(await readFile(options.manifestPath, "utf8"))
      : await loadBuiltinPack(options.pack ?? "");
  const { store, allocator, settingsStore, conn } = await resolveStore(options, manifest);
  const apiKeys = options.apiKeys.map(parseApiKeySpec);
  const { config: jwt, poller } = await resolveJwtConfig(options);
  const schemaOpt = options.schema !== null ? { schema: options.schema } : {};
  // Offline subscription entitlement: verify an Ed25519 license token against the
  // licensor's public key at boot (no cloud billing call). A lapsed/expired license
  // means the gate denies (past_due keeps read access).
  let entitlementResolver: EntitlementResolver | undefined =
    options.licenseFile !== null && options.licenseKey !== null
      ? new LicenseEntitlementResolver((await readFile(options.licenseFile, "utf8")).trim(), options.licenseKey)
      : undefined;
  // Cloud billing: a Stripe webhook writes subscription snapshots to billing_subscriptions
  // and (unless a license already gates) the gate reads them via a Postgres resolver — so a
  // Stripe subscription change flows straight into enforcement. Signature-authenticated, so
  // the route runs ahead of the gateway's API-key/JWT pipeline.
  // One subscription store backs both the webhook (writes snapshots) and the billing portal
  // (reads the tenant's Stripe customer id), when either is configured over a pg connection.
  const subscriptionStore =
    conn !== undefined && (options.stripeWebhookSecret !== null || options.stripeApiKey !== null)
      ? new PostgresSubscriptionStore(conn, schemaOpt)
      : undefined;
  let webhookRoute: WebhookRoute | undefined;
  if (options.stripeWebhookSecret !== null && conn !== undefined && subscriptionStore !== undefined) {
    const secret = options.stripeWebhookSecret;
    if (entitlementResolver === undefined) entitlementResolver = new PostgresEntitlementResolver(conn, schemaOpt);
    // Optional declarative plan catalog: a webhook event resolves its record cap + features from
    // the catalog (by plan or Stripe price id), falling back to the subscription's own metadata.
    let planLimits: PlanLimitsLookup | undefined;
    if (options.planCatalogFile !== null) {
      planLimits = buildPlanCatalog(JSON.parse(await readFile(options.planCatalogFile, "utf8"))).toLookup();
    }
    webhookRoute = {
      method: "POST",
      path: "/v1/webhooks/stripe",
      handle: async (body, headers) => {
        const payload = new TextDecoder().decode(body ?? new Uint8Array());
        const signatureHeader = firstHeader(headers["stripe-signature"]) ?? "";
        const result = await ingestStripeWebhook({
          payload,
          signatureHeader,
          secret,
          store: subscriptionStore,
          ...(planLimits !== undefined ? { planLimits } : {}),
        });
        return result.ok
          ? jsonRaw(200, { received: true, applied: result.applied })
          : jsonRaw(400, { error: "invalid_signature", reason: result.reason });
      },
    };
  }
  // Stripe Billing Portal: POST /v1/meta/billing-portal mints a hosted session so a tenant can
  // manage/fix their subscription. The subscription store resolves the tenant's Stripe customer
  // id; the Stripe client (with the secret key) creates the session. Both structural.
  let billingPortal: BillingPortalWiring | undefined;
  if (options.stripeApiKey !== null && options.billingPortalReturnUrl !== null && subscriptionStore !== undefined) {
    billingPortal = {
      customers: subscriptionStore,
      portal: new StripeClient({ apiKey: options.stripeApiKey }),
      returnUrl: options.billingPortalReturnUrl,
    };
  }
  // Entity-event emission: turn each served write into a domain event that fires event-triggered
  // (and delayed) jobs into job_runs. Best-effort (a failed enqueue never fails the write), appended
  // after the manifest's default financial effects. Enabled by --emit-entity-events over a pg store.
  const additionalWriteEffects: WriteEffect[] = [];
  if (options.emitEntityEvents && conn !== undefined) {
    const sink = new PostgresEntityEventSink(conn, Object.values(manifest.jobs ?? {}), schemaOpt);
    additionalWriteEffects.push(
      entityEventEffect({ sink, ...(options.eventPrefix !== null ? { eventPrefix: options.eventPrefix } : {}) }),
    );
  }
  // On-demand job invocation: POST /v1/meta/jobs/invoke enqueues the caller tenant's userInvoked
  // jobs. Enabled by --enable-job-invoke over a pg store (needs the conn + the manifest's jobs).
  const jobInvoker =
    options.enableJobInvoke && conn !== undefined
      ? new PostgresJobInvoker(conn, Object.values(manifest.jobs ?? {}), schemaOpt)
      : undefined;
  // Per-action invoke roles: the manifest's declared invokeRoles are the baseline; the operator's
  // --job-invoke-action-role overrides win per action.
  const invokeActionRoles =
    jobInvoker !== undefined
      ? mergeActionRoleMaps(
          invokeRolesByAction(Object.values(manifest.jobs ?? {})),
          buildActionRoleMap(options.jobInvokeActionRoles),
        )
      : new Map<string, ReadonlySet<string>>();
  const { httpServer } = buildOperateHttpServer({
    manifest,
    store,
    apiKeys,
    allocator,
    settingsStore,
    ...(entitlementResolver !== undefined ? { entitlementResolver } : {}),
    ...(webhookRoute !== undefined ? { webhookRoute } : {}),
    ...(billingPortal !== undefined ? { billingPortal } : {}),
    ...(additionalWriteEffects.length > 0 ? { additionalWriteEffects } : {}),
    ...(jobInvoker !== undefined ? { jobInvoker } : {}),
    ...(jobInvoker !== undefined && options.jobInvokeRoles.length > 0
      ? { jobInvokeRoles: options.jobInvokeRoles }
      : {}),
    ...(jobInvoker !== undefined && invokeActionRoles.size > 0
      ? { jobInvokeActionRoles: invokeActionRoles }
      : {}),
    defaultScheme: options.defaultScheme,
    ...(jwt !== null ? { jwt } : {}),
  });
  // In-process cron scheduler: enqueue the manifest's scheduled jobs into job_runs per tenant, so the
  // distributed worker fleet runs them. Enabled by --schedule-ms + --schedule-tenant over a pg store;
  // idempotent enqueue makes running it on every replica safe.
  let jobScheduler: JobScheduler | null = null;
  if (options.scheduleMs !== null && conn !== undefined) {
    // The tenant registry (meta.tenants) is always in `meta` — independent of the entity `--schema`.
    const tenants: TenantSource = options.scheduleAllTenants
      ? new PostgresTenantSource(conn)
      : new StaticTenantSource(options.scheduleTenants);
    jobScheduler = new JobScheduler({
      conn,
      jobs: Object.values(manifest.jobs ?? {}),
      tenants,
      intervalMs: options.scheduleMs,
      ...schemaOpt,
    });
  }
  poller?.start();
  jobScheduler?.start();
  const listener = createNodeRequestListener(httpServer);
  const server = createServer((req, res) => {
    void listener(req as unknown as NodeReqLike, res as unknown as NodeResLike);
  });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        poller?.stop();
        jobScheduler?.stop();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Runs the `prune-links` maintenance sweep: loads the manifest, opens a Postgres
 * connection (standard PG* env vars), builds a JSONB `PostgresEntityStore`, and
 * prunes every m2m relation's dangling links for the given tenant. Always the
 * JSONB store — the column store never dangles. Closes the connection before
 * returning the aggregated `SweepReport`.
 */
export async function runPruneLinks(options: PruneOptions): Promise<MultiTenantSweepReport> {
  if (options.tenantId === null && !options.allTenants) {
    throw new Error("prune-links requires a tenant id or --all-tenants");
  }
  const manifest =
    options.manifestPath !== null
      ? loadManifestFromJson(await readFile(options.manifestPath, "utf8"))
      : await loadBuiltinPack(options.pack ?? "");
  const conn = createNodePgConnection(parsePgEnvConfig());
  try {
    const store = new PostgresEntityStore(conn, options.schema !== null ? { schema: options.schema } : {});
    const pairs = relationPairsFromManifest(manifest);
    const tenantIds = options.allTenants
      ? await new PostgresTenantSource(
          conn,
          options.schema !== null ? { schema: options.schema } : {},
        ).activeTenantIds()
      : [options.tenantId ?? ""];
    return await sweepDanglingLinksForTenants(store, pairs, tenantIds, { dryRun: options.dryRun });
  } finally {
    await conn.close();
  }
}
