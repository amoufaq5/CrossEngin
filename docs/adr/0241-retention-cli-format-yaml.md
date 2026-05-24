# ADR-0241: Retention CLI `--format=yaml` output

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.format-yaml
- **Closes**: ADR-0231 future Q1 (`--format=yaml`)
- **Related**: ADR-0227 (CSV format), ADR-0231 (tsv/ndjson/separator),
  ADR-0224 (envelope conventions)

## Context

ADR-0231 deferred `--format=yaml` as future Q1, noting YAML is uncommon
for tabular retention data. But YAML is a useful *structured* format
(like JSON) for operators who pipe config-style output into YAML-aware
tooling (Ansible, Kubernetes manifests, GitOps workflows) or simply
prefer YAML's readability over JSON for nested structures.

This ADR adds `--format=yaml`, which emits the **same structured
envelope** that `--format=json` emits, in YAML syntax — closing
ADR-0231 Q1.

### YAML is structured, not tabular

Unlike `csv`/`tsv` (tabular, one row per record) or `ndjson` (one JSON
object per line), `yaml` mirrors `json`: it renders the full nested
envelope (filters echo + result/entries/buckets). So `--format=yaml` is
wired everywhere `--format=json` is, NOT to the tabular code paths.

## Decision

Add `yaml` to `OutputFormat` and a dependency-free YAML emitter in
`format.ts`. Wire it via a `printStructured(io, format, value)` helper
that dispatches `json` → `printJson`, `yaml` → `printYaml`.

### Minimal YAML emitter

Following the project's in-repo-helper pattern (no external dependency,
per ADR-0227's rejection of a CSV library), `format.ts` gains:

```ts
export function formatYaml(value: unknown): string;
export function printYaml(io, value): void;
export function printStructured(io, format, value): void;  // json | yaml dispatch
```

The emitter (`yamlNode`) handles the shapes retention envelopes produce:
- **Scalars** — null → `null`, bool → `true`/`false`, number → as-is,
  string → bare or double-quoted.
- **Objects** — `key: value` lines; nested objects/arrays indented 2
  spaces under `key:`.
- **Arrays** — `- item` block style; arrays of objects render `- key:
  val` with subsequent keys aligned.
- **Empty containers** — `[]` / `{}` inline.

### String quoting (conservative)

Strings are double-quoted (with `\`/`"`/`\n`/`\t` escaped) when they
could be misinterpreted as YAML:
- empty string
- leading/trailing whitespace
- starts with a YAML indicator char (`-?:,[]{}#&*!|>'"%@\``)
- contains `": "` or `" #"`
- contains newline/tab
- matches a reserved word (`true/false/null/yes/no/on/off/~`,
  case-insensitive)
- looks numeric (`^[+-]?(\d|\.\d)`)

Otherwise bare. This conservatively over-quotes (e.g., UUIDs starting
with a digit get quoted) — harmless + safe. Event kinds (`opt_out_set`)
render bare; timestamps + UUIDs render quoted.

### `printStructured` dispatch

Rather than add a yaml branch to every surface, all retention
`printJson(ctx.io, envelope)` calls were replaced with
`printStructured(ctx.io, command.format, envelope)`, and every
`command.format === "json"` condition was widened to
`command.format === "json" || command.format === "yaml"`. This is
behavior-preserving for all non-yaml formats (printStructured →
printJson when format ≠ "yaml") and adds yaml support uniformly across
all 23 envelope-emitting branches (history / summary / diff-history /
diff-timeline / diff / mutation actions / restore / prune / explain /
explain-analyze).

### Wiring scope

Because the transformation was global (`printJson(ctx.io, ...)` →
`printStructured(ctx.io, command.format, ...)`), `--format=yaml` works
on EVERY retention action that emits a JSON envelope — not just the 4
read surfaces. Mutation actions (`opt-out`, `set`, etc.), `restore`,
`prune`, `diff`, and the `--explain` / `--explain-analyze` plans all
honor `--format=yaml`.

## Rejected alternatives

1. **Use a YAML library (js-yaml)** — adds an external dependency for
   ~60 lines of emitter; ADR-0227 established the in-repo-helper pattern
   for CSV; same reasoning applies.
2. **Wire yaml only to the 4 read surfaces (like csv/tsv/ndjson)** —
   yaml is structured (like json), so it naturally applies everywhere
   json does; the `printStructured` transformation makes it uniform
   with minimal code.
3. **Emit YAML flow style (`{a: 1, b: 2}`)** — block style is more
   readable for nested structures + is the YAML idiom operators expect.
4. **Bare strings everywhere (no quoting)** — would produce invalid/
   misparsed YAML for timestamps, reserved words, etc.; conservative
   quoting is correct.
5. **Single-quote strings** — double-quote with escapes handles all
   cases (single-quote YAML can't escape control chars cleanly).
6. **`--yaml` boolean flag instead of `--format=yaml`** — inconsistent
   with the established `--format=<x>` pattern.
7. **YAML document markers (`---` / `...`)** — unnecessary for single-
   document output; operators piping to YAML tools don't need them.
8. **Comments/anchors/tags** — out of scope; the emitter targets plain
   data serialization, not full YAML 1.2.

## Future questions

1. **YAML round-trip fidelity test** — parse the emitted YAML back
   (with a parser) and assert it equals the source object. Defer — would
   add a yaml-parse dependency just for the test; the emitter is unit-
   tested against expected strings.
2. **Flow-style for compact leaf arrays** — render `kinds: [a, b]`
   inline for short scalar arrays. Defer — block style is consistent +
   readable.
3. **`--format=yaml` for chat / gateway / apply surfaces** — the
   `printStructured` helper is reusable; other CLI surfaces could adopt
   it. Defer.
4. **YAML 1.2 strict compliance** — the emitter targets the common
   shapes; full 1.2 (multi-line scalars, complex keys) is out of scope.
   Defer.
5. **Configurable indent width** — currently 2 spaces. Defer — 2 is the
   YAML convention.
6. **Anchor/alias for repeated structures** — dedup repeated objects via
   `&anchor`/`*alias`. Defer — retention envelopes rarely repeat.

## Consequences

- **Operators get YAML output** — config-style structured output for
  YAML-aware tooling (Ansible / k8s / GitOps) + readability preference.
- **`--format=yaml` works on ALL retention actions** — uniform via the
  `printStructured` transformation (not just the 4 read surfaces).
- **Test count: 9,353 → 9,371** (+18 net: 12 format-unit tests for the
  YAML emitter + printStructured dispatch, 6 CLI tests for yaml on
  history/summary/diff-history/diff-timeline/explain/explain-analyze).
- **Dependency-free emitter** — ~60 lines in `format.ts`; no js-yaml.
- **Conservative quoting** — over-quotes ambiguous strings (UUIDs,
  timestamps, reserved words) for correctness; bare for safe tokens.
- **`printStructured` helper** — reusable json/yaml dispatch; future
  surfaces can adopt it.
- **6th output format** — human / json / csv / tsv / ndjson / yaml.
- **No breaking changes** — `--format=yaml` is ADDITIVE; all existing
  formats behave identically (printStructured → printJson for non-yaml).
- **ADR-0231 future Qs now fully closed** — tsv (ADR-0231) + ndjson
  (ADR-0231) + csv-separator (ADR-0231) + yaml (this ADR).
