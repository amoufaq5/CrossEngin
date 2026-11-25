import { TENANT_LIFECYCLE_STATES, blocksWrites } from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import { tenantStandingFromDirectory } from "./job-tenant-standing.js";

const T = "00000000-0000-4000-8000-000000000001";

describe("tenantStandingFromDirectory (ADR-0469)", () => {
  it("answers writable exactly for the states blocksWrites admits, and blocked with the state otherwise", async () => {
    for (const state of TENANT_LIFECYCLE_STATES) {
      const read = tenantStandingFromDirectory({ statusFor: async () => state });
      const standing = await read(T);
      expect(standing).toEqual(blocksWrites(state) ? { kind: "blocked", status: state } : { kind: "writable" });
    }
  });

  it("names pending_deletion, the state the deployment depends on refusing", async () => {
    const read = tenantStandingFromDirectory({ statusFor: async () => "pending_deletion" });
    expect(await read(T)).toEqual({ kind: "blocked", status: "pending_deletion" });
  });

  it("refuses a tenant with no row rather than guessing it writable", async () => {
    const read = tenantStandingFromDirectory({ statusFor: async () => null });
    expect(await read(T)).toEqual({ kind: "blocked", status: "unprovisioned" });
  });

  it("answers unknown, never writable, when the directory throws", async () => {
    const read = tenantStandingFromDirectory({
      statusFor: async () => {
        throw new Error("connection refused");
      },
    });
    expect(await read(T)).toEqual({ kind: "unknown", reason: "connection refused" });
  });

  it("asks about the tenant it was given", async () => {
    const asked: string[] = [];
    const read = tenantStandingFromDirectory({
      statusFor: async (id) => {
        asked.push(id);
        return "active";
      },
    });
    await read(T);
    expect(asked).toEqual([T]);
  });
});

describe("the job worker serves every registered handler, not only the produced ones (ADR-0469's review)", () => {
  // As text, because no type can ask which set gates the worker. `servedJobIds` drops a declaration
  // whose producer this process does not mount, so a worker-only replica on a split fleet served
  // nothing and left every run the other replica enqueued `pending` for ever (measured live).
  it("gates the job engine and its claim scope on the registry, and the admission refusal with them", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./node.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const executableJobIds = manifestJobs\s*\.filter\(\(j\) => jobHandlers\.registry\.resolve\(j\.id, j\.trigger\.kind\) !== undefined\)/);
    expect(src).toContain("jobServes: { jobIds: executableJobIds }");
    expect(src).not.toContain("jobServes: { jobIds: jobHandlers.servedJobIds }");
    expect(src).toMatch(/\.\.\.\(executableJobIds\.length > 0\s*\?\s*\{\s*jobEngine: new PostgresJobRunEngine/);
    expect(src).toMatch(/const jobWorkerExecutes = [^;]*executableJobIds\.length > 0;/);
  });
});
