import { readFile } from "node:fs/promises";

/**
 * Reads a JSON file a CLI flag names, failing with the **flag** and the **path** in the message.
 *
 * Five flags parsed their file inline as `JSON.parse(await readFile(path, "utf8"))` (ADR-0390 Q5),
 * so a missing file surfaced as `ENOENT: no such file or directory, open '<path>'` — the path and no
 * flag — and a malformed one as `Unexpected token … is not valid JSON`, which names **neither**: an
 * operator holding nineteen file-taking flags could not tell which file was wrong. Ten sibling
 * loaders already wrapped both failures (`access-reviews-lifecycle.ts`, `audit-chain-env.ts`, …);
 * this is that idiom extracted once, so the five call sites state the flag and nothing else.
 *
 * Two deliberate departures from the sibling idiom, both about what a message may carry:
 *
 *   - A read failure names the error's **code** (`ENOENT`, `EACCES`, `EISDIR`) rather than its
 *     message, because Node's message repeats the path and the code is what an operator acts on.
 *   - A parse failure names **no detail from the parser**. V8's `SyntaxError` quotes the input it
 *     choked on (`Unexpected token 's', "secret-ish" is not valid JSON`), and a file a flag names may
 *     hold key material; the path is enough to open the file and see.
 *
 * Returns `unknown`: each caller already parses the value through its own schema, which is where the
 * shape is checked and where its own errors name the flag.
 */
export async function readFlagJsonFile(flag: string, path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as { readonly code?: unknown } | null)?.code;
    const why = typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
    throw new Error(`${flag}: cannot read ${path}: ${why}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${flag}: invalid JSON in ${path}`);
  }
}
