import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { deriveAiTenantPseudonym, parseCursorEncryptionSecret } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";
import { stripComments } from "@crossengin/testing/strategy";
import { describe, expect, it } from "vitest";

import {
  AI_PSEUDONYM_LOOKUP_ANSWERED,
  AI_PSEUDONYM_LOOKUP_OUTCOMES,
  aiPseudonymLookupHelpText,
  formatAiPseudonymLookupReport,
  matchAiTenantPseudonym,
  parseAiPseudonymLookupArgs,
  runAiPseudonymLookup,
  type LookupTenant,
} from "./ai-pseudonym-lookup.js";
import { resolveAiTenantPseudonymSource } from "./ai-tenant-pseudonym.js";
import { CliUsageError, helpText } from "./cli.js";

const SECRET = "ai-pseudonym-lookup-secret-0123456789abcdefXYZ";
const ENV = { CURSOR_ENCRYPTION_SECRET: SECRET };
const A = "0196f2a8-7c3b-7d4e-9a1b-2c3d4e5f6a7b";
const B = "0196f2a8-7c3b-7d4e-9a1b-2c3d4e5f6a7c";
const GONE = "0196f2a8-7c3b-7d4e-9a1b-2c3d4e5f6a7d";

const TENANTS: readonly LookupTenant[] = [
  { id: A, slug: "acme", status: "active" },
  { id: B, slug: "beta", status: "suspended" },
  { id: GONE, slug: "gone", status: "deleted" },
];

function pseudonymOf(tenantId: string, secret = SECRET): string {
  return deriveAiTenantPseudonym(parseCursorEncryptionSecret(secret), tenantId);
}

interface FakeOptions {
  readonly confined?: unknown;
  readonly tenants?: readonly LookupTenant[];
}

/** Answers the two statements by shape and throws on anything else (CLAUDE.md, ADR-0350). */
function fakeConn(opts: FakeOptions = {}): { conn: PgConnection; sql: string[]; closed: () => boolean } {
  const sql: string[] = [];
  let closed = false;
  const conn: PgConnection = {
    query: async <T,>(text: string, params: readonly unknown[] = []) => {
      assertBindArity(text, params);
      sql.push(text);
      if (text.includes("row_security_active")) {
        return { rows: [{ confined: "confined" in opts ? opts.confined : false }] as unknown as T[], rowCount: 1 };
      }
      if (/FROM meta\.tenants/.test(text)) {
        const rows = opts.tenants ?? TENANTS;
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      throw new Error(`unexpected statement: ${text}`);
    },
    transaction: async () => {
      throw new Error("not used");
    },
    withAdvisoryLock: async () => {
      throw new Error("not used");
    },
    close: async () => {
      closed = true;
    },
  };
  return { conn, sql, closed: () => closed };
}

const options = (pseudonym: string) => ({ pseudonym, schema: null, format: "human" as const, help: false });

describe("parseAiPseudonymLookupArgs", () => {
  it("takes one well-formed pseudonym", () => {
    const p = pseudonymOf(A);
    expect(parseAiPseudonymLookupArgs([p])).toEqual({ pseudonym: p, schema: null, format: "human", help: false });
    expect(parseAiPseudonymLookupArgs([p, "--format=json", "--schema", "meta"]).format).toBe("json");
  });

  it.each([
    ["a raw tenant id", A],
    ["the tenant id with its hyphens removed, unprefixed", A.replaceAll("-", "")],
    ["upper-case hex", `ctp_${"A".repeat(32)}`],
    ["the wrong length", `ctp_${"a".repeat(31)}`],
    ["a different prefix", `ctx_${"a".repeat(32)}`],
  ])("refuses %s before any connection, without quoting it", (_l, value) => {
    expect(() => parseAiPseudonymLookupArgs([value])).toThrow(CliUsageError);
    try {
      parseAiPseudonymLookupArgs([value]);
    } catch (err) {
      expect((err as Error).message).not.toContain(value);
    }
  });

  it("requires a pseudonym, and exactly one", () => {
    expect(() => parseAiPseudonymLookupArgs([])).toThrow(/requires a pseudonym/);
    expect(() => parseAiPseudonymLookupArgs([pseudonymOf(A), pseudonymOf(B)])).toThrow(/exactly one/);
  });

  it("refuses a secret on argv by name, and an unknown option", () => {
    expect(() => parseAiPseudonymLookupArgs([pseudonymOf(A), "--secret", "x"])).toThrow(/readable by anyone/);
    expect(() => parseAiPseudonymLookupArgs([pseudonymOf(A), "--yes"])).toThrow(/unknown option/);
    expect(() => parseAiPseudonymLookupArgs([pseudonymOf(A), "--schema", "meta; drop"])).toThrow(/invalid --schema/);
  });

  it("answers --help without a pseudonym", () => {
    expect(parseAiPseudonymLookupArgs(["--help"]).help).toBe(true);
  });
});

describe("matchAiTenantPseudonym", () => {
  const f = (id: string): string => pseudonymOf(id);

  it("finds the one tenant that derives it, a deleted one included", () => {
    expect(matchAiTenantPseudonym(pseudonymOf(A), f, TENANTS).map((t) => t.id)).toEqual([A]);
    expect(matchAiTenantPseudonym(pseudonymOf(GONE), f, TENANTS).map((t) => t.status)).toEqual(["deleted"]);
  });

  it("finds nothing for another deployment's secret", () => {
    expect(matchAiTenantPseudonym(pseudonymOf(A, `${SECRET}-other`), f, TENANTS)).toEqual([]);
  });

  it("reports every match rather than the first, so a collision cannot hide", () => {
    const collide = (): string => pseudonymOf(A);
    expect(matchAiTenantPseudonym(pseudonymOf(A), collide, TENANTS)).toHaveLength(3);
  });
});

describe("runAiPseudonymLookup", () => {
  it("names the tenant on a match, having asked RLS first, and closes the connection", async () => {
    const fake = fakeConn();
    const report = await runAiPseudonymLookup(options(pseudonymOf(B)), ENV, () => fake.conn);
    expect(report.outcome).toBe("match");
    expect(report.ok).toBe(true);
    expect(report.tenants).toEqual([{ id: B, slug: "beta", status: "suspended" }]);
    expect(report.examined).toBe(3);
    expect(fake.sql[0]).toContain("row_security_active('meta.tenants'::regclass)");
    expect(fake.sql[1]).toContain("FROM meta.tenants");
    expect(fake.sql[1]).not.toMatch(/WHERE/i);
    expect(fake.closed()).toBe(true);
  });

  it("answers no_match under a rotated secret and says why it may be", async () => {
    const fake = fakeConn();
    const report = await runAiPseudonymLookup(
      options(pseudonymOf(A, `${SECRET}-before-rotation`)),
      ENV,
      () => fake.conn,
    );
    expect(report.outcome).toBe("no_match");
    expect(report.ok).toBe(false);
    expect(report.examined).toBe(3);
    expect(report.detail).toContain("rotated");
  });

  it("matches the pseudonym the server derived from an uppercase-spelled tenant id (ADR-0461)", async () => {
    // The server's own mapping, fed the tenant id as an api-key spec may spell it.
    const source = resolveAiTenantPseudonymSource(ENV, "keyed");
    if (source.kind !== "keyed") throw new Error("expected keyed");
    const sent = source.pseudonymFor(B.toUpperCase());
    const report = await runAiPseudonymLookup(options(sent), ENV, () => fakeConn().conn);
    expect(report.outcome).toBe("match");
    expect(report.tenants.map((t) => t.id)).toEqual([B]);
  });

  it("names every cause a no_match cannot rule out", async () => {
    const report = await runAiPseudonymLookup(options(pseudonymOf("not-a-catalogued-tenant")), ENV, () => fakeConn().conn);
    expect(report.outcome).toBe("no_match");
    expect(report.detail).toContain("rotated");
    expect(report.detail).toContain("no meta.tenants row");
    expect(report.detail).toContain("lowercase");
  });

  it("refuses a confined read rather than answering no_match from it", async () => {
    for (const confined of [true, null, "f"]) {
      const fake = fakeConn({ confined, tenants: [] });
      const report = await runAiPseudonymLookup(options(pseudonymOf(A)), ENV, () => fake.conn);
      expect(report.outcome).toBe("read_confined");
      expect(report.examined).toBeNull();
      expect(fake.sql).toHaveLength(1);
      expect(fake.closed()).toBe(true);
    }
  });

  it("reports an ambiguous match and chooses none", async () => {
    const twin = { id: A, slug: "acme-again", status: "active" };
    const fake = fakeConn({ tenants: [...TENANTS, twin] });
    const report = await runAiPseudonymLookup(options(pseudonymOf(A)), ENV, () => fake.conn);
    expect(report.outcome).toBe("ambiguous");
    expect(report.ok).toBe(false);
    expect(report.tenants).toHaveLength(2);
  });

  it.each([
    ["unset", {}],
    ["blank", { CURSOR_ENCRYPTION_SECRET: "   " }],
  ])("refuses an %s secret without connecting", async (_l, env) => {
    let connected = false;
    const report = await runAiPseudonymLookup(options(pseudonymOf(A)), env, () => {
      connected = true;
      return fakeConn().conn;
    });
    expect(report.outcome).toBe("secret_absent");
    expect(connected).toBe(false);
  });

  it("refuses a weak secret without connecting, and never prints it", async () => {
    let connected = false;
    const weak = "short";
    const report = await runAiPseudonymLookup(options(pseudonymOf(A)), { CURSOR_ENCRYPTION_SECRET: weak }, () => {
      connected = true;
      return fakeConn().conn;
    });
    expect(report.outcome).toBe("secret_refused");
    expect(connected).toBe(false);
    expect(formatAiPseudonymLookupReport(report)).not.toContain(`: ${weak}`);
  });

  it("reads the schema it is given", async () => {
    const sql: string[] = [];
    const conn: PgConnection = {
      ...fakeConn().conn,
      query: async <T,>(text: string) => {
        sql.push(text);
        if (text.includes("row_security_active")) return { rows: [{ confined: false }] as unknown as T[], rowCount: 1 };
        return { rows: [] as T[], rowCount: 0 };
      },
    };
    await runAiPseudonymLookup({ ...options(pseudonymOf(A)), schema: "meta2" }, ENV, () => conn);
    expect(sql.join("\n")).toContain("meta2.tenants");
  });
});

describe("the report never carries the secret", () => {
  it("in either format", async () => {
    const report = await runAiPseudonymLookup(options(pseudonymOf(A)), ENV, () => fakeConn().conn);
    expect(formatAiPseudonymLookupReport(report)).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(formatAiPseudonymLookupReport(report)).toContain(A);
  });

  it("is answered by exactly one outcome", () => {
    expect(AI_PSEUDONYM_LOOKUP_OUTCOMES.filter((o) => AI_PSEUDONYM_LOOKUP_ANSWERED[o])).toEqual(["match"]);
  });
});

describe("the subcommand is reachable (text fences)", () => {
  const bin = stripComments(readFileSync(resolve(import.meta.dirname, "../bin/operate-server.ts"), "utf8"));

  it("is dispatched by the binary and listed in the top-level help", () => {
    expect(bin).toContain('argv[0] === "ai-pseudonym-lookup"');
    expect(bin).toContain("runAiPseudonymLookup(options)");
    expect(helpText).toContain("ai-pseudonym-lookup");
  });

  it("is named where an operator reads the pseudonym boot line, beside the off mode", () => {
    const readme = readFileSync(resolve(import.meta.dirname, "../../../deploy/README.md"), "utf8");
    const envExample = readFileSync(resolve(import.meta.dirname, "../../../deploy/.env.example"), "utf8");
    expect(readme).toContain("ai-pseudonym-lookup <ctp_…>");
    expect(readme).toContain("--ai-tenant-pseudonym off");
    expect(readme).toContain("`safety_identifier` on `api.openai.com`");
    expect(envExample).toContain("--ai-tenant-pseudonym off");
  });

  it("documents its exit codes and its env-only secret", () => {
    expect(aiPseudonymLookupHelpText).toContain("CURSOR_ENCRYPTION_SECRET is read from the environment");
    expect(aiPseudonymLookupHelpText).toContain("Exit: 0 on exactly one match");
  });
});
