import { constants } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { containsTerminalUnsafe } from "./unified-diff.js";

/**
 * Where the chat tools may touch the filesystem, and what they may not touch inside it (H-29).
 *
 * `read_file` hands a file's text to whichever model vendor is serving the session, and
 * `propose_manifest_edit` writes one, so both are an exfiltration and an overwrite primitive for
 * anything that can steer the model — a prompt, a pasted document, a manifest's own description.
 * They used to `resolve(root, path)` and stop there, which confines nothing: `..`, an absolute path
 * and a symlink all reached any file of an allowed extension the user could read or write.
 *
 * The rule is lexical **and** physical. The requested path must lie under the root as written, and
 * the file it names must still lie under the root once every symlink is resolved — checking only the
 * first admits a link inside the root pointing out of it, and checking only the second admits `..`
 * through a directory that happens to resolve back in. The extension, hidden-component and
 * secret-name rules are applied to **both** spellings, because a link named `notes.md` pointing at
 * `id_ed25519` inside the root passes every rule on its own name.
 *
 * The final open uses `O_NOFOLLOW` on the resolved path, which has no link in its last component, so
 * a link swapped in after the check is refused by the kernel rather than followed. A link swapped
 * into an *intermediate* directory between the check and the open is not caught; the tools cannot
 * create links, so reaching that needs a concurrent local process, which is outside what this guards.
 */

export const FILE_REFUSAL_REASONS = [
  "path_invalid",
  "outside_root",
  "symlink_escape",
  "dangling_symlink",
  "hidden_path",
  "secret_named",
  "extension_not_allowed",
  "not_a_regular_file",
  "not_found",
  "too_large",
  "secret_content",
] as const;
export type FileRefusalReason = (typeof FILE_REFUSAL_REASONS)[number];

export class FileToolRefusal extends Error {
  constructor(
    readonly reason: FileRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "FileToolRefusal";
  }
}

export interface ConfinedPath {
  /** Fully resolved, every symlink followed; this is what is opened. */
  readonly real: string;
  /** Relative to the root, as the model and the person are shown it. */
  readonly relative: string;
  readonly exists: boolean;
}

/**
 * The root, resolved once. Refuses the filesystem root, because confining to `/` is not
 * confinement, and refuses a root that is not a directory.
 */
export async function resolveFileRoot(dir: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(resolve(dir));
  } catch (err) {
    throw new FileToolRefusal(
      "not_found",
      `file root ${dir} cannot be resolved: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const s = await stat(real);
  if (!s.isDirectory()) {
    throw new FileToolRefusal("path_invalid", `file root ${real} is not a directory`);
  }
  if (dirname(real) === real) {
    throw new FileToolRefusal(
      "outside_root",
      `file root ${real} is the filesystem root, which confines nothing; pass --file-root <dir>`,
    );
  }
  return real;
}

function within(root: string, candidate: string): string | null {
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Basename fragments that name a credential. Deliberately not `token`: design-token files are an
 * ordinary thing to keep beside a manifest, and a real token inside any file is the content check's.
 */
const SECRET_NAME_FRAGMENTS = [
  "secret",
  "credential",
  "password",
  "passwd",
  "htpasswd",
  "pgpass",
  "private-key",
  "private_key",
  "privatekey",
  "api-key",
  "api_key",
  "apikey",
  "service-account",
  "service_account",
  "serviceaccount",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "kubeconfig",
] as const;

function checkNamedPath(rel: string, extensions: readonly string[], spelling: string): void {
  if (containsTerminalUnsafe(rel)) {
    // Not echoed: the name is what would forge or erase lines in the approval prompt.
    throw new FileToolRefusal(
      "path_invalid",
      `${spelling} carries a control, line-break or bidirectional-override character, which these tools never touch`,
    );
  }
  const parts = rel.split(sep);
  for (const part of parts) {
    if (part.startsWith(".")) {
      throw new FileToolRefusal(
        "hidden_path",
        `${spelling} ${rel} is or is inside a hidden file or directory (.env, .git, .ssh, …), which these tools never touch`,
      );
    }
  }
  const name = basename(rel).toLowerCase();
  for (const fragment of SECRET_NAME_FRAGMENTS) {
    if (name.includes(fragment)) {
      throw new FileToolRefusal(
        "secret_named",
        `${spelling} ${rel} is named like a credential ('${fragment}'), which these tools never touch`,
      );
    }
  }
  if (!extensions.some((ext) => name.endsWith(ext))) {
    throw new FileToolRefusal(
      "extension_not_allowed",
      `${spelling} ${rel}: extension not allowed; permitted: ${extensions.join(", ")}`,
    );
  }
}

/**
 * Resolves `requested` against `root` (already a realpath) and enforces every path rule. For a
 * write the file may not exist yet; its parent must, and must lie under the root.
 */
export async function confinePath(
  root: string,
  requested: string,
  extensions: readonly string[],
  mode: "read" | "write",
): Promise<ConfinedPath> {
  if (requested.length === 0 || containsTerminalUnsafe(requested)) {
    throw new FileToolRefusal(
      "path_invalid",
      "path is empty or carries a NUL, control, line-break or bidirectional-override character",
    );
  }
  const lexical = resolve(root, requested);
  const lexicalRel = within(root, lexical);
  if (lexicalRel === null) {
    throw new FileToolRefusal(
      "outside_root",
      `path ${requested} is outside the file root; only files under it are reachable`,
    );
  }
  checkNamedPath(lexicalRel, extensions, "path");

  let real: string;
  let exists: boolean;
  let linkStat: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    linkStat = await lstat(lexical);
  } catch {
    linkStat = null;
  }
  if (linkStat !== null) {
    try {
      real = await realpath(lexical);
    } catch {
      throw new FileToolRefusal(
        "dangling_symlink",
        `path ${lexicalRel} is a symlink to nothing; writing through it would create a file wherever it points`,
      );
    }
    exists = true;
    if (!(await stat(real)).isFile()) {
      throw new FileToolRefusal("not_a_regular_file", `path ${lexicalRel} is not a regular file`);
    }
  } else {
    if (mode === "read") {
      throw new FileToolRefusal("not_found", `path ${lexicalRel} does not exist under the file root`);
    }
    let realParent: string;
    try {
      realParent = await realpath(dirname(lexical));
    } catch {
      throw new FileToolRefusal(
        "not_found",
        `parent directory of ${lexicalRel} does not exist under the file root`,
      );
    }
    real = join(realParent, basename(lexical));
    exists = false;
  }
  const realRel = within(root, real);
  if (realRel === null) {
    throw new FileToolRefusal(
      "symlink_escape",
      `path ${lexicalRel} resolves through a symlink to a file outside the file root`,
    );
  }
  checkNamedPath(realRel, extensions, "resolved path");
  return { real, relative: lexicalRel, exists };
}

/**
 * One pattern per credential shape the workspace's commit scanner knows (`SECRET_PATTERN_KINDS` in
 * `@crossengin/testing`), kept as a second spelling because a shipped binary must not depend on a
 * test package; the test asserts the two are the same patterns, source for source.
 *
 * `requires` is a test on each match rather than lookaheads inside the pattern, which is what keeps
 * the scan linear: lookaheads over `[A-Za-z0-9_-]*` re-scan the rest of the run from every `sk-`, so
 * 450 KB of repeated `sk-` took 39 s and the 1 MiB read cap about four minutes.
 */
export const CONTENT_SECRET_PATTERNS: Readonly<
  Record<string, { readonly pattern: RegExp; readonly requires?: readonly RegExp[] }>
> = {
  anthropic_api_key: { pattern: /sk-ant-[A-Za-z0-9_-]{32,}/g },
  openai_api_key: {
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
    requires: [/[0-9]/, /[A-Z]/, /[a-z]/],
  },
  aws_access_key_id: { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  pem_private_key: { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\\n|\s)*[A-Za-z0-9+/=]{64,}/g },
  slack_token: { pattern: /\bxox[abposr]-[0-9]+-[0-9A-Za-z-]{10,}/g },
  github_token: { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g },
  stripe_live_key: { pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g },
};

/** The kind of the first credential-shaped value in `text`, or null. Never the value itself. */
export function secretContentKind(text: string): string | null {
  for (const [kind, { pattern, requires }] of Object.entries(CONTENT_SECRET_PATTERNS)) {
    for (const match of text.matchAll(pattern)) {
      if (requires === undefined || requires.every((r) => r.test(match[0]))) return kind;
    }
  }
  return null;
}

async function openNoFollow(path: string, flags: number, modeBits?: number): Promise<FileHandle> {
  try {
    // O_NONBLOCK so a FIFO swapped in after the check fails rather than hanging the session.
    return await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, modeBits);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new FileToolRefusal("symlink_escape", "the file became a symlink after it was checked");
    }
    throw err;
  }
}

/**
 * Reads a confined file, refusing anything but a regular file and refusing by its size **before**
 * reading it, so an oversized file is never pulled into memory to be measured.
 */
export async function readConfinedText(path: ConfinedPath, maxBytes: number): Promise<string> {
  const handle = await openNoFollow(path.real, constants.O_RDONLY);
  try {
    const s = await handle.stat();
    if (!s.isFile()) {
      throw new FileToolRefusal("not_a_regular_file", `${path.relative} is not a regular file`);
    }
    if (s.size > maxBytes) {
      throw new FileToolRefusal(
        "too_large",
        `${path.relative} is ${s.size.toString()} bytes, over the ${maxBytes.toString()}-byte cap`,
      );
    }
    const buf = Buffer.alloc(s.size);
    let offset = 0;
    while (offset < s.size) {
      const { bytesRead } = await handle.read(buf, offset, s.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function writeConfinedText(path: ConfinedPath, text: string): Promise<void> {
  const handle = await openNoFollow(
    path.real,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    0o644,
  );
  try {
    const s = await handle.stat();
    if (!s.isFile()) {
      throw new FileToolRefusal("not_a_regular_file", `${path.relative} is not a regular file`);
    }
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}
