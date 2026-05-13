import { z } from "zod";

const RATE_LIMIT_REGEX = /^\d+\/(sec|min|hour|day)$/;
const ISO_DURATION_REGEX = /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
const ENDPOINT_PATH_REGEX = /^\//;

export const VaultReferenceSchema = z.object({
  vault: z.string().min(1),
});
export type VaultReference = z.infer<typeof VaultReferenceSchema>;

const NoneAuth = z.object({ kind: z.literal("none") });
const ApiKeyAuth = z.object({
  kind: z.literal("apiKey"),
  in: z.enum(["header", "query"]),
  name: z.string().min(1),
  value: VaultReferenceSchema,
});
const BearerAuth = z.object({
  kind: z.literal("bearer"),
  token: VaultReferenceSchema,
});
const BasicAuth = z.object({
  kind: z.literal("basic"),
  username: z.union([z.string().min(1), VaultReferenceSchema]),
  password: VaultReferenceSchema,
});
const OAuth2ClientCredentials = z.object({
  kind: z.literal("oauth2.clientCredentials"),
  tokenUrl: z.string().url(),
  clientId: VaultReferenceSchema,
  clientSecret: VaultReferenceSchema,
  scope: z.string().optional(),
});
const OAuth2AuthorizationCode = z.object({
  kind: z.literal("oauth2.authorizationCode"),
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  clientId: VaultReferenceSchema,
  clientSecret: VaultReferenceSchema,
  scope: z.string().optional(),
});
const MtlsAuth = z.object({
  kind: z.literal("mtls"),
  ca: VaultReferenceSchema.optional(),
  clientCert: VaultReferenceSchema,
  clientKey: VaultReferenceSchema,
});
const HmacAuth = z.object({
  kind: z.literal("hmac"),
  secret: VaultReferenceSchema,
  algorithm: z.enum(["sha256", "sha512", "sha1"]).optional(),
});

export const IntegrationAuthSchema = z.discriminatedUnion("kind", [
  NoneAuth,
  ApiKeyAuth,
  BearerAuth,
  BasicAuth,
  OAuth2ClientCredentials,
  OAuth2AuthorizationCode,
  MtlsAuth,
  HmacAuth,
]);
export type IntegrationAuth = z.infer<typeof IntegrationAuthSchema>;

const DeclarativeTransform = z.object({
  kind: z.literal("declarative"),
  spec: z.record(z.string(), z.string()),
});
const NamedTransform = z.object({
  kind: z.literal("named"),
  name: z.string().min(1),
});
export const TransformationSchema = z.discriminatedUnion("kind", [
  DeclarativeTransform,
  NamedTransform,
]);
export type Transformation = z.infer<typeof TransformationSchema>;

export const RateLimitSchema = z.string().regex(RATE_LIMIT_REGEX, {
  message: "rate limit must be '<count>/<sec|min|hour|day>' (e.g., '60/min')",
});

export const Iso8601DurationSchema = z.string().regex(ISO_DURATION_REGEX, {
  message: "duration must be ISO 8601 (e.g., 'PT4H', 'P28D')",
});

export const HttpOperationSchema = z.object({
  name: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string(),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  bodyTransform: z.string().min(1).optional(),
  responseTransform: z.string().min(1).optional(),
  cacheTtl: Iso8601DurationSchema.optional(),
});
export type HttpOperation = z.infer<typeof HttpOperationSchema>;

export const GraphqlOperationSchema = z.object({
  name: z.string().min(1),
  operationType: z.enum(["query", "mutation", "subscription"]),
  document: z.string().min(1),
  bodyTransform: z.string().min(1).optional(),
  responseTransform: z.string().min(1).optional(),
});
export type GraphqlOperation = z.infer<typeof GraphqlOperationSchema>;

export const SftpTransportSchema = z.object({
  kind: z.enum(["ftp", "sftp"]),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  credentials: VaultReferenceSchema,
  path: z.string().optional(),
});
export type SftpTransport = z.infer<typeof SftpTransportSchema>;

const I18nLabelSchema = z.record(z.string(), z.string()).optional();

const OutboundHttpIntegration = z.object({
  kind: z.literal("outbound.http"),
  label: I18nLabelSchema,
  description: z.string().optional(),
  auth: IntegrationAuthSchema,
  endpoint: z.string().url(),
  rateLimit: RateLimitSchema.optional(),
  operations: z.array(HttpOperationSchema).min(1),
});

const OutboundGraphqlIntegration = z.object({
  kind: z.literal("outbound.graphql"),
  label: I18nLabelSchema,
  description: z.string().optional(),
  auth: IntegrationAuthSchema,
  endpoint: z.string().url(),
  rateLimit: RateLimitSchema.optional(),
  operations: z.array(GraphqlOperationSchema).min(1),
});

const OutboundHl7Integration = z.object({
  kind: z.literal("outbound.hl7"),
  label: I18nLabelSchema,
  auth: IntegrationAuthSchema,
  endpoint: z.string().min(1),
  messageTypes: z.array(z.string().min(1)).min(1),
  transform: z.string().min(1).optional(),
});

const OutboundFhirIntegration = z.object({
  kind: z.literal("outbound.fhir"),
  label: I18nLabelSchema,
  auth: IntegrationAuthSchema,
  endpoint: z.string().url(),
  rateLimit: RateLimitSchema.optional(),
  fhirVersion: z.enum(["R4", "R5"]).optional(),
});

const OutboundEdiIntegration = z.object({
  kind: z.literal("outbound.edi"),
  label: I18nLabelSchema,
  transport: SftpTransportSchema,
  format: z.enum(["x12", "ubl"]).optional(),
  transactionSets: z.array(z.string().min(1)).min(1),
  schedule: z.string().min(1).optional(),
  transform: z.string().min(1).optional(),
});

const OutboundSftpIntegration = z.object({
  kind: z.literal("outbound.sftp"),
  label: I18nLabelSchema,
  transport: SftpTransportSchema,
  schedule: z.string().min(1).optional(),
});

const OutboundWebhookSubscription = z.object({
  events: z.array(z.string().min(1)).min(1),
  endpoint: z.string().url(),
  secret: VaultReferenceSchema.optional(),
  retries: z.enum(["exponential", "linear", "none"]).optional(),
  deadLetter: z.enum(["log", "queue", "drop"]).optional(),
});

const OutboundWebhookIntegration = z.object({
  kind: z.literal("outbound.webhook"),
  label: I18nLabelSchema,
  subscriptions: z.array(OutboundWebhookSubscription).min(1),
});

const HmacVerification = z.object({
  kind: z.literal("hmac"),
  header: z.string().min(1),
  secret: VaultReferenceSchema,
  algorithm: z.enum(["sha256", "sha512", "sha1"]).optional(),
  tolerance: Iso8601DurationSchema.optional(),
});

const NoneVerification = z.object({
  kind: z.literal("none"),
});

export const WebhookVerificationSchema = z.discriminatedUnion("kind", [
  HmacVerification,
  NoneVerification,
]);
export type WebhookVerification = z.infer<typeof WebhookVerificationSchema>;

const InboundWebhookIntegration = z.object({
  kind: z.literal("inbound.webhook"),
  label: I18nLabelSchema,
  endpoint: z.string().regex(ENDPOINT_PATH_REGEX, {
    message: "endpoint must be a path starting with '/'",
  }),
  verification: WebhookVerificationSchema,
  transform: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
});

const InboundHl7Integration = z.object({
  kind: z.literal("inbound.hl7"),
  label: I18nLabelSchema,
  endpoint: z.string().min(1),
  messageTypes: z.array(z.string().min(1)).min(1),
  auth: IntegrationAuthSchema.optional(),
  transform: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
});

const InboundFhirIntegration = z.object({
  kind: z.literal("inbound.fhir"),
  label: I18nLabelSchema,
  endpoint: z.string().min(1),
  auth: IntegrationAuthSchema.optional(),
  fhirVersion: z.enum(["R4", "R5"]).optional(),
  resourceTypes: z.array(z.string().min(1)).optional(),
});

const InboundEdiIntegration = z.object({
  kind: z.literal("inbound.edi"),
  label: I18nLabelSchema,
  transport: SftpTransportSchema,
  format: z.enum(["x12", "ubl"]).optional(),
  transactionSets: z.array(z.string().min(1)).min(1),
  pollSchedule: z.string().min(1).optional(),
  transform: z.string().min(1).optional(),
});

const InboundSftpIntegration = z.object({
  kind: z.literal("inbound.sftp"),
  label: I18nLabelSchema,
  transport: SftpTransportSchema,
  pollSchedule: z.string().min(1).optional(),
});

export const IntegrationDeclarationSchema = z.discriminatedUnion("kind", [
  OutboundHttpIntegration,
  OutboundGraphqlIntegration,
  OutboundHl7Integration,
  OutboundFhirIntegration,
  OutboundEdiIntegration,
  OutboundSftpIntegration,
  OutboundWebhookIntegration,
  InboundWebhookIntegration,
  InboundHl7Integration,
  InboundFhirIntegration,
  InboundEdiIntegration,
  InboundSftpIntegration,
]);
export type IntegrationDeclaration = z.infer<typeof IntegrationDeclarationSchema>;

export type IntegrationKind = IntegrationDeclaration["kind"];

export const INTEGRATION_KINDS = [
  "outbound.http",
  "outbound.graphql",
  "outbound.hl7",
  "outbound.fhir",
  "outbound.edi",
  "outbound.sftp",
  "outbound.webhook",
  "inbound.webhook",
  "inbound.hl7",
  "inbound.fhir",
  "inbound.edi",
  "inbound.sftp",
] as const satisfies readonly IntegrationKind[];

export const IntegrationMapSchema = z.record(z.string().min(1), IntegrationDeclarationSchema);
export type IntegrationMap = z.infer<typeof IntegrationMapSchema>;
