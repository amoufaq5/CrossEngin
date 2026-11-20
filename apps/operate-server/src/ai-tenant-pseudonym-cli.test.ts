import { describe, expect, it } from "vitest";

import { CliUsageError, helpText, parseServeArgs } from "./cli.js";

describe("parseServeArgs — --ai-tenant-pseudonym (ADR-0461)", () => {
  const base = ["--pack", "erp-core", "--store", "pg", "--ai-design"];

  it("defaults to keyed, which is ADR-0456's behaviour", () => {
    expect(parseServeArgs(base).aiTenantPseudonym).toBe("keyed");
  });

  it.each([
    [["--ai-tenant-pseudonym", "off"], "off"],
    [["--ai-tenant-pseudonym=off"], "off"],
    [["--ai-tenant-pseudonym", "keyed"], "keyed"],
  ])("reads %j", (args, mode) => {
    expect(parseServeArgs([...base, ...args]).aiTenantPseudonym).toBe(mode);
  });

  it.each(["absent", "OFF", "none", ""])("refuses %j, naming both modes", (value) => {
    expect(() => parseServeArgs([...base, `--ai-tenant-pseudonym=${value}`])).toThrow(CliUsageError);
    if (value !== "") {
      expect(() => parseServeArgs([...base, "--ai-tenant-pseudonym", value])).toThrow(/keyed\|off/);
    }
  });

  it("refuses the flag without --ai-design, where nothing would read it", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--store", "pg", "--ai-tenant-pseudonym", "off"]),
    ).toThrow(/requires --ai-design/);
  });

  it("is documented in --help", () => {
    expect(helpText).toContain("--ai-tenant-pseudonym keyed|off");
  });
});
