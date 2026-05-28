import { describe, expect, it } from "vitest";

import {
  SUBCOMMANDS,
  getBooleanFlag,
  getStringFlag,
  helpText,
  isSubcommand,
  parseArgs,
} from "./cli.js";

function argv(...args: string[]): string[] {
  return ["node", "crossengin", ...args];
}

describe("SUBCOMMANDS", () => {
  it("contains the expected commands", () => {
    expect(SUBCOMMANDS).toEqual([
      "init",
      "validate",
      "diff",
      "patch",
      "hash",
      "apply",
      "chat",
      "sessions",
      "gateway",
      "retention",
      "workflow",
      "version",
      "help",
    ]);
  });
});

describe("isSubcommand", () => {
  it("accepts known values", () => {
    expect(isSubcommand("validate")).toBe(true);
    expect(isSubcommand("apply")).toBe(true);
  });
  it("rejects unknown values", () => {
    expect(isSubcommand("encrypt")).toBe(false);
    expect(isSubcommand(undefined)).toBe(false);
    expect(isSubcommand(42)).toBe(false);
  });
});

describe("parseArgs — no subcommand", () => {
  it("returns help when called with no args", () => {
    const result = parseArgs(argv());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.subcommand).toBe("help");
    }
  });
});

describe("parseArgs — subcommand routing", () => {
  it("routes to the named subcommand", () => {
    const result = parseArgs(argv("validate", "manifest.json"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.subcommand).toBe("validate");
      expect(result.command.positional).toEqual(["manifest.json"]);
    }
  });

  it("rejects an unknown subcommand", () => {
    const result = parseArgs(argv("encrypt"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("unknown subcommand: encrypt");
    }
  });
});

describe("parseArgs — flags", () => {
  it("parses --key=value", () => {
    const result = parseArgs(argv("validate", "x.json", "--format=json"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.flags.get("format")).toBe("json");
      expect(result.command.format).toBe("json");
    }
  });

  it("parses --key value (space-separated)", () => {
    const result = parseArgs(argv("apply", "--pgdatabase", "crossengin_dev"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.flags.get("pgdatabase")).toBe("crossengin_dev");
    }
  });

  it("treats a bare --flag as boolean true", () => {
    const result = parseArgs(argv("apply", "--dry-run"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.flags.get("dry-run")).toBe(true);
    }
  });

  it("rejects an unknown --format", () => {
    const result = parseArgs(argv("validate", "x.json", "--format=xml"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("unknown output format");
    }
  });

  it("threads multiple positionals", () => {
    const result = parseArgs(argv("diff", "a.json", "b.json"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.positional).toEqual(["a.json", "b.json"]);
    }
  });

  it("treats --flag followed by another --flag as boolean", () => {
    const result = parseArgs(argv("patch", "a.json", "b.json", "--force", "--format=json"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.flags.get("force")).toBe(true);
      expect(result.command.flags.get("format")).toBe("json");
    }
  });
});

describe("getStringFlag", () => {
  it("returns the value when set as a string", () => {
    const parsed = parseArgs(argv("apply", "--pgdatabase=foo"));
    if (!parsed.ok) throw new Error("expected ok");
    expect(getStringFlag(parsed.command, "pgdatabase")).toBe("foo");
  });

  it("returns null when set as a boolean", () => {
    const parsed = parseArgs(argv("apply", "--dry-run"));
    if (!parsed.ok) throw new Error("expected ok");
    expect(getStringFlag(parsed.command, "dry-run")).toBeNull();
  });

  it("returns null when not set", () => {
    const parsed = parseArgs(argv("apply"));
    if (!parsed.ok) throw new Error("expected ok");
    expect(getStringFlag(parsed.command, "missing")).toBeNull();
  });
});

describe("getBooleanFlag", () => {
  it("returns true for bare flags", () => {
    const parsed = parseArgs(argv("apply", "--dry-run"));
    if (!parsed.ok) throw new Error("expected ok");
    expect(getBooleanFlag(parsed.command, "dry-run")).toBe(true);
  });

  it("returns true for --flag=true", () => {
    const parsed = parseArgs(argv("apply", "--dry-run=true"));
    if (!parsed.ok) throw new Error("expected ok");
    expect(getBooleanFlag(parsed.command, "dry-run")).toBe(true);
  });

  it("returns false when not set", () => {
    const parsed = parseArgs(argv("apply"));
    if (!parsed.ok) throw new Error("expected ok");
    expect(getBooleanFlag(parsed.command, "dry-run")).toBe(false);
  });
});

describe("helpText", () => {
  it("includes the list of subcommands", () => {
    const text = helpText();
    expect(text).toContain("init");
    expect(text).toContain("validate");
    expect(text).toContain("diff");
    expect(text).toContain("apply");
    expect(text).toContain("chat");
  });
});
