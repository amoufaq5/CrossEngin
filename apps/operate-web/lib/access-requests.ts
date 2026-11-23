// The access-request queue (ADR-0464): a prospective customer asks for a workspace through the
// public `/request-access` page, and a platform operator approves or rejects the request here.
// Every request below goes to this Next app's /api proxy, which turns the caller's session cookie
// into the API's bearer token (ADR-0358).
//
// `PlatformError` and `throwProblem` are imported from lib/platform.ts rather than restated, for
// lib/users.ts' reason: the same `{error, detail}` documents through the same proxy, and the
// 401-redirect inside `throwProblem` is the half a second copy would forget.

import { PlatformError, throwProblem, type StarterChartReport } from "@/lib/platform";

export const ACCESS_REQUEST_STATUSES = ["pending", "approved", "rejected"] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

/** The server's `AccessRequestRecordSchema`, field for field. */
export interface AccessRequest {
  readonly id: string;
  readonly companyName: string;
  readonly requestedSlug: string | null;
  readonly contactName: string;
  readonly email: string;
  readonly message: string | null;
  readonly termsVersion: string;
  readonly termsAcceptedAt: string;
  readonly status: AccessRequestStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly approvedTenantId: string | null;
  readonly approvedUserId: string | null;
}

export interface AccessRequestPage {
  readonly data: ReadonlyArray<AccessRequest>;
  readonly nextCursor: string | null;
}

/** Derived from the status vocabulary, so a fourth status cannot leave this type asserting a false shape. */
export type AccessRequestCounts = Readonly<Record<AccessRequestStatus, number>> & {
  readonly total: number;
};

/**
 * The approve body. Every field is an override of what the request carried, so every field is
 * optional; the server parses it `.strict()`, so a caller builds it up rather than sending
 * `undefined` holes.
 *
 * `password` and `attachExistingUser: true` are mutually exclusive on the server: an approval never
 * replaces an existing person's password, so a body carrying both is a 400. An attach also needs
 * `confirmedExistingOwner: true` (else 400 `existing_owner_unconfirmed`), because the request's email
 * is whatever the requester typed and anyone can ask under someone else's address.
 */
export interface ApproveAccessRequestBody {
  readonly slug?: string;
  readonly name?: string;
  readonly email?: string;
  readonly primaryRole?: string;
  readonly password?: string;
  readonly defaultCurrency?: string;
  readonly paymentTermsDays?: number;
  readonly attachExistingUser?: boolean;
  readonly confirmedExistingOwner?: boolean;
  /**
   * Absent means the server creates the starter chart of accounts (ADR-0465). Send `false` only
   * for a company bringing its own chart: the body is `.strict()`, so `true` is the silence.
   */
  readonly starterChart?: boolean;
}

export interface ApprovedTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
}

export interface ApproveAccessRequestResult {
  readonly tenant: ApprovedTenant;
  readonly user: { readonly id: string; readonly email: string; readonly status: string };
  readonly membership: { readonly primaryRole: string; readonly status: string } | null;
  readonly attachedExistingUser: boolean;
  readonly passwordSet: boolean;
  /** Optional only because a server a build behind sends none; the console says so rather than guessing. */
  readonly starterChart?: StarterChartAnswer;
}

/**
 * What an approval says about the chart. `failed` is a throw after the workspace committed, so the
 * approval stands and the chart is finished from the workspace's own page.
 */
export type StarterChartAnswer =
  | StarterChartReport
  | { readonly outcome: "not_requested" }
  | { readonly outcome: "failed"; readonly error: string };

/** The person a 409 `user_exists` / `user_not_active` names, so the console can offer to attach. */
export interface ExistingUserRef {
  readonly id: string;
  readonly status: string;
}

/**
 * A refused approval, carrying the two facts the console acts on that a bare `PlatformError` drops:
 * the existing user behind a `user_exists`, and the declared roles behind a `role_not_declared`.
 * Read through a parse of the body rather than a cast, because each decides which sentence and
 * which button the operator is shown.
 */
export class AccessRequestApproveError extends PlatformError {
  readonly existingUser: ExistingUserRef | null;
  readonly declaredRoles: readonly string[] | null;
  constructor(base: PlatformError, existingUser: ExistingUserRef | null, declaredRoles: readonly string[] | null) {
    super(base.status, base.message, base.code);
    this.name = "AccessRequestApproveError";
    this.existingUser = existingUser;
    this.declaredRoles = declaredRoles;
  }
}

export { PlatformError };
export type { StarterChartReport };

function platformPath(suffix: string): string {
  return `/api/v1/platform/access-requests${suffix}`;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) await throwProblem(res);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwProblem(res);
  return (await res.json()) as T;
}

export async function listAccessRequests(
  params: { status?: AccessRequestStatus; limit?: number; cursor?: string } = {},
): Promise<AccessRequestPage> {
  const p = new URLSearchParams();
  if (params.status !== undefined) p.set("status", params.status);
  if (params.limit !== undefined) p.set("limit", String(params.limit));
  if (params.cursor) p.set("cursor", params.cursor);
  const qs = p.toString();
  const json = await getJson<{ data?: AccessRequest[]; page?: { nextCursor?: string | null } }>(
    platformPath(qs ? `?${qs}` : ""),
  );
  return { data: json.data ?? [], nextCursor: json.page?.nextCursor ?? null };
}

/** The per-status census. The server answers the counts flat, not under a `counts` key. */
export async function fetchAccessRequestCounts(): Promise<AccessRequestCounts> {
  return getJson<AccessRequestCounts>(platformPath("/stats"));
}

function readExistingUser(doc: Record<string, unknown>): ExistingUserRef | null {
  const raw = doc["existingUser"];
  if (raw === null || typeof raw !== "object") return null;
  const ref = raw as Record<string, unknown>;
  const id = ref["id"];
  const status = ref["status"];
  return typeof id === "string" && typeof status === "string" ? { id, status } : null;
}

function readDeclaredRoles(doc: Record<string, unknown>): readonly string[] | null {
  const raw = doc["declaredRoles"];
  if (!Array.isArray(raw)) return null;
  const roles = (raw as readonly unknown[]).filter((r): r is string => typeof r === "string");
  return roles.length === raw.length ? roles : null;
}

async function throwApproveProblem(res: Response): Promise<never> {
  // Read from a clone first, because `throwProblem` consumes the body it parses.
  let doc: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.clone().json();
    if (parsed !== null && typeof parsed === "object") doc = parsed as Record<string, unknown>;
  } catch {
    // A body that is not JSON carries neither fact; `throwProblem` still reports the status.
  }
  try {
    return await throwProblem(res);
  } catch (err) {
    if (err instanceof PlatformError) {
      throw new AccessRequestApproveError(err, readExistingUser(doc), readDeclaredRoles(doc));
    }
    throw err;
  }
}

/**
 * Creates the workspace, its first admin, that admin's membership and password, and the default
 * settings, in one transaction on the server; then, unless `starterChart: false`, the starter chart
 * of accounts and the finance account codes pointed at it (ADR-0465), after that transaction
 * commits — so a chart that fails is reported on the result and never undoes the approval. The
 * response never carries the password; the caller already holds it.
 */
export async function approveAccessRequest(
  id: string,
  body: ApproveAccessRequestBody,
): Promise<ApproveAccessRequestResult> {
  const res = await fetch(platformPath(`/${encodeURIComponent(id)}/approve`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApproveProblem(res);
  return (await res.json()) as ApproveAccessRequestResult;
}

/** `reason` is required (1..500 characters) and is recorded with the decision. */
export async function rejectAccessRequest(
  id: string,
  reason: string,
): Promise<{ readonly id: string; readonly status: string }> {
  return postJson(platformPath(`/${encodeURIComponent(id)}/reject`), { reason });
}

export async function rejectAllPendingAccessRequests(reason: string): Promise<{ readonly rejected: number }> {
  return postJson(platformPath("/reject-pending"), { reason });
}

/**
 * The alphabet a generated password draws from: no `0/O/o`, `1/l/I`, `5/S`, `2/Z` or `8/B`, so a
 * password read aloud or copied off a screen survives the trip. 49 symbols, so 20 of them carry
 * about 112 bits.
 */
const UNAMBIGUOUS_ALPHABET = "abcdefghijkmnpqrtuvwxyzACDEFGHJKLMNPQRTUVWXY34679";

export const GENERATED_PASSWORD_LENGTH = 20;

/**
 * A password from `crypto.getRandomValues`, by rejection sampling so every symbol is equally
 * likely: a bare `% alphabet.length` over a byte would favour the first few symbols, because 256 is
 * not a multiple of the alphabet's size.
 */
export function generatePassword(length: number = GENERATED_PASSWORD_LENGTH): string {
  const n = UNAMBIGUOUS_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= limit) continue;
      out += UNAMBIGUOUS_ALPHABET[byte % n];
      if (out.length === length) break;
    }
  }
  return out;
}
