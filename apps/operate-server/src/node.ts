import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

import { createNodePgConnection, parsePgEnvConfig } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  InMemoryEntityStore,
  InMemorySequenceAllocator,
  InMemorySettingsStore,
  LicenseEntitlementResolver,
  type EntitlementResolver,
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

import type { ServeOptions } from "./cli.js";
import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import { loadBuiltinPack, loadManifestFromJson } from "./manifest-source.js";
import { JwksRefreshPoller, RemoteJwksProvider } from "./jwks.js";
import {
  buildJwksProvider,
  parseApiKeySpec,
  parseJwksKeySpec,
  type JwksKeySpec,
  type JwtVerifyConfig,
} from "./principals.js";
import { OperateHttpServer, buildOperateHttpServer, type WebhookRoute } from "./server.js";

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
  let webhookRoute: WebhookRoute | undefined;
  if (options.stripeWebhookSecret !== null && conn !== undefined) {
    const secret = options.stripeWebhookSecret;
    const subscriptionStore = new PostgresSubscriptionStore(conn, schemaOpt);
    if (entitlementResolver === undefined) entitlementResolver = new PostgresEntitlementResolver(conn, schemaOpt);
    webhookRoute = {
      method: "POST",
      path: "/v1/webhooks/stripe",
      handle: async (body, headers) => {
        const payload = new TextDecoder().decode(body ?? new Uint8Array());
        const signatureHeader = firstHeader(headers["stripe-signature"]) ?? "";
        const result = await ingestStripeWebhook({ payload, signatureHeader, secret, store: subscriptionStore });
        return result.ok
          ? jsonRaw(200, { received: true, applied: result.applied })
          : jsonRaw(400, { error: "invalid_signature", reason: result.reason });
      },
    };
  }
  const { httpServer } = buildOperateHttpServer({
    manifest,
    store,
    apiKeys,
    allocator,
    settingsStore,
    ...(entitlementResolver !== undefined ? { entitlementResolver } : {}),
    ...(webhookRoute !== undefined ? { webhookRoute } : {}),
    defaultScheme: options.defaultScheme,
    ...(jwt !== null ? { jwt } : {}),
  });
  poller?.start();
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
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
