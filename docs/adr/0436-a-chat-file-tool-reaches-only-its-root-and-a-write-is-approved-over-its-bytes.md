# ADR-0436: A chat file tool reaches only its root, and a write is approved over the bytes it writes

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0420 (the commit scanner's seven key shapes, which the content check mirrors), ADR-0435 (the approval `details` lines this shares `tools.ts` and `chat.ts` with), ADR-0338 (refuse only if nothing correct breaks) |

## Context

The external due-diligence audit ranked **H-29** high: `crossengin chat`'s `read_file` and
`propose_manifest_edit` tools were not confined to the project. Both resolved the model's path with
`resolve(rootDir, path)` and an extension check, the read tool's description said *"Relative or
absolute path"*, and the write tool's description claimed a diff was shown while the interactive
approver printed counts. At `f6faf05` it was **true and open**: `git diff 2b98f46 HEAD --
apps/architect-cli` touched only `apply.ts`. The tools are gated by `--allow-file-read` and live on
a developer workstation, so the harm is a prompt injection in a file the model reads sending any
reachable file on that machine to the model vendor.

Measured against the built dist before the change, from a scratch root holding a symlink to a file
outside it, a symlinked directory and a non-manifest `package.json`:

| Probe | Result |
|---|---|
| read `../outside/o.json`, an absolute outside path, `link.json` (file symlink out), `dirlink/o.json` | all returned |
| read `/home/user/CrossEngin/package.json` | returned |
| read `/etc/os-release` | refused, and only for its extension |
| write `../outside/w.json`, `dirlink/w2.json` | written outside the root |
| write over `package.json` (valid JSON, not a manifest) | overwritten, and the approver told **CREATE** |
| a file over the size cap | read whole before its size was checked |

Three of the record's statements were narrower than the code. The verification report lists the
readable extensions as `.json/.yaml/.md`; the original audit's `.json/.yaml/.txt/.md` is the right
one, and `.yml` was readable too. *"Overwrites any .json"* understated the write: a non-manifest
file was treated as absent, so the person approving was told the write was a creation. And *"tool
text claims a diff is shown"* is partly superseded by ADR-0435's detail lines, but no text diff was
ever shown, and under `--auto-approve-writes` nobody was shown anything — which no description said.

## Decision

**Both tools are confined to one root, and nothing is written until a person has been shown a real
unified diff of exactly the bytes that will land — or the session is in auto-approve mode and the
tool says so.**

- `file-confinement.ts` resolves the root with `realpath` and refuses the filesystem root `/`. A
  path must stay under the root **as written** (catching `..` and absolute paths) **and after every
  symlink is resolved** (catching file and directory links), and the name rules run on both
  spellings, so an innocently named link cannot reach a secret file.
- Refused by name: hidden files and directories (`.env*`, `.git`, `.ssh`, …), credential-named files
  (`secret`, `credential`, `password`, `service-account`, `id_ed25519`, `api-key`, …), a dangling
  symlink on write, anything not a regular file, and a name carrying control characters, C1
  characters or bidi overrides (`path_invalid`) — checked on the requested path before the
  outside-root message, which echoes it. Design-token files are deliberately allowed.
- Files are opened `O_NOFOLLOW|O_NONBLOCK` and the size is checked **before** reading. A file whose
  content matches a credential is refused (`secret_content`) using the commit scanner's seven
  patterns in the scanner's own `{pattern, requires}` form.
- `unified-diff.ts` renders a three-line-context line diff with a no-newline marker and a 400-line
  cap that counts the remainder; control bytes and bidi overrides are shown as visible escapes in
  the lines and the `--- a/<path>` labels.
- The approval request's `unifiedDiff` is **required** and is the bytes on disk against exactly the
  bytes to be written. An existing file that is not a manifest is refused
  (`existing_file_not_a_manifest`) rather than overwritten, and the file is re-checked before the
  write, so a change while the prompt was open writes nothing (`file_changed_since_approval`).
- Every refusal reads `refused (<reason>)` and returned paths are relative to the root. The tool
  descriptions say read contents go to the conversation and describe the review the session actually
  has, through `WriteApprover.showsDiffToPerson`, which defaults to promising no review; they do
  **not** carry the absolute root, which would send the OS user name and directory layout to the
  vendor for nothing.
- In human output the approver escapes the path, every diff line and the `details` lines, and the
  renderer escapes the model's streamed text, the tool-call name and the tool-result display,
  because an SGR "conceal" streamed before a tool call could otherwise hide the diff printed after it.
- `--file-root <dir>` names the root (default: the working directory); `/`, a bare `--file-root` and
  `--file-root=` exit 2. A startup line names the root and whether writes are auto-approved.

The behaviour changes follow ADR-0338's rule because each refused act is the defect: reads and
writes outside the working directory are refused with `--file-root` as the named way to point
elsewhere, and overwriting a schema-invalid manifest is refused where it was mislabelled CREATE, so
the user moves the file aside.

## Alternatives considered

- **Refuse outside paths lexically only.** Refused: a file or directory symlink inside the root
  reaches outside it with an innocent spelling, measured on both shapes.
- **Content patterns with lookaheads.** This is how the first implementation spelled them, and
  review measured it quadratic: 450 KB of repeated `sk-` took **38.9 s**, several minutes at the
  1 MiB cap, from any file the model is asked to read. The scanner's linear form scans 1 MiB in
  **24 ms**. A parity test comparing one sample per kind could not see the difference, so the test
  now compares the two pattern sets source for source.
- **Escape at the renderer and trust the path.** Refused: `confinePath` admitted control
  characters, `\r\n`, C1 characters and bidi overrides, so a model-chosen name could forge or erase
  prompt lines before any rendering ran. The name is refused, and the renderer escapes as well.
- **Keep the default root silent.** Refused: the startup line is the only place a person learns
  which directory the model can read.

## Consequences

- **Positive:** a prompt injection can no longer reach a file outside the root, behind a symlink, in
  a hidden directory, or carrying a credential, and an approval is over the real bytes.
- **Negative:** a user who pointed the tools at absolute paths or overwrote a broken manifest now
  gets a refusal; a test that wrote to `/tmp/...` was rewritten to use a temporary root, and the test
  that pinned the root in the description was rewritten to assert its absence.
- **Neutral:** `tools.ts`, `chat.ts`, `tools.test.ts` and `chat.test.ts` carry ADR-0435's
  uncommitted `approval-detail` work too; the two land together.
- **Reversibility:** local to `apps/architect-cli`; nothing persisted changes shape.

## Implementation notes

`@crossengin/architect-cli` 266/266 (258 after the implementation, 8 added in review), typecheck
clean; `@crossengin/testing` 796/796. 3,000 random diffs applied cleanly with GNU `patch`. Sixteen
fences were mutation-checked by the implementation and ten more by review, plus eleven of the
implementation's re-checked; each fails the tests when broken. Two first survived and were closed by
a new test each: diff-line escaping inside the renderer, and the requested-path control-character
check. One review mutation of the dangling-symlink fence was vacuous (it left the `throw`), was
corrected and then fails.

Verified in-process against the built dist — no server or database is involved:

| Arm | Before | After |
|---|---|---|
| read `../out/o.json`, an absolute outside path | returned | `refused (outside_root)` |
| read through a file or directory symlink out | returned | `refused (symlink_escape)` |
| read `.env` / a file holding an `sk-ant-…` key / `/etc/os-release` | the `.json` returned | `hidden_path` / `secret_content` / `outside_root` |
| read a name containing control characters | accepted | `refused (path_invalid)` |
| control: read `package.json`, `notes.md` | — | OK |
| write `../out/w.json`, `dirlink/w2.json` | written outside | refused; the outside directory still holds only `o.json` |
| write over a non-manifest `package.json` | overwritten, labelled CREATE | `applied: false`, `existing_file_not_a_manifest`, file unchanged |
| control: write `new.json` | — | applied after one approval carrying a 24-line unified diff |
| `chat --allow-file-read --file-root /` and `--file-root=` | — | exit 2 |

No real provider was driven end to end; coverage is `runChat` and `runChatExchange` with stub
providers plus the dist script above.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A symlink swapped into an intermediate directory between the check and the open is not caught; the tools cannot create links, so it needs a concurrent local process | platform | _open_ |
| A hard link inside the root to a file outside it is not detected | platform | _open_ |
| A diff truncated at 400 lines can still be approved; the truncation is stated in the prompt | platform | _open_ |
| The default root is the working directory, so chat started from `$HOME` reaches every non-hidden file there; the startup line names it and nothing refuses it | platform | _open_ |
| With reading disabled, the write tool still tells the model whether a `.json` exists, whether it is a manifest, and its diff counts | platform | _open_ |
| Non-refusal errors (e.g. `EACCES`) still put an absolute path in the message returned to the model | platform | _open_ |
| With no file tool enabled, `--file-root /` is accepted silently; the flag does nothing then, so it is harmless and unchecked | platform | _open_ |
| In the commit scanner, `openai_api_key`'s lowercase `requires` is vacuous (it tests the whole match, which always starts `sk-`); the content check copies it to stay identical | platform | _open_ |

## References

- `apps/architect-cli/src/file-confinement.ts`, `unified-diff.ts`, `tools.ts`, `chat.ts`,
  `commands.ts`, `cli.ts`, and their tests
- `packages/testing/src/strategy/secret-values.ts`
