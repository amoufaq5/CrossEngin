import { describe, expect, it } from "vitest";

import {
  ACCESS_REQUEST_PRIVACY_URL_VAR,
  ACCESS_REQUEST_TERMS_URL_VAR,
  ACCESS_REQUEST_TERMS_VERSION_VAR,
  formatAccessRequestBootLine,
  resolveAccessRequestIntake,
} from "./access-request-env.js";

const ALL = {
  [ACCESS_REQUEST_TERMS_URL_VAR]: "https://example.test/terms",
  [ACCESS_REQUEST_PRIVACY_URL_VAR]: "https://example.test/privacy",
  [ACCESS_REQUEST_TERMS_VERSION_VAR]: "2026-11",
};

describe("resolveAccessRequestIntake", () => {
  it("opens with all three", () => {
    expect(resolveAccessRequestIntake(ALL)).toEqual({
      kind: "open",
      terms: {
        termsUrl: "https://example.test/terms",
        privacyUrl: "https://example.test/privacy",
        termsVersion: "2026-11",
      },
    });
  });

  it("is closed with none, including blank values", () => {
    expect(resolveAccessRequestIntake({})).toEqual({ kind: "closed" });
    expect(resolveAccessRequestIntake({ [ACCESS_REQUEST_TERMS_URL_VAR]: "  " })).toEqual({ kind: "closed" });
  });

  it("refuses a partial set, naming what is missing", () => {
    const out = resolveAccessRequestIntake({ [ACCESS_REQUEST_TERMS_URL_VAR]: ALL[ACCESS_REQUEST_TERMS_URL_VAR] });
    expect(out.kind).toBe("refused");
    expect(out.kind === "refused" ? out.reason : "").toContain(
      `missing: ${ACCESS_REQUEST_PRIVACY_URL_VAR}, ${ACCESS_REQUEST_TERMS_VERSION_VAR}`,
    );
  });

  it("refuses plain http except for localhost", () => {
    expect(
      resolveAccessRequestIntake({ ...ALL, [ACCESS_REQUEST_TERMS_URL_VAR]: "http://example.test/terms" }).kind,
    ).toBe("refused");
    expect(
      resolveAccessRequestIntake({ ...ALL, [ACCESS_REQUEST_TERMS_URL_VAR]: "http://localhost:3000/terms" }).kind,
    ).toBe("open");
    expect(resolveAccessRequestIntake({ ...ALL, [ACCESS_REQUEST_PRIVACY_URL_VAR]: "not a url" }).kind).toBe(
      "refused",
    );
  });

  it("refuses a version that could not travel in a request body plainly", () => {
    expect(resolveAccessRequestIntake({ ...ALL, [ACCESS_REQUEST_TERMS_VERSION_VAR]: "v 1" }).kind).toBe("refused");
  });
});

describe("formatAccessRequestBootLine", () => {
  it("says both states", () => {
    const open = resolveAccessRequestIntake(ALL);
    if (open.kind === "refused") throw new Error("unexpected");
    expect(formatAccessRequestBootLine({ resolution: open, maxPending: 200, ttlHours: 72, retentionDays: 30 })).toBe(
      "[access-request] intake open (terms v2026-11), queue ceiling 200, requests expire after 72h, " +
        "decided requests kept 30d; approving needs platform-admin + platform-user + credential-admin grants",
    );
    expect(
      formatAccessRequestBootLine({ resolution: { kind: "closed" }, maxPending: 200, ttlHours: 72, retentionDays: 30 }),
    ).toMatch(/^\[access-request\] intake CLOSED: set ACCESS_REQUEST_TERMS_URL, /);
  });
});
