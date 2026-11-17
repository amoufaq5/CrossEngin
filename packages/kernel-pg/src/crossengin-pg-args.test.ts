import { describe, expect, it } from "vitest";

import { CROSSENGIN_PG_COMMANDS, CROSSENGIN_PG_FLAGS, parseCrossenginPgArgs } from "./crossengin-pg-args.js";

const argv = (...args: string[]): string[] => ["node", "crossengin-pg", ...args];

describe("parseCrossenginPgArgs (H-23)", () => {
  it("shows help for no command, help, and --help", () => {
    for (const a of [argv(), argv("help"), argv("--help"), argv("apply", "--help")]) {
      const r = parseCrossenginPgArgs(a);
      expect(r.ok && r.command).toBe("help");
    }
  });

  it("refuses an unknown command rather than printing help and exiting 0", () => {
    // Measured before the fix: `crossengin-pg aply` printed help and exited 0.
    expect(parseCrossenginPgArgs(argv("aply"))).toEqual({ ok: false, error: "unknown command 'aply'" });
  });

  it("refuses an unknown or misspelt apply flag", () => {
    // Measured before the fix: `apply --paln` applied.
    expect(parseCrossenginPgArgs(argv("apply", "--paln"))).toEqual({
      ok: false,
      error: "apply: unknown flag --paln",
    });
  });

  it("reads --plan=true as a plan", () => {
    // Measured before the fix: `apply --plan=true` executed a statement.
    const r = parseCrossenginPgArgs(argv("apply", "--plan=true"));
    expect(r.ok && r.flags.booleans.has("plan")).toBe(true);
  });

  it("refuses a flag on the command that does not read it", () => {
    expect(parseCrossenginPgArgs(argv("drift", "--confirm")).ok).toBe(false);
    expect(parseCrossenginPgArgs(argv("inspect", "--lock-timeout-ms=1")).ok).toBe(false);
  });

  it("refuses a stray positional", () => {
    expect(parseCrossenginPgArgs(argv("apply", "now"))).toEqual({
      ok: false,
      error: "apply: unexpected argument 'now'",
    });
  });

  it("parses the bounds as whole numbers in both spellings", () => {
    const r = parseCrossenginPgArgs(
      argv("apply", "--lock-timeout-ms=0", "--statement-timeout-ms", "60000", "--lock-retries=1"),
    );
    expect(r.ok && r.bounds).toEqual({ lockTimeoutMs: 0, statementTimeoutMs: 60000, lockRetries: 1 });
    expect(parseCrossenginPgArgs(argv("apply", "--lock-timeout-ms=5s")).ok).toBe(false);
  });

  it("leaves an absent bound absent, so the library default applies", () => {
    const r = parseCrossenginPgArgs(argv("apply", "--confirm"));
    expect(r.ok && r.bounds).toEqual({});
  });

  it("keeps encrypt's value flags in both spellings", () => {
    const r = parseCrossenginPgArgs(argv("encrypt", "--plan", "--schema", "tenant_x", "--key-ref=k"));
    expect(r.ok && r.flags.values.get("schema")).toBe("tenant_x");
    expect(r.ok && r.flags.values.get("key-ref")).toBe("k");
  });

  it("declares every command's flags", () => {
    expect(Object.keys(CROSSENGIN_PG_FLAGS).sort()).toEqual([...CROSSENGIN_PG_COMMANDS].sort());
  });
});
