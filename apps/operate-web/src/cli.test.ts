import { describe, expect, it } from "vitest";

import { CliUsageError, parseWebArgs } from "./cli.js";

describe("parseWebArgs", () => {
  it("parses --pack with defaults", () => {
    const opts = parseWebArgs(["--pack", "erp-retail"]);
    expect(opts.pack).toBe("erp-retail");
    expect(opts.port).toBe(8788);
    expect(opts.manifestPath).toBeNull();
  });

  it("supports inline --flag=value and repeated --api-key", () => {
    const opts = parseWebArgs(["--pack=erp-retail", "--port=9000", "--api-key", "a:r:t", "--api-key=b:r2:t"]);
    expect(opts.port).toBe(9000);
    expect(opts.apiKeys).toEqual(["a:r:t", "b:r2:t"]);
  });

  it("requires exactly one manifest source", () => {
    expect(() => parseWebArgs([])).toThrow(CliUsageError);
    expect(() => parseWebArgs(["--pack", "x", "--manifest", "f.json"])).toThrow(CliUsageError);
  });

  it("does not require a source for --help / --version", () => {
    expect(parseWebArgs(["--help"]).help).toBe(true);
    expect(parseWebArgs(["-v"]).version).toBe(true);
  });

  it("rejects an unknown flag + a bad port", () => {
    expect(() => parseWebArgs(["--pack", "x", "--what"])).toThrow(CliUsageError);
    expect(() => parseWebArgs(["--pack", "x", "--port", "70000"])).toThrow(CliUsageError);
  });

  it("parses JWKS + JWT flags", () => {
    const opts = parseWebArgs([
      "--pack",
      "erp-retail",
      "--jwks-key",
      "k1:AAAA",
      "--jwks-key=k2:BBBB",
      "--jwt-issuer",
      "https://idp/",
      "--jwt-audience=https://api/",
    ]);
    expect(opts.jwksKeys).toEqual(["k1:AAAA", "k2:BBBB"]);
    expect(opts.jwtIssuer).toBe("https://idp/");
    expect(opts.jwtAudience).toBe("https://api/");
  });

  it("requires issuer + audience when a JWKS is configured", () => {
    expect(() => parseWebArgs(["--pack", "x", "--jwks-key", "k1:AAAA"])).toThrow(CliUsageError);
    expect(() => parseWebArgs(["--pack", "x", "--jwks-url", "https://idp/jwks", "--jwt-issuer", "i"])).toThrow(
      CliUsageError,
    );
  });

  it("rejects conflicting JWKS sources", () => {
    expect(() =>
      parseWebArgs([
        "--pack",
        "x",
        "--jwks-key",
        "k1:AAAA",
        "--jwks-file",
        "f.json",
        "--jwt-issuer",
        "i",
        "--jwt-audience",
        "a",
      ]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseWebArgs([
        "--pack",
        "x",
        "--jwks-url",
        "https://idp/jwks",
        "--jwks-key",
        "k1:AAAA",
        "--jwt-issuer",
        "i",
        "--jwt-audience",
        "a",
      ]),
    ).toThrow(CliUsageError);
  });
});
