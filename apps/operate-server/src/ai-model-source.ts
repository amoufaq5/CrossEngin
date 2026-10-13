/**
 * Where the AI model name comes from, and why it needed a second route.
 *
 * `--ai-model` was the **only** AI setting with no environment route: the provider already resolves
 * entirely from `LOCAL_LLM_BASE_URL` / `OLLAMA_BASE_URL` / `LOCAL_LLM_API_KEY` / `ANTHROPIC_API_KEY`
 * / `OPENAI_API_KEY` (`ai-design.ts`), and `deploy/.env.example` has documented `OPERATE_AI_MODEL`
 * since the overlay shipped -- the overlay even uses that variable to tell Ollama which model to
 * pull. One setting, two spellings, and only the flag reached the server.
 *
 * That gap is why `deploy/docker-compose.ai.yml` carried its own copy of the entire `api` command:
 * compose **replaces** a `command` rather than merging it, so adding one flag meant repeating all
 * of them, and its own comment said *"Keep the two in step when either changes."* Nobody did. By
 * the time ADR-0364 looked, the overlay's copy was **ten flags behind** the base -- including
 * `--credential-login`, so the entire self-hosted-AI path had no login at all and the web app it
 * ships with could authenticate nobody -- and it still passed `--api-key` on argv, which is the
 * exposure ADR-0357 removed from the base and ADR-0301 forbids.
 *
 * This is ADR-0288's maintained list for the Nth time, and the fix is the one that has worked every
 * previous time: make the duplicate **unnecessary** rather than correct. With the model reachable
 * from the environment the overlay needs no `command` at all, so there is nothing left to keep in
 * step -- and `environment` maps *merge* across compose files, so every variable the base declares
 * survives an overlay that only adds to them.
 *
 * Unlike `API_KEY_SPECS_VAR` this is **not** a credential, so ADR-0301 is not the argument and
 * there is no warning for the argv route: a model name on a command line discloses nothing. The
 * flag therefore wins where both are present, which is the ordinary precedence for an explicit
 * argument over an ambient default, and the boot line says which was used so a stale variable
 * cannot be mistaken for the chosen one.
 */

export const AI_MODEL_VAR = "OPERATE_AI_MODEL";

/** Which route supplied the model, for the boot line. */
export const AI_MODEL_SOURCES = ["none", "argv", "env", "both"] as const;
export type AiModelSource = (typeof AI_MODEL_SOURCES)[number];

export interface ResolvedAiModel {
  /** The model to ask for, or null when neither route named one and the provider's default stands. */
  readonly model: string | null;
  readonly source: AiModelSource;
  /**
   * The value the losing route named, for the `both` line and null otherwise.
   *
   * Carried on the result rather than re-read where the sentence is built: this module takes `env`
   * as a parameter precisely so it has no ambient dependency, and a reader of `process.env` inside
   * the formatter would reintroduce one for the sake of one string.
   */
  readonly ignored: string | null;
}

/**
 * Merges the flag and the variable, flag first.
 *
 * Empty and whitespace are treated as absent on **both** routes, which matters for the environment
 * one specifically: `docker-compose.yml` writes `${OPERATE_AI_MODEL:-}`, so an unset variable
 * arrives as the empty string rather than as undefined, and an empty model name would be sent to
 * the provider as a request for a model called "".
 */
export function resolveAiModel(
  flag: string | null,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedAiModel {
  const fromFlag = (flag ?? "").trim();
  const fromEnv = (env[AI_MODEL_VAR] ?? "").trim();
  const hasFlag = fromFlag !== "";
  const hasEnv = fromEnv !== "";
  if (hasFlag && hasEnv) return { model: fromFlag, source: "both", ignored: fromEnv };
  if (hasFlag) return { model: fromFlag, source: "argv", ignored: null };
  if (hasEnv) return { model: fromEnv, source: "env", ignored: null };
  return { model: null, source: "none", ignored: null };
}

/**
 * The boot sentence, which says what was used **and** what was ignored.
 *
 * `both` is the case worth a sentence rather than silence: a deployment that sets the variable and
 * also passes the flag has two answers on file, and an operator who edits the one that loses would
 * see no change and have nothing to read. The other three are stated plainly so that "we checked"
 * is never inferred from an absent line.
 */
export function aiModelLine(resolved: ResolvedAiModel): string {
  switch (resolved.source) {
    case "argv":
      return `[ai-design] model: ${resolved.model ?? ""} (from --ai-model)`;
    case "env":
      return `[ai-design] model: ${resolved.model ?? ""} (from ${AI_MODEL_VAR})`;
    case "both":
      return (
        `[ai-design] model: ${resolved.model ?? ""} (from --ai-model; ${AI_MODEL_VAR}=` +
        `${resolved.ignored ?? ""} is ignored, because an explicit argument outranks an ambient` +
        " default)"
      );
    case "none":
      return `[ai-design] model: not named by --ai-model or ${AI_MODEL_VAR}; the provider's default stands`;
  }
}
