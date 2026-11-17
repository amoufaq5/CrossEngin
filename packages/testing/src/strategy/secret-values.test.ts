import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  auditSecretValues,
  DECLARED_PLACEHOLDERS,
  formatSecretViolations,
  isEnvFile,
  isSecretName,
  parseIndexListing,
  readSecretPlaceholderPrefix,
  readTrackedTextFiles,
  scanForSecretValues,
  SECRET_PATTERN_KINDS,
  SECRET_SCAN_EXEMPTIONS,
  SECRET_VIOLATION_KINDS,
  splitCatFileBatch,
  type SecretPatternKind,
  type TrackedFile,
} from "./secret-values.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PREFIX = readSecretPlaceholderPrefix(
  readFileSync(join(REPO_ROOT, "packages/crypto/src/key-derivation.ts"), "utf8"),
);

/**
 * Mixed case with digits, built at run time. Every key-shaped value in this file is assembled from
 * fragments so the file itself never holds one — which the real-workspace scan below would otherwise
 * report, and which would be the wrong thing to declare an exemption for.
 */
function body(n: number): string {
  return "Ab3Xy7Qz9".repeat(Math.ceil(n / 9)).slice(0, n);
}

const SAMPLES: Readonly<Record<SecretPatternKind, string>> = {
  anthropic_api_key: ["sk", "ant", "api03", body(93)].join("-"),
  openai_api_key: ["sk", "proj", body(64)].join("-"),
  aws_access_key_id: "AK" + "IA" + "QWERTYUIOPASDFGH",
  pem_private_key: "-----BEGIN " + "PRIVATE KEY-----\\n" + "MIIE" + "vQIBADANBgkq".repeat(8),
  slack_token: "xo" + "xb-" + "123456789012-" + body(24),
  github_token: "gh" + "p_" + body(36),
  stripe_live_key: "sk" + "_live_" + body(24),
};

/** One near miss per kind: the prefix without a real length, or a name rather than a key. */
const NEAR_MISSES: Readonly<Record<SecretPatternKind, string>> = {
  anthropic_api_key: ["sk", "ant", "short"].join("-"),
  openai_api_key: ["sk", "a-long-kebab-case-identifier-without-any-digits-at-all"].join("-"),
  aws_access_key_id: "AK" + "IA" + "SHORT",
  pem_private_key: "-----BEGIN " + "PRIVATE KEY-----\\nAAAAAAAA\\n-----END PRIVATE KEY-----",
  slack_token: "xo" + "xb-placeholder",
  github_token: "gh" + "p_" + "short",
  stripe_live_key: "sk" + "_test_" + body(24),
};

function scanText(path: string, text: string): ReturnType<typeof scanForSecretValues> {
  return scanForSecretValues([{ path, text }], { placeholderPrefix: PREFIX, placeholders: [] });
}

describe("the patterns", () => {
  it.each(SECRET_PATTERN_KINDS)("finds a synthetic %s — the positive control", (kind) => {
    const scan = scanText("src/a.ts", `const x = "${SAMPLES[kind]}";\n`);
    expect(scan.findings.map((f) => f.kind)).toContain(kind);
    expect(scan.findings.every((f) => f.line === 1)).toBe(true);
  });

  it.each(SECRET_PATTERN_KINDS)("does not report the near miss for %s", (kind) => {
    const scan = scanText("src/a.ts", `const x = "${NEAR_MISSES[kind]}";\n`);
    expect(scan.findings).toEqual([]);
  });

  it("reports an Anthropic key as one finding and not also as an OpenAI one", () => {
    const scan = scanText("src/a.ts", SAMPLES.anthropic_api_key);
    expect(scan.findings.map((f) => f.kind)).toEqual(["anthropic_api_key"]);
  });

  it("reads a PEM body across a real newline as well as across the escape", () => {
    const pem = SAMPLES.pem_private_key.replace("\\n", "\n");
    expect(scanText("k.pem", pem).findings.map((f) => f.kind)).toEqual(["pem_private_key"]);
  });

  it("never carries the value into a finding or its message", () => {
    // A scanner that echoes the key into a CI log publishes it a second time.
    const key = SAMPLES.anthropic_api_key;
    const scan = scanText("src/a.ts", `\n\nconst k = "${key}";\n`);
    expect(scan.findings).toEqual([
      { path: "src/a.ts", line: 3, kind: "anthropic_api_key", variable: null, length: key.length },
    ]);
    const message = formatSecretViolations(auditSecretValues(scan, [], []));
    expect(message).toContain("src/a.ts:3");
    expect(message).not.toContain(key);
    expect(message).not.toContain(key.slice(10, 30));
  });
});

describe("assignments in env and YAML files", () => {
  it("classifies the files that hold values", () => {
    for (const p of ["deploy/.env.example", ".env", "a/.env.local", "staging.env"]) {
      expect(isEnvFile(p), p).toBe(true);
    }
    for (const p of ["src/env.ts", "deploy/README.md", "environment.json"]) {
      expect(isEnvFile(p), p).toBe(false);
    }
  });

  it("treats a credential variable as secret-named and an identifier or endpoint as not", () => {
    for (const n of ["POSTGRES_PASSWORD", "CREDENTIAL_PEPPER", "OPERATE_API_KEY_SPECS", "TWILIO_AUTH_TOKEN"]) {
      expect(isSecretName(n), n).toBe(true);
    }
    for (const n of ["POSTGRES_USER", "TWILIO_API_KEY_SID", "AWS_ACCESS_KEY_ID", "SES_ENDPOINT_URL"]) {
      expect(isSecretName(n), n).toBe(false);
    }
  });

  it("accepts empty, interpolated and prefixed values and refuses a literal", () => {
    const hex = randomBytes(24).toString("hex");
    const text = [
      "API_TOKEN=",
      "ROUTE_SECRET=${OTHER}",
      `SIGNING_KEY=${PREFIX}32_RANDOM`,
      `#BOUNCE_SECRET=${PREFIX}LATER`,
      `DB_PASSWORD=${hex}`,
      `#OLD_PASSWORD="${hex}"   # a commented value is still published`,
    ].join("\n");
    const scan = scanText("x/.env", text);
    expect(scan.findings.map((f) => [f.line, f.kind, f.variable, f.length])).toEqual([
      [5, "secret_env_assignment", "DB_PASSWORD", 48],
      [6, "secret_env_assignment", "OLD_PASSWORD", 48],
    ]);
    expect(scan.assignmentsExamined).toBe(6);
    expect(scan.placeholdersAccepted).toBe(3);
  });

  it("accepts a placeholder prefix only in an env file and an interpolation in YAML", () => {
    const yaml = [
      "services:",
      "  api:",
      "    environment:",
      "      CREDENTIAL_PEPPER: ${CREDENTIAL_PEPPER}",
      `      OPERATE_TOKEN_SIGNING_KEY: ${PREFIX}X`,
      "      - DB_PASSWORD=hunter2hunter2",
    ].join("\n");
    const scan = scanText("deploy/docker-compose.yml", yaml);
    expect(scan.findings.map((f) => [f.line, f.kind, f.variable])).toEqual([
      [5, "secret_yaml_literal", "OPERATE_TOKEN_SIGNING_KEY"],
      [6, "secret_yaml_literal", "DB_PASSWORD"],
    ]);
  });

  it("accepts an interpolation only when it substitutes nothing literal", () => {
    // A compose default is substituted whenever the variable is unset, so a literal there is published
    // exactly as a literal value is; so is anything trailing the closing brace.
    const hex = randomBytes(16).toString("hex");
    const accepted = [
      "KEY_A: ${KEY_A}",
      "KEY_B: ${KEY_B:-}",
      "KEY_C: ${KEY_C:?set KEY_C first}",
      "KEY_D: ${KEY_D:-${KEY_E}}",
      "token: ${{ secrets.DEPLOY_TOKEN }}",
    ];
    const refused = [
      `KEY_F: \${KEY_F:-${hex}}`,
      `KEY_G: \${KEY_G-${hex}}`,
      `KEY_H: \${KEY_H:+${hex}}`,
      `KEY_I: \${KEY_I}${hex}`,
      `KEY_J: \${KEY_J:-\${KEY_K:-${hex}}}`,
    ];
    const scan = scanText("deploy/docker-compose.yml", [...accepted, ...refused].join("\n"));
    expect(scan.findings.map((f) => f.variable)).toEqual(["KEY_F", "KEY_G", "KEY_H", "KEY_I", "KEY_J"]);
    expect(scan.placeholdersAccepted).toBe(accepted.length);
    const env = scanText("x/.env", [`DB_PASSWORD=\${X:-${PREFIX}LATER}`, `API_TOKEN=\${X:-${hex}}`].join("\n"));
    expect(env.findings.map((f) => f.variable)).toEqual(["API_TOKEN"]);
  });

  it("reads every env-file spelling and every commented or lower-case spelling of a name", () => {
    const hex = randomBytes(16).toString("hex");
    for (const p of [".envrc", "deploy/.env-prod", "deploy/prod.env.bak", ".env_staging"]) {
      expect(isEnvFile(p), p).toBe(true);
      expect(scanText(p, `export DB_PASSWORD=${hex}`).findings, p).toHaveLength(1);
    }
    expect(scanText("x/.env", `## DB_PASSWORD=${hex}`).findings).toHaveLength(1);
    expect(scanText("x/.env", `db_password=${hex}`).findings).toHaveLength(1);
    const yaml = scanText("deploy/values.yaml", [`  password: ${hex}`, `  apiKey: ${hex}`].join("\n"));
    expect(yaml.findings.map((f) => f.variable)).toEqual(["password", "apiKey"]);
  });

  it("matches a lower-case name on whole tokens, so a lockfile's package names are not credentials", () => {
    for (const n of ["password", "apiKey", "db_password", "privateKey", "client-secret"]) {
      expect(isSecretName(n), n).toBe(true);
    }
    for (const n of ["keyv", "monkey_count", "apiKeyId", "tokenUrl", "js_tokenizer"]) {
      expect(isSecretName(n), n).toBe(false);
    }
  });

  it("matches a declared placeholder on its exact value only", () => {
    const declared = {
      path: "x/.env.example",
      variable: "DB_PASSWORD",
      value: "change-me",
      reason: "r",
    };
    const ok = scanForSecretValues([{ path: declared.path, text: "DB_PASSWORD=change-me" }], {
      placeholderPrefix: PREFIX,
      placeholders: [declared],
    });
    expect(ok.findings).toEqual([]);
    expect(auditSecretValues(ok, [], [declared])).toEqual([]);

    const real = scanForSecretValues(
      [{ path: declared.path, text: `DB_PASSWORD=${randomBytes(16).toString("hex")}` }],
      { placeholderPrefix: PREFIX, placeholders: [declared] },
    );
    expect(auditSecretValues(real, [], [declared]).map((v) => v.kind).sort()).toEqual([
      "placeholder_overtaken",
      "secret_value",
    ]);
  });
});

describe("the audit", () => {
  const fake = SAMPLES.aws_access_key_id;
  const exemption = { path: "src/fake.test.ts", kind: "aws_access_key_id" as const, count: 1, reason: "r" };

  it("gives every violation kind a producer", () => {
    // A kind no input can reach reads as a judgement the rule makes and does not (ADR-0375).
    const reached = new Set<string>();
    const add = (files: readonly TrackedFile[], ex = [exemption]): void => {
      const scan = scanForSecretValues(files, {
        placeholderPrefix: PREFIX,
        placeholders: DECLARED_PLACEHOLDERS,
      });
      for (const v of auditSecretValues(scan, ex, DECLARED_PLACEHOLDERS)) reached.add(v.kind);
    };
    add([{ path: "src/real.ts", text: fake }]);
    add([{ path: "src/fake.test.ts", text: `${fake}\n${fake}` }]);
    expect([...reached].sort()).toEqual([...SECRET_VIOLATION_KINDS].sort());
  });

  it("covers a declared fake and nothing beside it", () => {
    const one = scanText("src/fake.test.ts", fake);
    expect(auditSecretValues(one, [exemption], [])).toEqual([]);
    // A second match in the same file is not covered by a declaration counted at one.
    const two = scanText("src/fake.test.ts", `${fake}\n${SAMPLES.aws_access_key_id.replace("Q", "Z")}`);
    expect(auditSecretValues(two, [exemption], []).map((v) => v.kind)).toEqual(["exemption_count_changed"]);
    // The same value in another file is a finding: an exemption is per file.
    const other = scanText("src/other.ts", fake);
    expect(auditSecretValues(other, [exemption], []).map((v) => v.kind).sort()).toEqual([
      "exemption_overtaken",
      "secret_value",
    ]);
  });

  it("refuses to run without the placeholder prefix rather than guessing one", () => {
    expect(() => readSecretPlaceholderPrefix("export const OTHER = 1;")).toThrow(
      /SECRET_PLACEHOLDER_PREFIX/,
    );
    expect(PREFIX).toBe("REPLACE_WITH_");
  });
});

describe("reading the index", () => {
  it("reads the staged blob, so a key staged and then removed from the working copy is still found", () => {
    // The accident's shape: `git add` with the key, edit it out, commit without re-staging.
    const dir = mkdtempSync(join(tmpdir(), "secret-index-"));
    // Run inside a pre-commit hook, git exports GIT_INDEX_FILE (and, under `commit -a`, points it at
    // a temporary index of the *outer* repository). Inherited, it makes this scratch repository read
    // the outer index and fail on objects it does not hold — so the hook's variables are withheld
    // here, and only here: the real-tree scan below is right to read the index being committed.
    const hookEnv = Object.keys(process.env).filter((k) => k.startsWith("GIT_"));
    const saved = new Map(hookEnv.map((k) => [k, process.env[k]]));
    for (const k of hookEnv) delete process.env[k];
    try {
      const git = (...args: string[]): void => {
        execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });
      };
      git("init", "-q");
      writeFileSync(join(dir, ".env.example"), `DB_PASSWORD=${randomBytes(16).toString("hex")}\n`);
      git("add", ".env.example");
      writeFileSync(join(dir, ".env.example"), "DB_PASSWORD=\n");
      const tracked = readTrackedTextFiles(dir);
      const scan = scanForSecretValues(tracked.files, { placeholderPrefix: PREFIX, placeholders: [] });
      expect(scan.findings.map((f) => f.variable)).toEqual(["DB_PASSWORD"]);
      // And the converse: an unstaged edit is not what the commit publishes.
      git("add", ".env.example");
      writeFileSync(join(dir, ".env.example"), `DB_PASSWORD=${randomBytes(16).toString("hex")}\n`);
      const clean = scanForSecretValues(readTrackedTextFiles(dir).files, {
        placeholderPrefix: PREFIX,
        placeholders: [],
      });
      expect(clean.findings).toEqual([]);
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists a conflicted path once and skips a gitlink", () => {
    const sha = "a".repeat(40);
    const listing = [
      `100644 ${sha} 1\tf.env`,
      `100644 ${sha} 2\tf.env`,
      `100644 ${sha} 3\tf.env`,
      `160000 ${sha} 0\tvendor/sub`,
      `100644 ${sha} 0\tb.txt`,
      "",
    ].join("\0");
    expect(parseIndexListing(listing).map((e) => [e.path, e.stage])).toEqual([
      ["f.env", "2"],
      ["b.txt", "0"],
    ]);
  });

  it("refuses an object git reports missing rather than reading it as empty", () => {
    const sha = "b".repeat(40);
    expect(() => splitCatFileBatch(Buffer.from(`${sha} missing\n`), 1)).toThrow(/could not read/);
    expect(splitCatFileBatch(Buffer.from(`${sha} blob 2\nhi\n${sha} blob 0\n\n`), 2).map(String)).toEqual([
      "hi",
      "",
    ]);
    expect(() => splitCatFileBatch(Buffer.from(`${sha} blob 2\nhi\n`), 2)).toThrow(/answered 1/);
  });
});

describe("the real tracked tree", () => {
  const tracked = readTrackedTextFiles(REPO_ROOT);
  const scan = scanForSecretValues(tracked.files, { placeholderPrefix: PREFIX });

  it("was read, not silently missed", () => {
    // A failing `git ls-files` or a wrong root would make the clean answer below vacuous.
    expect(tracked.files.length).toBeGreaterThan(2000);
    const paths = new Set(tracked.files.map((f) => f.path));
    expect(paths.has("deploy/.env.example")).toBe(true);
    expect(paths.has("deploy/docker-compose.yml")).toBe(true);
    expect(paths.has("packages/testing/src/strategy/ci.ts")).toBe(true);
    // deploy/.env.example's prefixed placeholders, its one declared placeholder and the compose
    // files' interpolations: if these stop being counted the assignment arm has stopped reading.
    // Floors below the measured 32 and 25, so removing one compose variable is not a red build.
    expect(scan.assignmentsExamined).toBeGreaterThanOrEqual(25);
    expect(scan.placeholdersAccepted).toBeGreaterThanOrEqual(20);
  });

  it("names every binary file it cannot read, and admits only media", () => {
    // A NUL byte means no pattern reads the file; a binary that is not an image or a font would be
    // a place a credential can sit unscanned, so it has to be a decision rather than a skip.
    const unexpected = tracked.binary.filter(
      (p) => !/\.(?:png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf)$/i.test(p),
    );
    expect(unexpected).toEqual([]);
  });

  it("carries no secret-shaped value outside a declared exemption", () => {
    const violations = auditSecretValues(scan);
    expect(violations, formatSecretViolations(violations)).toEqual([]);
  });

  it("reaches every exemption, so none excuses something already gone", () => {
    for (const e of SECRET_SCAN_EXEMPTIONS) {
      expect(e.reason.length, `${e.path} states no reason`).toBeGreaterThan(40);
      expect(scan.findings.filter((f) => f.path === e.path && f.kind === e.kind)).toHaveLength(e.count);
    }
  });

  it("would refuse a real password in the shipped env example", () => {
    // The live control: the actual file, with its one non-prefixed placeholder replaced at run time.
    const example = tracked.files.find((f) => f.path === "deploy/.env.example");
    expect(example).toBeDefined();
    const text = example?.text ?? "";
    expect(text).toMatch(/^POSTGRES_PASSWORD=change-me-to-a-long-random-string$/m);
    const swapped = text.replace(
      /^POSTGRES_PASSWORD=.*$/m,
      `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
    );
    const v = auditSecretValues(
      scanForSecretValues([{ path: "deploy/.env.example", text: swapped }], {
        placeholderPrefix: PREFIX,
      }),
      [],
    );
    expect(v.map((x) => x.kind).sort()).toEqual(["placeholder_overtaken", "secret_value"]);
    expect(formatSecretViolations(v)).toContain("POSTGRES_PASSWORD");
  });

  it("would refuse a real value in place of any prefixed placeholder", () => {
    const example = tracked.files.find((f) => f.path === "deploy/.env.example");
    const text = example?.text ?? "";
    const names = [...text.matchAll(new RegExp(`^#?([A-Z_]+)=${PREFIX}`, "gm"))].map((m) => m[1] ?? "");
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      const swapped = text.replace(
        new RegExp(`^(#?${name})=${PREFIX}.*$`, "m"),
        `$1=${randomBytes(16).toString("hex")}`,
      );
      const scan = scanForSecretValues([{ path: "deploy/.env.example", text: swapped }], {
        placeholderPrefix: PREFIX,
      });
      expect(scan.findings.map((f) => f.variable), name).toEqual([name]);
    }
  });

  it("would refuse a literal secret inlined into the compose file", () => {
    const compose = tracked.files.find((f) => f.path === "deploy/docker-compose.yml");
    const text = compose?.text ?? "";
    const reference = /\$\{CREDENTIAL_PEPPER[^}]*\}/;
    expect(text).toMatch(reference);
    const swapped = text.replace(reference, randomBytes(16).toString("hex"));
    const scan = scanForSecretValues([{ path: "deploy/docker-compose.yml", text: swapped }], {
      placeholderPrefix: PREFIX,
    });
    expect(scan.findings.map((f) => [f.kind, f.variable])).toEqual([
      ["secret_yaml_literal", "CREDENTIAL_PEPPER"],
    ]);
  });
});
