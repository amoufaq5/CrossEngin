import { describe, expect, it } from "vitest";

import {
  LOGIN_PATH,
  SIGNED_OUT_PARAM,
  SIGNED_OUT_SESSION_OPEN,
  SIGNED_OUT_SESSION_OPEN_NOTICE,
  safeNextPath,
  signOutDestination,
  signOutNotice,
} from "./session";

// Moved from packages/testing/src/operate-web.test.ts (ADR-0478), which ran these from outside the
// app because the app had no runner of its own.
const ORIGIN = "https://erp.example.test";

/** Where a browser on the console's origin actually goes when handed `path`. */
function destination(path: string): string {
  return new URL(path, `${ORIGIN}/login`).origin;
}

describe("operate-web safeNextPath (M-06)", () => {
  it.each([
    ["/e/invoices", "/e/invoices"],
    ["/e/invoices?status=open&limit=50", "/e/invoices?status=open&limit=50"],
    ["/platform/users/abc#members", "/platform/users/abc#members"],
    ["/reports/aging?asOf=2026-11-01", "/reports/aging?asOf=2026-11-01"],
    ["/e/caf%C3%A9", "/e/caf%C3%A9"],
  ])("keeps the same-origin path %j", (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each([
    ["absent", null],
    ["undefined", undefined],
    ["empty", ""],
    ["an absolute URL", "https://evil.test/"],
    ["a scheme", "javascript:alert(1)"],
    ["protocol-relative", "//evil.test"],
    ["backslash", "/\\evil.test"],
    ["tab (the audit's `/%09/evil.com`)", "/\t/evil.test"],
    ["CR", "/\r/evil.test"],
    ["LF", "/\n/evil.test"],
    ["a tab between the slashes and the host", "/\t\t/evil.test"],
    ["a dot segment the parser removes", "/.//evil.test"],
    ["a parent segment the parser removes", "/x/..//evil.test"],
    ["a space", "/ /evil.test"],
    ["a NUL", "/\u0000/evil.test"],
    ["DEL", "/\u007f/evil.test"],
    ["the login page itself", "/login"],
    ["the login page with its own next", "/login?next=//evil.test"],
  ])("refuses %s", (_name, raw) => {
    expect(safeNextPath(raw)).toBe("/");
  });

  // The property the function exists for, over every input above and some adversarial extras: what
  // it returns, handed to a browser on the console's origin, stays on that origin.
  it.each([
    "/\t/evil.test",
    "/\n\r//evil.test",
    "/.//evil.test",
    "/./\\evil.test",
    "/%2F/evil.test",
    "/%09/evil.test",
    "/%5C%5Cevil.test",
    "/x/../..//evil.test",
    "/@evil.test",
    "/e/x?next=//evil.test",
  ])("never yields an off-origin navigation for %j", (raw) => {
    const out = safeNextPath(raw);
    expect(out.startsWith("/")).toBe(true);
    expect(out.startsWith("//")).toBe(false);
    expect(destination(out)).toBe(ORIGIN);
  });
});


describe("sign-out outcome (ADR-0478)", () => {
  it("warns only when the server says it could not end the session", () => {
    expect(signOutDestination({ ok: true, ended: false })).toBe(
      `${LOGIN_PATH}?${SIGNED_OUT_PARAM}=${SIGNED_OUT_SESSION_OPEN}`,
    );
    expect(signOutDestination({ ok: true, ended: true })).toBe(LOGIN_PATH);
    // No session cookie: nothing to end, which is not a session left open.
    expect(signOutDestination({ ok: true, ended: null })).toBe(LOGIN_PATH);
  });

  it("claims nothing from a body it cannot read", () => {
    for (const body of [null, undefined, "x", 1, {}, { ended: "false" }, { ended: 0 }]) {
      expect(signOutDestination(body)).toBe(LOGIN_PATH);
    }
  });

  it("round-trips through the login page's reader", () => {
    const search = new URL(signOutDestination({ ended: false }), "https://x.test").search;
    expect(signOutNotice(search)).toBe(SIGNED_OUT_SESSION_OPEN_NOTICE);
    expect(SIGNED_OUT_SESSION_OPEN_NOTICE).toContain("could not be ended");
    expect(SIGNED_OUT_SESSION_OPEN_NOTICE).toContain("time limit");
    expect(signOutNotice("")).toBeNull();
    expect(signOutNotice(`?${SIGNED_OUT_PARAM}=other`)).toBeNull();
  });
});
