import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `deploy/onboard-tenant.sh` is not typechecked, linted or imported by anything, so a deleted line
 * there is invisible to every rule and every test (ADR-0376's reason for fencing `deploy/` as text).
 * These assert the properties ADR-0479's `--existing` form rests on, as text, with a floor that the
 * file is the one being read.
 */
const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(here, "../../../deploy/onboard-tenant.sh"), "utf8");

/** The script with `#` comments removed, so prose quoting a command cannot satisfy a fence. */
const code = script
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

/** The text of the `if [ -n "$EXISTING" ]; then … else` arm that resolves the tenant. */
function existingTenantArm(): string {
  const start = code.indexOf('if [ -n "$EXISTING" ]; then\n  # Read first');
  const fromComment = start === -1 ? code.indexOf('if [ -n "$EXISTING" ]; then\n  TENANT_JSON=$(get') : start;
  const end = code.indexOf("\nelse\n", fromComment);
  if (fromComment === -1 || end === -1) throw new Error("the --existing tenant arm is not where this fence looks");
  return code.slice(fromComment, end);
}

describe("deploy/onboard-tenant.sh --existing (ADR-0479)", () => {
  it("is the script this fence means to read", () => {
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(code).toContain('if [ "${1:-}" = "--existing" ]; then');
  });

  it("refuses an --existing value that is not a uuid before any request", () => {
    expect(code).toMatch(/--existing takes a tenant id \(a uuid\), not a slug/);
    const refusal = code.indexOf("--existing takes a tenant id");
    const firstRequest = code.search(/\b(get|post) "?\/v1\//);
    expect(refusal).toBeGreaterThan(-1);
    expect(firstRequest).toBeGreaterThan(refusal);
  });

  it("reads the tenant and refuses one that is not active, and creates no tenant in that arm", () => {
    const arm = existingTenantArm();
    expect(arm).toContain('get "/v1/platform/tenants/$EXISTING"');
    expect(arm).toMatch(/if \[ "\$STATUS" != "active" \]; then[\s\S]*exit 1/);
    expect(arm).not.toContain("post /v1/platform/tenants");
  });

  it("does not touch the starter chart for an existing workspace", () => {
    const chart = code.indexOf("/starter-chart");
    const guard = code.indexOf('if [ -n "$EXISTING" ]; then\n  echo "chart    not touched (--existing)');
    expect(guard).toBeGreaterThan(-1);
    // The guard precedes the only chart request, so the chart is reachable only in the `elif`s.
    const chartCall = code.indexOf('post "/v1/platform/tenants/$TENANT_ID/starter-chart"');
    expect(chartCall).toBeGreaterThan(guard);
    expect(chart).toBeGreaterThan(-1);
  });

  it("stops before the password when the server warns about the role, in both forms", () => {
    const warnExit = code.indexOf('stopped before setting a password');
    const password = code.indexOf("PASSWORD=$(python3");
    expect(warnExit).toBeGreaterThan(-1);
    expect(password).toBeGreaterThan(warnExit);
    // One provisioning call for both forms, so the warning check is shared rather than spelled twice.
    expect(code.match(/post \/v1\/platform\/users "\$USER_BODY"/g)).toHaveLength(1);
  });

  it("keeps every body on stdin and the admin key in a header file, never on argv", () => {
    expect(code).toContain("--data-binary @-");
    expect(code).toContain('-H @"$HDR"');
    expect(code).not.toMatch(/-H "x-api-key: \$ADMIN"/);
    expect(code).not.toMatch(/--data(-raw)? "\$/);
    // The password reaches python through the environment, not argv.
    expect(code).toMatch(/PW="\$PASSWORD" UID_="\$USER_ID" python3 -c/);
  });
});
