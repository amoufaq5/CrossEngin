import { execFileSync } from "node:child_process";

/**
 * No tracked file carries a secret-shaped value, or says why it does.
 *
 * A real API key and a database password reached `deploy/.env.example` on another branch, and nothing
 * in the repository could have refused them: the CI workflow and the pre-commit hook run the workspace
 * rules and the suite, and none of those reads a file for what it *contains* as opposed to what it
 * *declares*. This rule is that reader, and it runs in both places for free, because the hook and the
 * CI step that gate a commit are both `pnpm --filter @crossengin/testing test`.
 *
 * What it prevents is the **next** commit. A credential already in history stays recoverable from
 * every clone until it is rotated, and rotating it is the remedy; rewriting history is a separate
 * decision and this rule makes neither.
 *
 * **Tracked means the index, path and content both.** A file staged for the first time is in scope
 * at pre-commit — `git add -f deploy/.env` is refused like any other — and what is read is the staged
 * blob, not the working copy, because the blob is what the commit publishes. A file nobody has staged
 * is deliberately out of scope: it is not about to be published, and `.gitignore` already excludes
 * `.env`.
 *
 * Two families of finding. A **pattern** is a value whose own shape says it is a credential, wherever
 * it appears. An **assignment** is a secret-named variable given a literal value in a file whose job
 * is to hold such values — an env file, where the only safe values are empty, an interpolation, or a
 * placeholder carrying `SECRET_PLACEHOLDER_PREFIX`; and a YAML file, where the only safe value is an
 * interpolation. The prefix is read from `@crossengin/crypto`'s source **as text**, not imported, for
 * `pg-column-coverage.ts`' reason: this package imports no workspace package, so the rule stays green
 * or red with no build in between — and the same prefix is what `refuseWeakSecret` refuses at boot,
 * so the scanner and the binary cannot disagree about what a placeholder is.
 *
 * No finding carries a value, and nothing here prints one: a finding is a path, a line, a kind and a
 * length, because a scanner that echoes the secret into a CI log publishes it a second time.
 */

export const SECRET_PATTERN_KINDS = [
  "anthropic_api_key",
  "openai_api_key",
  "aws_access_key_id",
  "pem_private_key",
  "slack_token",
  "github_token",
  "stripe_live_key",
] as const;
export type SecretPatternKind = (typeof SECRET_PATTERN_KINDS)[number];

export const SECRET_ASSIGNMENT_KINDS = ["secret_env_assignment", "secret_yaml_literal"] as const;
export type SecretAssignmentKind = (typeof SECRET_ASSIGNMENT_KINDS)[number];

export type SecretFindingKind = SecretPatternKind | SecretAssignmentKind;

/**
 * One pattern per kind, total over the enum. Lengths are the provider's real token lengths with
 * margin, so an identifier that merely begins `sk-` is not a key; `requires` is a second test on the
 * match for the one kind whose prefix is common in prose (`sk-` begins kebab-case names), since a
 * generated key is mixed-case with digits and a name is not.
 */
export const SECRET_PATTERNS: Readonly<
  Record<SecretPatternKind, { readonly pattern: RegExp; readonly requires?: RegExp[] }>
> = {
  anthropic_api_key: { pattern: /sk-ant-[A-Za-z0-9_-]{32,}/g },
  openai_api_key: {
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
    requires: [/[0-9]/, /[A-Z]/, /[a-z]/],
  },
  aws_access_key_id: { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // The header alone is code — three files name it, to recognise a PEM or to build a fixture at run time — so a finding needs a
  // body behind it, across a real newline or the `\n` escape a key takes inside a string.
  pem_private_key: {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\\n|\s)*[A-Za-z0-9+/=]{64,}/g,
  },
  slack_token: { pattern: /\bxox[abposr]-[0-9]+-[0-9A-Za-z-]{10,}/g },
  github_token: { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g },
  stripe_live_key: { pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g },
};

/** A variable name that holds a credential. `_ID`/`_SID`/`_URL` name an identifier or an endpoint. */
const SECRET_NAME = /SECRET|PASSWORD|PASSWD|TOKEN|PEPPER|PRIVATE|CREDENTIAL|KEY/;
const NOT_SECRET_SUFFIX = /(?:_ID|_SID|_URL)$/;
const SECRET_NAME_TOKENS: ReadonlySet<string> = new Set([
  "SECRET", "SECRETS", "PASSWORD", "PASSWD", "PWD", "TOKEN", "TOKENS", "PEPPER", "PRIVATE",
  "CREDENTIAL", "CREDENTIALS", "KEY", "APIKEY",
]);

/**
 * An upper-case env name is matched on substring, since `DBPASSWORD` is a plausible spelling. A name
 * carrying a lower-case letter (`db_password`, a YAML `apiKey`) is matched on whole tokens instead,
 * because a lockfile's `keyv:` or a `monkey_count` is not a credential and a substring would say so.
 */
export function isSecretName(name: string): boolean {
  if (name === name.toUpperCase()) return SECRET_NAME.test(name) && !NOT_SECRET_SUFFIX.test(name);
  const tokens = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase().split(/[_-]+/);
  if (NOT_SECRET_SUFFIX.test(`_${tokens[tokens.length - 1] ?? ""}`)) return false;
  return tokens.some((t) => SECRET_NAME_TOKENS.has(t));
}

/**
 * `.env`, `.env.example`, `.env.local`, `.env-prod`, `.envrc`, `staging.env`, `prod.env.bak` — any
 * basename in which `.env` (or `.envrc`) ends the name or is followed by `.`, `-` or `_`. `env.ts`
 * and `credential-auth-env.ts` are not env files.
 */
export function isEnvFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return /\.env(?:rc)?(?:$|[.\-_])/.test(base);
}

/**
 * A value that names where the secret comes from rather than being one: a single `${NAME}` whose
 * default, if it declares one, is itself acceptable — `${X:-}` passes and `${X:-<literal>}` does not,
 * since compose substitutes that literal whenever the variable is unset — or a GitHub Actions
 * `${{ … }}` expression. A `?` form carries an error message, which is never substituted.
 */
function isReference(value: string, accepts: (v: string) => boolean): boolean {
  if (/^\$\{\{[^}]*\}\}$/.test(value)) return true;
  const m = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::?([-=?+])(.*))?\}$/.exec(value);
  if (m === null) return false;
  if (m[1] === undefined || m[1] === "?") return true;
  const fallback = m[2] ?? "";
  return fallback === "" || accepts(fallback);
}

export function isYamlFile(path: string): boolean {
  return /\.ya?ml$/.test(path);
}

export interface TrackedFile {
  readonly path: string;
  readonly text: string;
}

export interface SecretFinding {
  readonly path: string;
  readonly line: number;
  readonly kind: SecretFindingKind;
  /** The variable an assignment finding is about; `null` for a pattern finding. */
  readonly variable: string | null;
  /** How long the value is — enough to tell a key from a stub, and nothing a reader could use. */
  readonly length: number;
}

/**
 * A placeholder an env file may carry that does not use `SECRET_PLACEHOLDER_PREFIX`, matched on the
 * **exact** value, so replacing it with a real one is a finding rather than a pass.
 */
export interface DeclaredPlaceholder {
  readonly path: string;
  readonly variable: string;
  readonly value: string;
  readonly reason: string;
}

export const DECLARED_PLACEHOLDERS: readonly DeclaredPlaceholder[] = [
  {
    path: "deploy/.env.example",
    variable: "POSTGRES_PASSWORD",
    value: "change-me-to-a-long-random-string",
    reason:
      "Postgres reads this variable directly and `refuseWeakSecret` never sees it, so it has no reason " +
      "to carry the prefix the binary refuses on; the file's own comment tells an operator to replace it " +
      "with `openssl rand -hex 24`. The exact value is what is declared, so a real password here is a finding.",
  },
];

/**
 * A tracked file allowed to carry `count` matches of one pattern, with why they are not secrets.
 * `count` is exact, so a real key added beside a declared fake is still a finding.
 */
export interface SecretExemption {
  readonly path: string;
  readonly kind: SecretPatternKind;
  readonly count: number;
  readonly reason: string;
}

export const SECRET_SCAN_EXEMPTIONS: readonly SecretExemption[] = [
  {
    path: "packages/notification-providers/src/email-ses.test.ts",
    kind: "aws_access_key_id",
    count: 1,
    reason:
      "AWS's own published example credential pair — the access key id ends `EXAMPLE` and the secret ends " +
      "`EXAMPLEKEY` — used so the SigV4 signer is exercised with the values AWS documents, which no AWS " +
      "account can hold.",
  },
];

/** Reads `SECRET_PLACEHOLDER_PREFIX` out of the crypto package's source; throws rather than guessing. */
export function readSecretPlaceholderPrefix(cryptoSource: string): string {
  const m = /export const SECRET_PLACEHOLDER_PREFIX = "([^"]+)";/.exec(cryptoSource);
  if (m?.[1] === undefined) {
    throw new Error(
      "SECRET_PLACEHOLDER_PREFIX is no longer declared as a string literal in packages/crypto/src/key-derivation.ts; " +
        "the secret scanner cannot tell a placeholder from a value without it",
    );
  }
  return m[1];
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

export interface SecretScanOptions {
  readonly placeholderPrefix: string;
  readonly placeholders?: readonly DeclaredPlaceholder[];
}

export interface SecretScan {
  readonly findings: readonly SecretFinding[];
  /** Secret-named assignments examined in env and YAML files, accepted or not — the floor's input. */
  readonly assignmentsExamined: number;
  /** Of those, how many carried a non-empty value the rule accepted as a placeholder or reference. */
  readonly placeholdersAccepted: number;
  /** Declared placeholders that were matched; the rest are overtaken. */
  readonly placeholdersMatched: readonly DeclaredPlaceholder[];
}

export function scanForSecretValues(
  files: readonly TrackedFile[],
  options: SecretScanOptions,
): SecretScan {
  const placeholders = options.placeholders ?? DECLARED_PLACEHOLDERS;
  const findings: SecretFinding[] = [];
  const matched = new Set<DeclaredPlaceholder>();
  let assignmentsExamined = 0;
  let placeholdersAccepted = 0;

  for (const file of files) {
    for (const kind of SECRET_PATTERN_KINDS) {
      const { pattern, requires } = SECRET_PATTERNS[kind];
      for (const m of file.text.matchAll(pattern)) {
        if (requires !== undefined && !requires.every((r) => r.test(m[0]))) continue;
        findings.push({
          path: file.path,
          line: lineOf(file.text, m.index ?? 0),
          kind,
          variable: null,
          length: m[0].length,
        });
      }
    }

    const env = isEnvFile(file.path);
    const yaml = isYamlFile(file.path);
    if (!env && !yaml) continue;

    const lines = file.text.split("\n");
    lines.forEach((text, i) => {
      // Commented-out lines count in an env file: a value is published whether or not it is live.
      const a = env
        ? /^\s*#*\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(text)
        : (/^\s*-?\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(text) ??
          /^\s*-\s*([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(text));
      if (a === null) return;
      const variable = a[1] ?? "";
      if (!isSecretName(variable)) return;
      assignmentsExamined += 1;
      // `#` begins a comment only after whitespace, which is how compose's env-file parser reads it.
      const value = unquote((a[2] ?? "").replace(/\s+#.*$/, ""));
      if (value === "") return;
      const isPrefixed = (v: string): boolean => env && v.startsWith(options.placeholderPrefix);
      const accepts = (v: string): boolean => isPrefixed(v) || isReference(v, accepts);
      if (accepts(value)) {
        placeholdersAccepted += 1;
        return;
      }
      const declared = placeholders.find(
        (p) => p.path === file.path && p.variable === variable && p.value === value,
      );
      if (env && declared !== undefined) {
        matched.add(declared);
        placeholdersAccepted += 1;
        return;
      }
      findings.push({
        path: file.path,
        line: i + 1,
        kind: env ? "secret_env_assignment" : "secret_yaml_literal",
        variable,
        length: value.length,
      });
    });
  }

  return {
    findings,
    assignmentsExamined,
    placeholdersAccepted,
    placeholdersMatched: placeholders.filter((p) => matched.has(p)),
  };
}

export const SECRET_VIOLATION_KINDS = [
  "secret_value",
  "exemption_count_changed",
  "exemption_overtaken",
  "placeholder_overtaken",
] as const;
export type SecretViolationKind = (typeof SECRET_VIOLATION_KINDS)[number];

export interface SecretViolation {
  readonly kind: SecretViolationKind;
  readonly path: string;
  readonly detail: string;
}

/**
 * Compares the scan against the declarations in both directions. A finding no exemption covers is a
 * secret; an exemption whose file no longer carries its matches, or carries a different number, is
 * stale — and stale in the dangerous direction too, since a declaration nobody needs is a hole
 * waiting for a real key in that file.
 */
export function auditSecretValues(
  scan: SecretScan,
  exemptions: readonly SecretExemption[] = SECRET_SCAN_EXEMPTIONS,
  placeholders: readonly DeclaredPlaceholder[] = DECLARED_PLACEHOLDERS,
): readonly SecretViolation[] {
  const violations: SecretViolation[] = [];
  const counts = new Map<string, number>();
  const keyOf = (path: string, kind: string): string => `${path}\u0000${kind}`;
  for (const f of scan.findings) counts.set(keyOf(f.path, f.kind), (counts.get(keyOf(f.path, f.kind)) ?? 0) + 1);

  const declared = new Map(exemptions.map((e) => [keyOf(e.path, e.kind), e]));
  for (const f of scan.findings) {
    if (declared.has(keyOf(f.path, f.kind))) continue;
    violations.push({
      kind: "secret_value",
      path: f.path,
      detail:
        `${f.path}:${f.line} carries a ${f.kind}` +
        (f.variable === null ? "" : ` (${f.variable})`) +
        ` of length ${f.length}. Remove it and rotate the credential: once committed it is published. ` +
        `If it is a deliberate fake, declare it in SECRET_SCAN_EXEMPTIONS with its reason`,
    });
  }

  for (const e of exemptions) {
    const found = counts.get(keyOf(e.path, e.kind)) ?? 0;
    if (found === 0) {
      violations.push({
        kind: "exemption_overtaken",
        path: e.path,
        detail: `${e.path} is declared to carry ${e.count} ${e.kind} and carries none; remove the exemption`,
      });
    } else if (found !== e.count) {
      violations.push({
        kind: "exemption_count_changed",
        path: e.path,
        detail:
          `${e.path} is declared to carry ${e.count} ${e.kind} and carries ${found}; ` +
          `a new match beside a declared fake is not covered by its declaration`,
      });
    }
  }

  const matched = new Set(scan.placeholdersMatched);
  for (const p of placeholders) {
    if (matched.has(p)) continue;
    violations.push({
      kind: "placeholder_overtaken",
      path: p.path,
      detail:
        `${p.path} no longer assigns ${p.variable} its declared placeholder; ` +
        `if the placeholder changed, update DECLARED_PLACEHOLDERS, and if a real value replaced it, rotate it`,
    });
  }
  return violations;
}

export function formatSecretViolations(violations: readonly SecretViolation[]): string {
  return violations.map((v) => `[${v.kind}] ${v.detail}`).join("\n");
}

export interface TrackedTextFiles {
  readonly files: readonly TrackedFile[];
  /** Index entries holding a NUL byte, which no pattern reads — named, so they are not dropped silently. */
  readonly binary: readonly string[];
}

/** One index entry, from `git ls-files --stage`: `<mode> <object> <stage>\t<path>`. */
export interface IndexEntry {
  readonly mode: string;
  readonly object: string;
  readonly stage: string;
  readonly path: string;
}

export function parseIndexListing(listing: string): readonly IndexEntry[] {
  const byPath = new Map<string, IndexEntry>();
  // A conflicted path is listed once per stage; one is read, preferring the merged stage, then ours.
  const rank = (stage: string): number => ["0", "2", "3", "1"].indexOf(stage);
  for (const record of listing.split("\0")) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t(.+)$/s.exec(record);
    if (m === null) continue;
    const entry: IndexEntry = { mode: m[1] ?? "", object: m[2] ?? "", stage: m[3] ?? "", path: m[4] ?? "" };
    // A gitlink names a commit in another repository, not content of this one.
    if (entry.mode === "160000") continue;
    const held = byPath.get(entry.path);
    if (held === undefined || rank(entry.stage) < rank(held.stage)) byPath.set(entry.path, entry);
  }
  return [...byPath.values()];
}

/**
 * Splits `git cat-file --batch` output into one buffer per requested object, in request order.
 * Throws on an object git reports missing: an index entry whose content cannot be read is not clean.
 */
export function splitCatFileBatch(output: Buffer, expected: number): readonly Buffer[] {
  const blobs: Buffer[] = [];
  let at = 0;
  while (at < output.length) {
    const eol = output.indexOf(10, at);
    if (eol < 0) throw new Error("git cat-file --batch output ended inside a header");
    const header = output.subarray(at, eol).toString("utf8");
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
    if (m === null) throw new Error(`git cat-file --batch could not read an object: ${header}`);
    const size = Number(m[3]);
    blobs.push(output.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  if (blobs.length !== expected) {
    throw new Error(`git cat-file --batch answered ${blobs.length} objects for ${expected} requested`);
  }
  return blobs;
}

/**
 * Every path the index holds, with the content **the index** holds — which is what a commit will
 * publish. Reading the working tree instead would pass a key that was staged and then deleted from
 * the file without re-staging, which is exactly an accident's shape. The other workspace rules read
 * the working tree (the hook says so); this one does not need to, because a blob costs one batched
 * `git cat-file` and not a temporary worktree. Throws when git cannot answer.
 */
export function readTrackedTextFiles(repoRoot: string): TrackedTextFiles {
  const run = (args: string[], input?: string): Buffer =>
    execFileSync("git", args, { cwd: repoRoot, maxBuffer: 512 * 1024 * 1024, input });
  const entries = parseIndexListing(run(["ls-files", "-z", "--stage"]).toString("utf8"));
  const blobs = splitCatFileBatch(
    run(["cat-file", "--batch"], entries.map((e) => `${e.object}\n`).join("")),
    entries.length,
  );
  const files: TrackedFile[] = [];
  const binary: string[] = [];
  entries.forEach((entry, i) => {
    const bytes = blobs[i] ?? Buffer.alloc(0);
    if (bytes.includes(0)) {
      binary.push(entry.path);
      return;
    }
    files.push({ path: entry.path, text: bytes.toString("utf8") });
  });
  return { files, binary };
}
