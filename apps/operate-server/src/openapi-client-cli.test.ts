import { describe, expect, it } from "vitest";

import { CliUsageError } from "./cli.js";
import { parseOpenApiClientArgs } from "./openapi-client-cli.js";

describe("parseOpenApiClientArgs", () => {
  it("defaults lang to ts + emitRun false", () => {
    const o = parseOpenApiClientArgs(["--pack", "erp-retail"]);
    expect(o.pack).toBe("erp-retail");
    expect(o.lang).toBe("ts");
    expect(o.emitRun).toBe(false);
    expect(o.out).toBeNull();
  });

  it("parses --lang python|go + --out + --client-name + --emit-run", () => {
    const o = parseOpenApiClientArgs(["--pack", "erp-retail", "--lang", "go", "--out", "c.go", "--client-name", "rc", "--emit-run"]);
    expect(o.lang).toBe("go");
    expect(o.out).toBe("c.go");
    expect(o.clientName).toBe("rc");
    expect(o.emitRun).toBe(true);
  });

  it("supports --flag=value form", () => {
    const o = parseOpenApiClientArgs(["--manifest=m.json", "--lang=python"]);
    expect(o.manifestPath).toBe("m.json");
    expect(o.lang).toBe("python");
  });

  it("rejects an invalid --lang", () => {
    expect(() => parseOpenApiClientArgs(["--pack", "x", "--lang", "rust"])).toThrow(CliUsageError);
  });

  it("requires exactly one of --pack / --manifest", () => {
    expect(() => parseOpenApiClientArgs(["--lang", "ts"])).toThrow(CliUsageError);
    expect(() => parseOpenApiClientArgs(["--pack", "x", "--manifest", "m.json"])).toThrow(CliUsageError);
  });

  it("parses --release-version + --publish-by", () => {
    const o = parseOpenApiClientArgs(["--pack", "erp-retail", "--release-version", "1.0.0", "--publish-by", "bot"]);
    expect(o.releaseVersion).toBe("1.0.0");
    expect(o.publishBy).toBe("bot");
  });

  it("requires --release-version when --publish-by is given", () => {
    expect(() => parseOpenApiClientArgs(["--pack", "x", "--publish-by", "bot"])).toThrow(CliUsageError);
  });

  it("parses --persist (requires --release-version)", () => {
    const o = parseOpenApiClientArgs(["--pack", "erp-retail", "--release-version", "1.0.0", "--persist"]);
    expect(o.persist).toBe(true);
    expect(() => parseOpenApiClientArgs(["--pack", "x", "--persist"])).toThrow(CliUsageError);
  });

  it("does not require a manifest source for --help", () => {
    expect(parseOpenApiClientArgs(["--help"]).help).toBe(true);
  });
});
