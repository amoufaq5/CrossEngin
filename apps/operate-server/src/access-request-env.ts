import type { AccessRequestTerms } from "./access-requests.js";

/**
 * Where the public intake's terms come from (ADR-0464). From the environment and never argv: these
 * are not secrets, but they are a deployment's legal text, and one route for them beside the other
 * deployment variables is easier to keep consistent than a flag nobody else in `deploy/` sets.
 *
 * All three or none. A partial set is refused at boot rather than treated as closed, because an
 * operator who set two of three meant to open the intake and would otherwise be told nothing until
 * a customer reported a 503.
 */

export const ACCESS_REQUEST_TERMS_URL_VAR = "ACCESS_REQUEST_TERMS_URL";
export const ACCESS_REQUEST_PRIVACY_URL_VAR = "ACCESS_REQUEST_PRIVACY_URL";
export const ACCESS_REQUEST_TERMS_VERSION_VAR = "ACCESS_REQUEST_TERMS_VERSION";

export const ACCESS_REQUEST_ENV_VARS = [
  ACCESS_REQUEST_TERMS_URL_VAR,
  ACCESS_REQUEST_PRIVACY_URL_VAR,
  ACCESS_REQUEST_TERMS_VERSION_VAR,
] as const;

export type AccessRequestIntakeResolution =
  | { readonly kind: "open"; readonly terms: AccessRequestTerms }
  | { readonly kind: "closed" }
  | { readonly kind: "refused"; readonly reason: string };

/** A local host may be served over plain http; anything a customer reaches must be https. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

function urlRefusal(name: string, value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${name} is not a URL`;
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return null;
  return `${name} must be an https URL (http is accepted only for localhost)`;
}

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function resolveAccessRequestIntake(
  env: Readonly<Record<string, string | undefined>>,
): AccessRequestIntakeResolution {
  const read = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v === undefined || v === "" ? undefined : v;
  };
  const termsUrl = read(ACCESS_REQUEST_TERMS_URL_VAR);
  const privacyUrl = read(ACCESS_REQUEST_PRIVACY_URL_VAR);
  const termsVersion = read(ACCESS_REQUEST_TERMS_VERSION_VAR);
  const values = [termsUrl, privacyUrl, termsVersion];
  if (values.every((v) => v === undefined)) return { kind: "closed" };
  if (termsUrl === undefined || privacyUrl === undefined || termsVersion === undefined) {
    const missing = ACCESS_REQUEST_ENV_VARS.filter((_, i) => values[i] === undefined);
    return {
      kind: "refused",
      reason:
        `the access-request intake needs all three of ${ACCESS_REQUEST_ENV_VARS.join(", ")}; ` +
        `missing: ${missing.join(", ")}`,
    };
  }
  const bad =
    urlRefusal(ACCESS_REQUEST_TERMS_URL_VAR, termsUrl) ??
    urlRefusal(ACCESS_REQUEST_PRIVACY_URL_VAR, privacyUrl);
  if (bad !== null) return { kind: "refused", reason: bad };
  if (!VERSION_RE.test(termsVersion)) {
    return {
      kind: "refused",
      reason:
        `${ACCESS_REQUEST_TERMS_VERSION_VAR} must be 1..64 characters of letters, digits, '.', ` +
        "'_' or '-', starting with a letter or digit",
    };
  }
  return { kind: "open", terms: { termsUrl, privacyUrl, termsVersion } };
}

export interface AccessRequestBootLineInput {
  readonly resolution: Exclude<AccessRequestIntakeResolution, { kind: "refused" }>;
  readonly maxPending: number;
  readonly ttlHours: number;
  readonly retentionDays: number;
}

/** Said either way, so a closed intake reads as a decision rather than as a forgotten mount. */
export function formatAccessRequestBootLine(input: AccessRequestBootLineInput): string {
  if (input.resolution.kind === "closed") {
    return (
      `[access-request] intake CLOSED: set ${ACCESS_REQUEST_ENV_VARS.join(", ")} to open it; ` +
      "the platform routes still list and decide existing requests"
    );
  }
  return (
    `[access-request] intake open (terms v${input.resolution.terms.termsVersion}), ` +
    `queue ceiling ${input.maxPending.toString()}, ` +
    `requests expire after ${input.ttlHours.toString()}h, ` +
    `decided requests kept ${input.retentionDays.toString()}d; ` +
    "approving needs platform-admin + platform-user + credential-admin grants"
  );
}
