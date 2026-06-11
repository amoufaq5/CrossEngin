import { describe, expect, it } from "vitest";

import { CliUsageError } from "./cli.js";
import { parseSdkReleasesArgs, sdkReleasesHelpText } from "./sdk-releases-cli.js";

describe("parseSdkReleasesArgs (operate-server re-wrap)", () => {
  it("parses list/compat/verify", () => {
    expect(parseSdkReleasesArgs(["list", "--language", "go"]).command).toBe("list");
    expect(parseSdkReleasesArgs(["compat", "--api-version", "v1"]).apiVersion).toBe("v1");
    expect(parseSdkReleasesArgs(["verify"]).command).toBe("verify");
  });

  it("re-wraps the package CliUsageError as operate-server's", () => {
    expect(() => parseSdkReleasesArgs(["nope"])).toThrow(CliUsageError);
    expect(() => parseSdkReleasesArgs(["list", "--language", "cobol"])).toThrow(CliUsageError);
  });

  it("treats no args / --help as help", () => {
    expect(parseSdkReleasesArgs([]).help).toBe(true);
    expect(parseSdkReleasesArgs(["verify", "--help"]).help).toBe(true);
  });

  it("exposes help text mentioning the three commands", () => {
    expect(sdkReleasesHelpText).toContain("sdk-releases list");
    expect(sdkReleasesHelpText).toContain("verify");
  });
});
