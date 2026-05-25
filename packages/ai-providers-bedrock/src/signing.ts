import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SIGNED_PAYLOAD_HEADER = "x-amz-content-sha256";

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface SignRequestInput {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}

export interface SignedRequest {
  readonly authorization: string;
  readonly amzDate: string;
  readonly contentSha256: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function signRequest(input: SignRequestInput): SignedRequest {
  const amzDate = formatAmzDate(input.now);
  const dateStamp = amzDate.slice(0, 8);
  const contentSha256 = sha256Hex(input.body);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    headers[k.toLowerCase()] = v.trim();
  }
  headers["host"] = input.host.toLowerCase();
  headers["x-amz-date"] = amzDate;
  headers[SIGNED_PAYLOAD_HEADER] = contentSha256;
  if (input.credentials.sessionToken !== undefined) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((n) => `${n}:${headers[n] ?? ""}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalQuery = canonicaliseQuery(input.query ?? {});

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalisePath(input.path),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    contentSha256,
  ].join("\n");

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");

  const signingKey = deriveSigningKey(
    input.credentials.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = hmacHex(signingKey, stringToSign);

  const authorization =
    `${ALGORITHM} ` +
    `Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  return {
    authorization,
    amzDate,
    contentSha256,
    headers,
  };
}

export function formatAmzDate(now: Date): string {
  const pad = (n: number, w: number): string => n.toString().padStart(w, "0");
  return (
    pad(now.getUTCFullYear(), 4) +
    pad(now.getUTCMonth() + 1, 2) +
    pad(now.getUTCDate(), 2) +
    "T" +
    pad(now.getUTCHours(), 2) +
    pad(now.getUTCMinutes(), 2) +
    pad(now.getUTCSeconds(), 2) +
    "Z"
  );
}

function canonicalisePath(path: string): string {
  if (path.length === 0) return "/";
  return path
    .split("/")
    .map((segment) => uriEncode(segment, false))
    .join("/");
}

function canonicaliseQuery(query: Readonly<Record<string, string | readonly string[]>>): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(query)) {
    const values = Array.isArray(v) ? v : [v];
    for (const value of values) {
      pairs.push([uriEncode(k, true), uriEncode(String(value), true)]);
    }
  }
  pairs.sort(([ak, av], [bk, bv]) => (ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk)));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function uriEncode(value: string, encodeSlash: boolean): string {
  const out: string[] = [];
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    const isUnreserved =
      (cp >= 0x30 && cp <= 0x39) ||
      (cp >= 0x41 && cp <= 0x5a) ||
      (cp >= 0x61 && cp <= 0x7a) ||
      ch === "-" ||
      ch === "_" ||
      ch === "." ||
      ch === "~";
    if (isUnreserved) {
      out.push(ch);
    } else if (ch === "/" && !encodeSlash) {
      out.push(ch);
    } else {
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) {
        out.push("%" + b.toString(16).toUpperCase().padStart(2, "0"));
      }
    }
  }
  return out.join("");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hmac(key: Uint8Array, message: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", Buffer.from(key)).update(message).digest());
}

function hmacHex(key: Uint8Array, message: string): string {
  return createHmac("sha256", Buffer.from(key)).update(message).digest("hex");
}

function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Uint8Array {
  const kSecret = new TextEncoder().encode(`AWS4${secretAccessKey}`);
  const kDate = hmac(kSecret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}
