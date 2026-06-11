import { describe, expect, it } from "vitest";

import { CliUsageError } from "./cli.js";
import { marketplaceHelpText, parseMarketplaceArgs } from "./marketplace-cli.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";

describe("parseMarketplaceArgs (operate-server re-wrap)", () => {
  it("parses list/verify/install/uninstall", () => {
    expect(parseMarketplaceArgs(["list", "--tenant", TENANT]).command).toBe("list");
    expect(parseMarketplaceArgs(["verify", "--tenant", TENANT]).command).toBe("verify");
    expect(parseMarketplaceArgs(["install", "--tenant", TENANT, "--pack", "a.b.c", "--version", "1.0.0", "--by", USER]).pack).toBe("a.b.c");
    expect(parseMarketplaceArgs(["uninstall", "--tenant", TENANT, "--pack", "a.b.c", "--by", USER]).command).toBe("uninstall");
  });

  it("re-wraps the package CliUsageError as operate-server's", () => {
    expect(() => parseMarketplaceArgs(["nope"])).toThrow(CliUsageError);
    expect(() => parseMarketplaceArgs(["list"])).toThrow(CliUsageError); // missing --tenant
    expect(() => parseMarketplaceArgs(["install", "--tenant", TENANT, "--pack", "a.b.c"])).toThrow(CliUsageError);
  });

  it("treats no args / --help as help + exposes the four commands", () => {
    expect(parseMarketplaceArgs([]).help).toBe(true);
    expect(marketplaceHelpText).toContain("marketplace install");
    expect(marketplaceHelpText).toContain("uninstall");
  });
});
