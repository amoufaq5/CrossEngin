import type {
  ManifestSectionChange,
  ManifestSectionPresence,
  ValidationError,
} from "@crossengin/kernel/manifest";

export interface IoStreams {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

export function printJson(io: IoStreams, value: unknown): void {
  io.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function printSuccess(io: IoStreams, message: string): void {
  io.stdout.write(message + "\n");
}

export function printError(io: IoStreams, message: string): void {
  io.stderr.write(message + "\n");
}

export function formatValidationErrors(errors: readonly ValidationError[]): string {
  if (errors.length === 0) return "no validation errors";
  const lines: string[] = [`${errors.length.toString()} validation error(s):`];
  for (const e of errors) {
    const codeSuffix = e.code !== undefined ? ` [${e.code}]` : "";
    lines.push(`  ${e.path}: ${e.message}${codeSuffix}`);
  }
  return lines.join("\n");
}

export interface SummaryCounts {
  readonly entities: number;
  readonly workflows: number;
  readonly views: number;
  readonly reports: number;
  readonly dashboards: number;
  readonly jobs: number;
  readonly integrations: number;
  readonly roles: number;
  readonly traits: number;
  readonly relations: number;
  readonly fileTypes: number;
  readonly customWidgets: number;
}

export interface ManifestSummary {
  readonly name: string;
  readonly slug: string;
  readonly version: string;
  readonly description: string | null;
  readonly extendsParents: number;
  readonly compliancePacks: number;
  readonly counts: SummaryCounts;
  readonly hash: string;
}

export function formatManifestSummary(summary: ManifestSummary): string {
  const lines: string[] = [];
  lines.push(`Manifest: ${summary.name}`);
  lines.push(`  slug:        ${summary.slug}`);
  lines.push(`  version:     ${summary.version}`);
  if (summary.description !== null) {
    lines.push(`  description: ${summary.description}`);
  }
  lines.push(`  hash:        ${summary.hash}`);
  if (summary.extendsParents > 0) {
    lines.push(`  extends:     ${summary.extendsParents.toString()} parent(s)`);
  }
  if (summary.compliancePacks > 0) {
    lines.push(`  packs:       ${summary.compliancePacks.toString()}`);
  }
  lines.push("");
  lines.push("  Counts:");
  lines.push(`    entities:        ${summary.counts.entities.toString()}`);
  lines.push(`    workflows:       ${summary.counts.workflows.toString()}`);
  lines.push(`    views:           ${summary.counts.views.toString()}`);
  lines.push(`    reports:         ${summary.counts.reports.toString()}`);
  lines.push(`    dashboards:      ${summary.counts.dashboards.toString()}`);
  lines.push(`    jobs:            ${summary.counts.jobs.toString()}`);
  lines.push(`    integrations:    ${summary.counts.integrations.toString()}`);
  lines.push(`    roles:           ${summary.counts.roles.toString()}`);
  lines.push(`    traits:          ${summary.counts.traits.toString()}`);
  lines.push(`    relations:       ${summary.counts.relations.toString()}`);
  lines.push(`    file types:      ${summary.counts.fileTypes.toString()}`);
  lines.push(`    custom widgets:  ${summary.counts.customWidgets.toString()}`);
  return lines.join("\n");
}

/**
 * What a section's presence change reads as, as a total map so a fourth presence is a compile error
 * rather than a section silently rendered as an ordinary member change.
 */
const PRESENCE_LINE: Readonly<Record<ManifestSectionPresence, string | null>> = {
  added: "section added",
  removed: "section removed",
  present: null,
};

/**
 * One line per section the two manifests differ on, each followed by what that section's reach
 * means, from `diffManifestSections` — the same census the reviewer's diff view reads, so this
 * command and the console cannot disagree about whether two manifests differ.
 *
 * It replaced a counter that reported entities and hardcoded the workflow figures to zero, so a
 * change confined to workflows, roles, permissions, jobs, views or `meta.extends` printed
 * "(no changes)" for two manifests that were not the same.
 */
export function formatManifestSectionDiff(changes: readonly ManifestSectionChange[]): string {
  const lines: string[] = ["Manifest diff:"];
  if (changes.length === 0) {
    lines.push("  (no changes)");
    return lines.join("\n");
  }
  for (const change of changes) {
    const presence = PRESENCE_LINE[change.presence];
    const detail =
      presence !== null
        ? presence
        : change.membersKeyed
          ? `+${change.added.length.toString()} -${change.removed.length.toString()} ~${change.changed.length.toString()}`
          : `changed (members unkeyed; ${change.countBefore.toString()} -> ${change.countAfter.toString()})`;
    lines.push(`  ${change.section} [${change.reach}]: ${detail}`);
    const named: string[] = [];
    if (change.added.length > 0) named.push(`added ${change.added.join(", ")}`);
    if (change.removed.length > 0) named.push(`removed ${change.removed.join(", ")}`);
    if (change.changed.length > 0) named.push(`changed ${change.changed.join(", ")}`);
    if (named.length > 0) lines.push(`    ${named.join("; ")}`);
    lines.push(`    ${change.reachNote}`);
  }
  return lines.join("\n");
}
