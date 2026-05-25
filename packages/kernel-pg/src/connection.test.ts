import { describe, expect, it } from "vitest";

import { looksLikeProductionDatabase, parsePgEnvConfig } from "./connection.js";

describe("parsePgEnvConfig", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    PGHOST: "db.example.com",
    PGUSER: "postgres",
    PGDATABASE: "crossengin_dev",
  };

  it("returns a config with defaults filled in", () => {
    const cfg = parsePgEnvConfig(baseEnv);
    expect(cfg.host).toBe("db.example.com");
    expect(cfg.user).toBe("postgres");
    expect(cfg.database).toBe("crossengin_dev");
    expect(cfg.port).toBe(5432);
    expect(cfg.password).toBe("");
    expect(cfg.ssl).toBe("prefer");
    expect(cfg.applicationName).toBe("crossengin-pg");
  });

  it("threads PGPASSWORD through", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGPASSWORD: "secret" });
    expect(cfg.password).toBe("secret");
  });

  it("parses PGPORT as an integer", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGPORT: "6543" });
    expect(cfg.port).toBe(6543);
  });

  it("threads PGSSLMODE through when valid", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGSSLMODE: "require" });
    expect(cfg.ssl).toBe("require");
  });

  it("threads PGAPPNAME through", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGAPPNAME: "crossengin-ci" });
    expect(cfg.applicationName).toBe("crossengin-ci");
  });

  it("throws when PGHOST is missing", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGHOST: undefined } as NodeJS.ProcessEnv)).toThrow(
      /PGHOST/,
    );
  });

  it("throws when PGUSER is missing", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGUSER: undefined } as NodeJS.ProcessEnv)).toThrow(
      /PGUSER/,
    );
  });

  it("throws when PGDATABASE is missing", () => {
    expect(() =>
      parsePgEnvConfig({ ...baseEnv, PGDATABASE: undefined } as NodeJS.ProcessEnv),
    ).toThrow(/PGDATABASE/);
  });

  it("throws when PGPORT is not a valid TCP port", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGPORT: "abc" })).toThrow(/PGPORT/);
    expect(() => parsePgEnvConfig({ ...baseEnv, PGPORT: "0" })).toThrow(/PGPORT/);
    expect(() => parsePgEnvConfig({ ...baseEnv, PGPORT: "70000" })).toThrow(/PGPORT/);
  });

  it("throws when PGSSLMODE is not recognized", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGSSLMODE: "bogus" })).toThrow(/PGSSLMODE/);
  });
});

describe("looksLikeProductionDatabase", () => {
  it("flags names containing prod", () => {
    expect(looksLikeProductionDatabase("crossengin_prod")).toBe(true);
    expect(looksLikeProductionDatabase("PROD-cluster")).toBe(true);
  });

  it("flags names containing production", () => {
    expect(looksLikeProductionDatabase("production-db")).toBe(true);
  });

  it("flags names ending _live", () => {
    expect(looksLikeProductionDatabase("crossengin_live")).toBe(true);
  });

  it("flags the bare name live", () => {
    expect(looksLikeProductionDatabase("live")).toBe(true);
  });

  it("does not flag dev/test/staging names", () => {
    expect(looksLikeProductionDatabase("crossengin_dev")).toBe(false);
    expect(looksLikeProductionDatabase("staging_db")).toBe(false);
    expect(looksLikeProductionDatabase("test")).toBe(false);
  });
});
