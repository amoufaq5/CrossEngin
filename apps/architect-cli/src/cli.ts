export const SUBCOMMANDS = [
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
  "version",
  "help",
] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export const OUTPUT_FORMATS = ["human", "json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface ParsedCommand {
  readonly subcommand: Subcommand;
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
  readonly multiFlags: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly format: OutputFormat;
}

export interface ParseError {
  readonly kind: "parse_error";
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly command: ParsedCommand }
  | { readonly ok: false; readonly error: ParseError };

export function parseArgs(argv: readonly string[]): ParseResult {
  const args = argv.slice(2);
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const multiFlags = new Map<string, string[]>();

  function recordFlag(name: string, value: string | true): void {
    flags.set(name, value);
    if (typeof value === "string") {
      const existing = multiFlags.get(name);
      if (existing !== undefined) {
        existing.push(value);
      } else {
        multiFlags.set(name, [value]);
      }
    }
  }

  let subcommandRaw: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        recordFlag(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          recordFlag(arg.slice(2), next);
          i += 1;
        } else {
          recordFlag(arg.slice(2), true);
        }
      }
      continue;
    }
    if (subcommandRaw === null) {
      subcommandRaw = arg;
    } else {
      positional.push(arg);
    }
  }

  if (subcommandRaw === null) {
    return {
      ok: true,
      command: {
        subcommand: "help",
        positional,
        flags,
        multiFlags,
        format: "human",
      },
    };
  }
  if (!isSubcommand(subcommandRaw)) {
    return {
      ok: false,
      error: { kind: "parse_error", message: `unknown subcommand: ${subcommandRaw}` },
    };
  }
  const formatRaw = flags.get("format");
  let format: OutputFormat = "human";
  if (typeof formatRaw === "string") {
    if (formatRaw !== "human" && formatRaw !== "json") {
      return {
        ok: false,
        error: { kind: "parse_error", message: `unknown output format: ${formatRaw}` },
      };
    }
    format = formatRaw;
  }
  return {
    ok: true,
    command: { subcommand: subcommandRaw, positional, flags, multiFlags, format },
  };
}

export function isSubcommand(value: unknown): value is Subcommand {
  return typeof value === "string" && (SUBCOMMANDS as readonly string[]).includes(value);
}

export function getStringFlag(
  command: ParsedCommand,
  name: string,
): string | null {
  const value = command.flags.get(name);
  if (typeof value === "string") return value;
  return null;
}

export function getBooleanFlag(command: ParsedCommand, name: string): boolean {
  const value = command.flags.get(name);
  return value === true || value === "true" || value === "1";
}

export function getMultiFlag(
  command: ParsedCommand,
  name: string,
): ReadonlyArray<string> {
  return command.multiFlags.get(name) ?? [];
}

export function helpText(): string {
  return [
    "Usage: crossengin <command> [options]",
    "",
    "Commands:",
    "  init <output>           Scaffold a new manifest file",
    "  validate <path>         Validate a manifest against the kernel schema",
    "  diff <old> <new>        Compare two manifests",
    "  patch <base> <patch>    Apply a manifest patch (writes new manifest)",
    "  hash <path>             Print the deterministic manifest hash",
    "  apply [--dry-run] [--pack <slug>]",
    "                          Apply the meta-schema + optional vertical pack DDL",
    "  chat                    Interactive AI Architect session (Claude-backed)",
    "  sessions list           List persisted chat sessions (requires PG env)",
    "  sessions show <id>      Render one session's full transcript",
    "  sessions replay <id>    Replay one session as chat-style output",
    "  gateway start           Boot the API gateway runtime (defaults to PG mode)",
    "  gateway routes list     List PG-registered routes (requires PG env)",
    "  gateway routes register <route.json>",
    "                          Upsert a route from a JSON file (requires PG env)",
    "  gateway routes unregister <rt_id>",
    "                          Delete a route by id (requires PG env)",
    "  gateway routes register-pack <slug> [--api-version v1] [--dry-run]",
    "                          Generate + upsert CRUD + transition routes from a registered pack",
    "  gateway routes unregister-pack <slug> [--api-version v1] [--dry-run] [--by-source-pack]",
    "                          Delete every route whose id matches the regen for a pack",
    "                          (default), or DELETE WHERE source_pack = <slug> (--by-source-pack)",
    "  gateway routes sync-pack <slug> [--api-version v1] [--dry-run] [--created-by <uuid>] [--prune-obsolete]",
    "                          Upsert generated routes; classify stored as obsolete (this pack)",
    "                          vs external (other pack / unknown); optionally prune obsolete",
    "  retention expiring [--within-days N] [--include-expired]",
    "                          List per-tenant retention opt-outs whose opt_out_until falls",
    "                          within the configured window (default 30d). With --include-expired,",
    "                          also include already-expired opt-outs. (requires PG env)",
    "  retention effective <tenant-id> <table-name>",
    "                          Resolve the effective retention policy for a (tenant, table)",
    "                          pair: tenant override / tenant opt-out / platform default / none.",
    "                          (requires PG env)",
    "  retention effective-batch --pairs-file <path>",
    "                          Bulk-resolve effective retention for many (tenant, table)",
    "                          pairs read from a JSON file. File format: array of",
    "                          {tenantId, tableName} objects. Runs 2 PG queries total via",
    "                          effectiveRetentionBatch regardless of pair count. Preserves",
    "                          input order in output. (requires PG env)",
    "  retention opt-out <tenant-id> <table-name> [--until DATE] [--reason TEXT] [--retention-days N]",
    "                          Set opt_out=true on the (tenant, table) policy. Preserves",
    "                          existing retention_days; default 365 for new rows. --until and",
    "                          --reason both optional; not-provided means NULL. (requires PG env)",
    "  retention opt-in <tenant-id> <table-name>",
    "                          Clear opt_out (set false) and opt_out_until (NULL) for the",
    "                          (tenant, table) policy. Preserves opt_out_reason as audit",
    "                          history (per ADR-0161). Idempotent. (requires PG env)",
    "  retention set <tenant-id> <table-name> --days N [--enabled true|false]",
    "                          Set a non-opt-out per-tenant retention override. Clears any",
    "                          existing opt_out + opt_out_until on the row; preserves",
    "                          opt_out_reason as audit history (per ADR-0161). Default",
    "                          --enabled=true. (requires PG env)",
    "  retention delete <tenant-id> <table-name>",
    "                          Remove the per-tenant policy row entirely. Tenant inherits",
    "                          platform default. Idempotent (no-op when no matching row).",
    "                          (requires PG env)",
    "  retention history [--tenant <uuid>] [--table <name>] [--kind <event-kind>]",
    "                    [--actor-id <uuid>] [--actor-id-not <uuid>]",
    "                    [--since DATE] [--until DATE] [--limit N]",
    "                    [--after-id <uuid>] [--before-id <uuid>]",
    "                    [--range <after-id>..<before-id>] [--with-actor-names]",
    "                          Query the append-only opt-out/policy mutation audit log.",
    "                          Filter by tenant / table / event kind / actor / time range.",
    "                          Default --limit=100. Sorted by occurred_at DESC, id DESC.",
    "                          With --after-id, paginate forward past the cursor row (older",
    "                          entries). With --before-id, paginate backward toward newer",
    "                          entries. --after-id and --before-id are mutually exclusive.",
    "                          With --range <after-id>..<before-id>, pass both cursors as",
    "                          a single flag for window-bounded pagination (events older",
    "                          than after-id AND newer than before-id). --range is",
    "                          mutually exclusive with bare --after-id / --before-id.",
    "                          Output gives nextAfterId + nextBeforeId for bidirectional",
    "                          navigation when the page is full. --actor-id scopes the log",
    "                          to one actor's mutations. --actor-id-not excludes that",
    "                          actor's mutations (system events with null actor_id are",
    "                          included). --with-actor-names LEFT JOINs meta.users to",
    "                          surface actor display_name + email alongside raw UUIDs.",
    "                          (requires PG env)",
    "  retention restore <history-id> [--dry-run] [--actor <uuid>]",
    "                          Restore a per-tenant policy to the state captured in",
    "                          tenant_retention_opt_out_history. prev_state=null restores",
    "                          via DELETE; populated prev_state restores via setTenantOptOut",
    "                          or setTenantRetention depending on prev_state.opt_out. Writes",
    "                          a new history row with attributes.restored_from = history-id.",
    "                          With --dry-run, show prev_state + planned mutation method",
    "                          without applying. (requires PG env)",
    "                          All 5 mutation/restore actions accept --attributes '<json>'",
    "                          where <json> is a JSON object merged into the history row's",
    "                          attributes JSONB column. Restore merges {restored_from:",
    "                          historyId} with operator-supplied attributes. Invalid JSON or",
    "                          non-object value returns exit 2.",
    "  retention diff-history <history-id-a> <history-id-b> [--kind <event-kind>]",
    "                          [--actor-id <uuid>] [--actor-id-not <uuid>]",
    "                          [--with-actor-names]",
    "                          Compare the policy state captured in two history events",
    "                          (next_state vs next_state). Both events must be on the same",
    "                          (tenant, table). Renders field-by-field diff. With --kind,",
    "                          assert both events have that event_kind (opt_out_set |",
    "                          opt_out_cleared | retention_set | policy_deleted); mismatch",
    "                          exits 1 with a clear error naming the offending side(s).",
    "                          With --actor-id, assert both events were authored by that",
    "                          actor; mismatch exits 1 (null actor_id renders as <system>).",
    "                          With --actor-id-not, assert NEITHER event was authored by",
    "                          that actor; match exits 1 (anti-actor verification).",
    "                          With --with-actor-names, LEFT JOIN meta.users so the header",
    "                          renders 'by display_name (uuid)' per event (falls back to",
    "                          email then raw UUID; null actor_id renders as <system>).",
    "                          (requires PG env)",
    "  retention diff-timeline <tenant-a> <tenant-b> <table-name>",
    "                          [--add-tenant <tenant-c> ...] [--since DATE]",
    "                          [--until DATE] [--limit N] [--with-actor-names]",
    "                          [--actor-id <uuid>] [--kind <event-kind>]",
    "                          [--after-id <uuid>] [--before-id <uuid>]",
    "                          [--range <after-id>..<before-id>]",
    "                          Show how two (or more) tenants' retention policies evolved over",
    "                          time on one table. Merges history events into a single",
    "                          chronological timeline (ASC). Each event tagged with [A]/[B]/...",
    "                          indicating which tenant changed. With --add-tenant <uuid>",
    "                          (repeatable): N-way merge across 3+ tenants. With",
    "                          --with-actor-names: LEFT JOIN meta.users + render",
    "                          'display_name (uuid)' alongside each event. --actor-id is",
    "                          repeatable — single value scopes to one actor's events,",
    "                          multiple values build an OR-semantic IN filter ('Alice OR",
    "                          Bob's mutations'). --kind is repeatable (same OR semantic)",
    "                          across opt_out_set|opt_out_cleared|retention_set|policy_deleted",
    "                          — invalid value exits 2. With --after-id: cursor forward",
    "                          in time (newer entries since diff-timeline is ASC). With",
    "                          --before-id: cursor backward toward older entries. --after-id",
    "                          and --before-id are mutually exclusive. With",
    "                          --range <after-id>..<before-id>, pass both cursors as a",
    "                          single flag for window-bounded pagination (mutually",
    "                          exclusive with bare --after-id / --before-id). Output gives",
    "                          nextAfterId + nextBeforeId when page is full. (requires PG env)",
    "  retention diff-timeline <tenant> <table-a> <table-b> --cross-table",
    "                          [--add-table <table-c> ...] [--since DATE] [--until DATE]",
    "                          [--limit N] [--with-actor-names] [--actor-id <uuid>]",
    "                          [--kind <event-kind>] [--after-id <uuid>] [--before-id <uuid>]",
    "                          [--range <after-id>..<before-id>]",
    "                          Show how one tenant's retention policies evolved over time",
    "                          across 2+ tables. Merges history events from multiple tables",
    "                          into a single chronological timeline tagged with [A]/[B]/...",
    "                          indicating which table changed. --add-table requires",
    "                          --cross-table; mutually exclusive with --add-tenant.",
    "                          --actor-id + --kind both repeatable for OR-semantic multi-",
    "                          actor/multi-kind filters. --after-id cursors forward,",
    "                          --before-id cursors backward (mutually exclusive). With",
    "                          --range <after-id>..<before-id>, single-flag window cursor.",
    "                          Output gives nextAfterId + nextBeforeId when page is full.",
    "                          (requires PG env)",
    "  retention diff <tenant-a> <tenant-b> <table-name>",
    "                          Compare effective retention policies between two tenants on",
    "                          the same table. Reuses effectiveRetentionBatch internally (2",
    "                          queries total). Renders resolution summary per tenant + field",
    "                          diff. (requires PG env)",
    "  retention diff <tenant> <table-name> --vs-platform",
    "                          Compare a tenant's effective retention against the platform",
    "                          default for the same table. 2 parallel queries — tenant +",
    "                          platform. Useful for one-command 'how does this tenant differ",
    "                          from the default?' checks vs running two retention effective",
    "                          calls and mental-diffing. (requires PG env)",
    "  retention diff <tenant> <table-a> <table-b> --cross-table",
    "                          Compare one tenant's effective retention across two different",
    "                          tables. Reuses effectiveRetentionBatch internally (2 queries",
    "                          total). Useful for 'is this tenant's retention consistent",
    "                          across all trace tables?' audits. Mutually exclusive with",
    "                          --vs-platform. (requires PG env)",
    "  retention diff <a> <b> <table> --add-tenant <c> [--add-tenant <d> ...]",
    "                          N-way comparison across 3+ tenants on the same table.",
    "                          Renders per-field variation analysis (which tenants have",
    "                          which value). Repeats --add-tenant for each extra tenant.",
    "                          Mutually exclusive with --vs-platform and --cross-table.",
    "                          (requires PG env)",
    "  retention diff <tenant> <table-a> <table-b> --cross-table --add-table <table-c>",
    "                                                            [--add-table <table-d> ...]",
    "                          N-way comparison across 3+ tables for one tenant. Renders",
    "                          per-field variation analysis (which tables have which value).",
    "                          Requires --cross-table. Mutually exclusive with --vs-platform",
    "                          and --add-tenant. (requires PG env)",
    "                          All four diff variants accept --exit-on-divergence which",
    "                          returns exit 3 (instead of 0) when fieldDiffs is non-empty —",
    "                          for CI gates that fail the build when retention drifts.",
    "                          Pair with --threshold N (default 1) to require N+ field",
    "                          differences before exit 3 fires. --threshold requires",
    "                          --exit-on-divergence; invalid values exit 2.",
    "  retention prune [--dry-run]",
    "                          Run retention pruning ad-hoc (normally invoked via scheduled",
    "                          job). With --dry-run, count rows that would be deleted",
    "                          without actually deleting. Renders per-table + per-tenant",
    "                          results with a summary line. (requires PG env)",
    "  retention list-policies [--tenant <uuid>] [--table <name>]",
    "                          List all retention policies (platform defaults + per-tenant",
    "                          overrides). Optional --tenant scopes the per-tenant section;",
    "                          optional --table scopes both sections. (requires PG env)",
    "  version                 Print the CLI version + workspace info",
    "  help                    Show this help text",
    "",
    "Flags:",
    "  --format human|json     Output format (default: human)",
    "  --force                 With init / patch, overwrite an existing file",
    "  --output <path>         With patch, write the result to a different path",
    "  --dry-run               With apply, emit SQL without executing",
    "  --confirm               Required when PGDATABASE looks like production",
    "  --pack <slug>           With apply, also emit DDL for a vertical pack",
    "                          (e.g. 'operate-erp/core')",
    "  --pack-schema <name>    With --pack, the target schema (default: 'public')",
    "  --prompt <text>         With chat, run a one-shot turn and exit",
    "  --model <id>            With chat, pick a Claude model (default: claude-sonnet-4-6)",
    "  --max-tokens <n>        With chat, cap response tokens (default: 4096)",
    "  --system <text>         With chat, override the system prompt",
    "  --system-file <path>    With chat, load the system prompt from a file",
    "  --tenant-id <uuid>      With chat, set the tenant id (default: nil-uuid)",
    "  --session-id <id>       With chat, set the session id (default: cli-<ts>)",
    "  --no-tools              With chat, disable manifest tools (text-only mode)",
    "  --allow-file-read       With chat, expose a read_file tool (json/yaml/txt/md)",
    "  --allow-file-write      With chat, expose propose_manifest_edit (human approval)",
    "  --auto-approve-writes   With chat, skip the y/N prompt for write tools",
    "  --max-tool-iterations N With chat, cap tool-dispatch loops per turn (default: 5)",
    "  --persist               With chat, log session/messages/tools/proposals to Postgres",
    "  --cost-ceiling-usd N    With chat, refuse calls whose estimated cost exceeds N USD",
    "  --port <n>              With gateway start, listen on port (default: 8080)",
    "  --host <addr>           With gateway start, bind to address (default: 127.0.0.1)",
    "  --in-memory             With gateway start, use in-memory stores (no PG required)",
    "  --jwks-file <path>      With gateway start, enable Bearer-JWT auth from a JWKS JSON file",
    "  --jwks-url <url>        With gateway start, fetch the JWKS from an HTTPS endpoint",
    "                          (mutually exclusive with --jwks-file)",
    "  --jwks-refresh-seconds N  Periodic JWKS reload interval (default 300 for --jwks-url, 0 for file)",
    "  --jwt-issuer <iss>      With --jwks-file/--jwks-url, expected JWT issuer (required)",
    "  --jwt-audience <aud>    With --jwks-file/--jwks-url, expected JWT audience (required)",
    "  --clock-skew-seconds N  With --jwks-file/--jwks-url, exp/nbf grace window (default 30, max 600)",
    "  --created-by <uuid>     With 'gateway routes register', the actor uuid stored on the route",
    "  --prune-obsolete        With 'gateway routes sync-pack', delete stored routes that were",
    "                          registered by this pack but are no longer in the current generation",
    "  --by-source-pack        With 'gateway routes unregister-pack', skip the manifest pipeline",
    "                          and DELETE WHERE source_pack = <slug>. Works without resolvePack/",
    "                          tryValidateManifest (useful when the pack manifest is broken)",
    "  --within-days N         With 'retention expiring', the window upper bound in days (default 30)",
    "  --include-expired       With 'retention expiring', also surface already-expired opt-outs",
    "  --until DATE            With 'retention opt-out', ISO 8601 timestamp when the opt-out expires",
    "                          (omit for indefinite)",
    "  --reason TEXT           With 'retention opt-out', audit context (length 1..256, omit for null)",
    "  --retention-days N      With 'retention opt-out', placeholder retention_days for new rows",
    "                          (default 365; preserves existing on ON CONFLICT)",
    "  --tenant <uuid>         With 'retention list-policies', filter per-tenant section to one tenant",
    "  --table <name>          With 'retention list-policies', filter both sections to one table",
    "  --days N                With 'retention set', retention_days (integer >= 1; required)",
    "  --enabled true|false    With 'retention set', set enabled flag (default true)",
    "  --actor <uuid>          With opt-out / opt-in / set / delete, actor id recorded in",
    "                          tenant_retention_opt_out_history (optional; null when omitted)",
    "  --kind <event-kind>     With 'retention history', filter by event_kind",
    "                          (opt_out_set | opt_out_cleared | retention_set | policy_deleted)",
    "  --since DATE            With 'retention history', lower bound on occurred_at (ISO 8601)",
    "  --until DATE            With 'retention history', upper bound on occurred_at (ISO 8601)",
    "  --limit N               With 'retention history', max entries to return (default 100)",
    "  --after-id <uuid>       With 'retention history', cursor for forward pagination",
    "                          (returns entries strictly older than the cursor row)",
    "",
    "Environment (for apply / chat --persist / gateway start / gateway routes / retention):",
    "  PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE, PGAPPNAME",
    "",
    "Environment (for chat):",
    "  ANTHROPIC_API_KEY       Anthropic API key. At least one chat provider is required.",
    "  OPENAI_API_KEY          OpenAI API key. With two+ providers set, the router fans out.",
    "  AWS_ACCESS_KEY_ID,      AWS credentials for Bedrock (chat + embeddings). Optionally",
    "  AWS_SECRET_ACCESS_KEY     AWS_SESSION_TOKEN (STS) + AWS_REGION (default: us-east-1).",
    "",
  ].join("\n");
}
