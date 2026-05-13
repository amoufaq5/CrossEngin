import { z } from "zod";

const TENANT_ID_REGEX = /^[A-Za-z0-9_-]+$/;
const FILE_ID_REGEX = /^[A-Za-z0-9_-]+$/;
const PREFIX_REGEX = /^[a-z0-9][a-z0-9/_-]*\/$/;

export const STORAGE_REGIONS = [
  "eu-central",
  "eu-west",
  "us-east",
  "us-west",
  "me-uae",
  "ap-southeast",
  "ap-south",
] as const;
export type StorageRegion = (typeof STORAGE_REGIONS)[number];

export const StorageRegionSchema = z.enum(STORAGE_REGIONS);

export const BUCKET_PER_REGION: Readonly<Record<StorageRegion, string>> = Object.freeze({
  "eu-central": "crossengin-files-eu",
  "eu-west": "crossengin-files-eu-west",
  "us-east": "crossengin-files-us",
  "us-west": "crossengin-files-us-west",
  "me-uae": "crossengin-files-uae",
  "ap-southeast": "crossengin-files-apse",
  "ap-south": "crossengin-files-aps",
});

export interface StorageKeyInput {
  readonly tenantId: string;
  readonly prefix: string;
  readonly fileId: string;
  readonly extension?: string;
  readonly uploadedAt: Date;
}

export function buildStorageKey(input: StorageKeyInput): string {
  if (!TENANT_ID_REGEX.test(input.tenantId)) {
    throw new Error(`invalid tenantId: ${input.tenantId}`);
  }
  if (!FILE_ID_REGEX.test(input.fileId)) {
    throw new Error(`invalid fileId: ${input.fileId}`);
  }
  if (!PREFIX_REGEX.test(input.prefix)) {
    throw new Error(`invalid prefix '${input.prefix}' — must be lowercase '<segment>/.../'`);
  }
  const year = input.uploadedAt.getUTCFullYear();
  const month = String(input.uploadedAt.getUTCMonth() + 1).padStart(2, "0");
  const ext = input.extension !== undefined ? `.${input.extension.replace(/^\./, "")}` : "";
  return `t_${input.tenantId}/${input.prefix}${year}/${month}/${input.fileId}${ext}`;
}

const STORAGE_KEY_REGEX =
  /^t_([A-Za-z0-9_-]+)\/([a-z0-9][a-z0-9/_-]*?)\/(\d{4})\/(\d{2})\/([A-Za-z0-9_-]+)(\.[A-Za-z0-9]+)?$/;

export interface ParsedStorageKey {
  readonly tenantId: string;
  readonly prefix: string;
  readonly year: number;
  readonly month: number;
  readonly fileId: string;
  readonly extension: string | null;
}

export function parseStorageKey(key: string): ParsedStorageKey | null {
  const match = key.match(STORAGE_KEY_REGEX);
  if (match === null) return null;
  const [, tenantId, prefix, year, month, fileId, ext] = match;
  if (
    tenantId === undefined ||
    prefix === undefined ||
    year === undefined ||
    month === undefined ||
    fileId === undefined
  ) {
    return null;
  }
  return {
    tenantId,
    prefix: `${prefix}/`,
    year: Number(year),
    month: Number(month),
    fileId,
    extension: ext !== undefined ? ext.slice(1) : null,
  };
}

export const SIGNED_URL_OPERATIONS = ["upload", "download", "delete"] as const;
export type SignedUrlOperation = (typeof SIGNED_URL_OPERATIONS)[number];

export const SignedUrlRequestSchema = z.object({
  fileId: z.string().min(1),
  operation: z.enum(SIGNED_URL_OPERATIONS),
  expiresIn: z.string().regex(/^P(?=.)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/),
  requestedBy: z.string().min(1),
  requestedAt: z.string().datetime({ offset: true }),
  clientIp: z.string().min(1).optional(),
});
export type SignedUrlRequest = z.infer<typeof SignedUrlRequestSchema>;

export const SignedUrlResponseSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "PUT", "DELETE"]),
  headers: z.record(z.string(), z.string()).default({}),
  expiresAt: z.string().datetime({ offset: true }),
  fileId: z.string().min(1),
  operation: z.enum(SIGNED_URL_OPERATIONS),
});
export type SignedUrlResponse = z.infer<typeof SignedUrlResponseSchema>;
