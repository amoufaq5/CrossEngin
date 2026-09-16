import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "operate_session";
export const SESSION_SECONDS = 3600;
export interface WebSession { credential: string; expiresAt: number }
function key(): Buffer {
  const secret = process.env.OPERATE_SESSION_SECRET ?? "";
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error("OPERATE_SESSION_SECRET must be a random 32-byte hexadecimal key");
  return Buffer.from(secret, "hex");
}
export function sealSession(credential: string, now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from("crossengin-web-session-v1"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ credential, expiresAt: now + SESSION_SECONDS * 1000 })), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
export function openSession(value: string | undefined, now = Date.now()): WebSession | null {
  if (!value || value.length > 4096) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from("crossengin-web-session-v1"));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    if (typeof parsed !== "object" || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.credential !== "string" || r.credential.length < 16 || /\s/.test(r.credential) ||
        typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt) || r.expiresAt <= now) return null;
    return { credential: r.credential, expiresAt: r.expiresAt };
  } catch { return null; }
}
export function sameOrigin(request: Request): boolean {
  const expected = process.env.OPERATE_PUBLIC_ORIGIN;
  if (process.env.NODE_ENV === "production" && !expected) return false;
  return request.headers.get("origin") === (expected ?? new URL(request.url).origin);
}
export function apiTarget(): string {
  const configured = process.env.OPERATE_API_URL;
  if (process.env.NODE_ENV === "production" && !configured) throw new Error("OPERATE_API_URL is required");
  return (configured ?? "http://localhost:8787").replace(/\/+$/, "");
}
export async function limitedBody(request: Request, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new RangeError("payload_too_large"); }
    chunks.push(next.value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
