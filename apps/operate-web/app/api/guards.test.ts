import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Moved from packages/testing/src/operate-web.test.ts (ADR-0478). The route handlers import `next`,
// so they are read as text rather than executed; what is pure in them now lives in `lib/` and is
// unit-tested there (`proxy-guard.test.ts`, `upstream.test.ts`).
const WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The route handlers that call the helpers above cannot be run from here (they import `next`), so
 * what is fenced is that they *call* them, read as text with comments stripped — a comment naming a
 * helper must not satisfy the fence that the helper is called.
 */
describe("operate-web route handlers call the guards (M-07)", () => {
  const source = (relative: string): string =>
    readFileSync(`${WEB_ROOT}${relative}`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

  /** Every `.json(` call's argument text, brace-matched to its closing paren. */
  const jsonBodies = (text: string): string[] => {
    const out: string[] = [];
    for (let at = text.indexOf(".json("); at >= 0; at = text.indexOf(".json(", at + 1)) {
      let depth = 0;
      let end = at + ".json".length;
      for (; end < text.length; end += 1) {
        const ch = text[end];
        if (ch === "(") depth += 1;
        if (ch === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(text.slice(at, end + 1));
    }
    return out;
  };

  const PROXY = "app/api/[...path]/route.ts";
  const LOGIN = "app/api/auth/login/route.ts";
  const LOGOUT = "app/api/auth/logout/route.ts";
  /** The public access-request submit (ADR-0464): unauthenticated, so it owes both guards the login does. */
  const REQUEST_ACCESS = "app/api/request-access/route.ts";

  it.each([PROXY, LOGIN, LOGOUT, REQUEST_ACCESS])(
    "%s refuses a cross-site write before it does anything else",
    (file) => {
      const text = source(file);
      const guard = text.indexOf("crossSiteRefusal(provenanceOf(req))");
      expect(guard).toBeGreaterThan(0);
      const firstFetch = text.indexOf("fetch(");
      if (firstFetch >= 0) expect(guard).toBeLessThan(firstFetch);
    },
  );

  it.each([PROXY, LOGIN, REQUEST_ACCESS])("%s caps the body it reads and bounds the upstream wait", (file) => {
    const text = source(file);
    expect(text).toContain("readCappedBody(req, ");
    expect(text).not.toMatch(/req\.(?:text|json|arrayBuffer)\(\)/);
    expect(text).toContain("AbortSignal.timeout(");
  });

  it("names neither the upstream address nor the caught error in any body the proxy returns", () => {
    const bodies = jsonBodies(source(PROXY));
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    for (const body of bodies) {
      expect(body).not.toContain("UPSTREAM_BASE_URL");
      expect(body).not.toMatch(/\berr\b/);
    }
  });

  it("answers with the unit-tested response half, imported rather than respelled", () => {
    const text = source(PROXY);
    expect(text).toContain('from "@/lib/upstream"');
    expect(text).toContain("forwardedResponseHeaders(upstream)");
    expect(text).toContain("NULL_BODY_STATUSES.has(upstream.status)");
    expect(text).not.toMatch(/function forwardedResponseHeaders|new Set\(\[204/);
  });
});
