import { describe, expect, it } from "vitest";

import { parseArgs, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { runLicense } from "./license.js";

function buffers(): { ctx: RunContext; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: RunContext = {
    io: { stdout: { write: (c: string) => out.push(c) }, stderr: { write: (c: string) => err.push(c) } },
    env: {},
  };
  return { ctx, out: () => out.join(""), err: () => err.join("") };
}

function parsed(...argv: string[]): ParsedCommand {
  const result = parseArgs(["node", "crossengin", ...argv]);
  if (!result.ok) throw new Error(result.error.message);
  return result.command;
}

const TENANT = "11111111-1111-1111-1111-111111111111";

async function keypair(): Promise<{ pub: string; priv: string }> {
  const { ctx, out } = buffers();
  const code = await runLicense(parsed("license", "keygen", "--format", "json"), ctx);
  expect(code).toBe(0);
  const keys = JSON.parse(out()) as { publicKeyBase64: string; privateKeyBase64: string };
  return { pub: keys.publicKeyBase64, priv: keys.privateKeyBase64 };
}

describe("crossengin license", () => {
  it("keygen prints a public + private Ed25519 keypair", async () => {
    const { pub, priv } = await keypair();
    expect(pub.length).toBeGreaterThan(20);
    expect(priv.length).toBeGreaterThan(20);
    expect(pub).not.toBe(priv);
  });

  it("mint produces a token that inspect verifies with matching claims", async () => {
    const { pub, priv } = await keypair();
    const mint = buffers();
    const mintCode = await runLicense(
      parsed(
        "license", "mint",
        "--tenant", TENANT,
        "--status", "active",
        "--plan", "pro",
        "--issued", "2026-01-01T00:00:00.000Z",
        "--expires", "2099-01-01T00:00:00.000Z",
        "--max-records-per-entity", "500",
        "--private-key", priv,
        "--public-key", pub,
      ),
      mint.ctx,
    );
    expect(mintCode).toBe(0);
    const token = mint.out().trim();
    expect(token).toContain(".");

    const inspect = buffers();
    const inspectCode = await runLicense(
      parsed("license", "inspect", token, "--public-key", pub, "--format", "json"),
      inspect.ctx,
    );
    expect(inspectCode).toBe(0);
    const result = JSON.parse(inspect.out()) as { valid: boolean; claims?: Record<string, unknown> };
    expect(result.valid).toBe(true);
    expect(result.claims).toMatchObject({ tenantId: TENANT, status: "active", planId: "pro", maxRecordsPerEntity: 500 });
  });

  it("inspect reports an expired token as invalid (exit 1)", async () => {
    const { pub, priv } = await keypair();
    const mint = buffers();
    await runLicense(
      parsed(
        "license", "mint",
        "--tenant", TENANT,
        "--issued", "2000-01-01T00:00:00.000Z",
        "--expires", "2000-02-01T00:00:00.000Z",
        "--private-key", priv,
        "--public-key", pub,
      ),
      mint.ctx,
    );
    const token = mint.out().trim();
    const inspect = buffers();
    const code = await runLicense(parsed("license", "inspect", token, "--public-key", pub, "--format", "json"), inspect.ctx);
    expect(code).toBe(1);
    expect((JSON.parse(inspect.out()) as { valid: boolean; reason?: string })).toMatchObject({ valid: false, reason: "expired" });
  });

  it("inspect fails a tampered token", async () => {
    const { pub, priv } = await keypair();
    const mint = buffers();
    await runLicense(
      parsed("license", "mint", "--tenant", TENANT, "--issued", "2026-01-01T00:00:00.000Z", "--expires", "2099-01-01T00:00:00.000Z", "--private-key", priv, "--public-key", pub),
      mint.ctx,
    );
    const token = mint.out().trim();
    const tampered = `${token}x`;
    const inspect = buffers();
    const code = await runLicense(parsed("license", "inspect", tampered, "--public-key", pub, "--format", "json"), inspect.ctx);
    expect(code).toBe(1);
    expect((JSON.parse(inspect.out()) as { valid: boolean }).valid).toBe(false);
  });

  it("mint without --tenant exits 2 with a usage error", async () => {
    const { ctx, err } = buffers();
    const code = await runLicense(parsed("license", "mint", "--expires", "2099-01-01T00:00:00.000Z", "--private-key", "x", "--public-key", "y"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("--tenant");
  });

  it("an unknown action exits 2", async () => {
    const { ctx } = buffers();
    expect(await runLicense(parsed("license", "frobnicate"), ctx)).toBe(2);
  });

  it("inspect without a token exits 2", async () => {
    const { ctx } = buffers();
    expect(await runLicense(parsed("license", "inspect", "--public-key", "y"), ctx)).toBe(2);
  });
});
