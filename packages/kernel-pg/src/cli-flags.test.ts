import { describe, expect, it } from "vitest";

import { parseFlags, parseNonNegativeIntegerFlag } from "./cli-flags.js";

const SPEC = { plan: "boolean", confirm: "boolean", "lock-timeout-ms": "value" } as const;

describe("parseFlags", () => {
  it("accepts a bare boolean and both value spellings", () => {
    const r = parseFlags(["--plan", "--lock-timeout-ms", "250"], SPEC);
    expect(r.ok && [...r.flags.booleans]).toEqual(["plan"]);
    expect(r.ok && r.flags.values.get("lock-timeout-ms")).toBe("250");
    const eq = parseFlags(["--lock-timeout-ms=250"], SPEC);
    expect(eq.ok && eq.flags.values.get("lock-timeout-ms")).toBe("250");
  });

  it("reads --plan=true as plan and --plan=false as not plan", () => {
    // The parser this replaces dropped `--plan=true` entirely, so the command applied.
    const on = parseFlags(["--plan=true"], SPEC);
    expect(on.ok && on.flags.booleans.has("plan")).toBe(true);
    const off = parseFlags(["--plan=false"], SPEC);
    expect(off.ok && off.flags.booleans.has("plan")).toBe(false);
    expect(off.ok).toBe(true);
  });

  it("refuses a boolean value it cannot read, rather than reading it as false", () => {
    expect(parseFlags(["--plan=yes"], SPEC)).toEqual({
      ok: false,
      error: "--plan takes no value, or =true / =false; got 'yes'",
    });
  });

  it("refuses an unknown flag, including a misspelling of a known one", () => {
    expect(parseFlags(["--paln"], SPEC)).toEqual({ ok: false, error: "unknown flag --paln" });
    expect(parseFlags(["--"], SPEC)).toEqual({ ok: false, error: "unknown flag --" });
  });

  it("does not answer a prototype member as a known flag", () => {
    expect(parseFlags(["--constructor"], SPEC).ok).toBe(false);
    expect(parseFlags(["--toString"], SPEC).ok).toBe(false);
  });

  it("refuses a flag given twice", () => {
    expect(parseFlags(["--plan", "--plan=false"], SPEC)).toEqual({
      ok: false,
      error: "--plan given more than once",
    });
  });

  it("refuses a value flag with nothing after it", () => {
    expect(parseFlags(["--lock-timeout-ms"], SPEC)).toEqual({
      ok: false,
      error: "--lock-timeout-ms needs a value",
    });
    expect(parseFlags(["--lock-timeout-ms", "--plan"], SPEC).ok).toBe(false);
  });

  it("collects positionals and leaves a boolean's neighbour positional", () => {
    const r = parseFlags(["--plan", "extra"], SPEC);
    expect(r.ok && r.flags.positional).toEqual(["extra"]);
  });
});

describe("parseNonNegativeIntegerFlag", () => {
  it.each([
    ["0", 0],
    ["5000", 5000],
  ])("accepts %s", (raw, value) => {
    expect(parseNonNegativeIntegerFlag("x", raw)).toEqual({ ok: true, value });
  });

  it.each(["", "-1", "1.5", "1e3", " 5", "5s", "99999999999999999999"])("refuses '%s'", (raw) => {
    expect(parseNonNegativeIntegerFlag("x", raw).ok).toBe(false);
  });
});
