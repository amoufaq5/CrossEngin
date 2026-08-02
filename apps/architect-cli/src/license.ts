import { readFile } from "node:fs/promises";

import { generateEd25519Keypair } from "@crossengin/crypto";
import {
  DEFAULT_PLAN_CATALOG,
  buildPlanCatalog,
  signLicense,
  verifyLicense,
  type EntitlementStatus,
  type LicenseClaims,
  type PlanCatalog,
} from "@crossengin/operate-runtime";

import { getStringFlag, type ParsedCommand } from "./cli.js";
import { printError, printJson, printSuccess, type IoStreams } from "./format.js";
import type { RunContext } from "./commands.js";

const STATUSES: readonly EntitlementStatus[] = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "unpaid",
  "incomplete",
];

function isStatus(v: string): v is EntitlementStatus {
  return (STATUSES as readonly string[]).includes(v);
}

/**
 * `crossengin license <action>` — the licensor's offline-license toolbox:
 *  - `keygen`  → an Ed25519 keypair (public key ships to operators, private key stays secret)
 *  - `mint`    → a signed license token bound to a tenant + status + expiry
 *  - `inspect` → verify a token against a public key and print its claims
 */
export async function runLicense(command: ParsedCommand, ctx: RunContext): Promise<number> {
  const action = command.positional[0];
  switch (action) {
    case "keygen":
      return runKeygen(command, ctx);
    case "mint":
      return runMint(command, ctx);
    case "inspect":
      return runInspect(command, ctx);
    default:
      printError(ctx.io, "license: expected an action. usage: crossengin license <keygen|mint|inspect>");
      return 2;
  }
}

function runKeygen(command: ParsedCommand, ctx: RunContext): number {
  const kp = generateEd25519Keypair();
  if (command.format === "json") {
    printJson(ctx.io, { publicKeyBase64: kp.publicKeyBase64, privateKeyBase64: kp.privateKeyBase64 });
  } else {
    ctx.io.stdout.write(`public key (ship to operators via --license-key):\n  ${kp.publicKeyBase64}\n`);
    ctx.io.stdout.write(`private key (KEEP SECRET — signs licenses):\n  ${kp.privateKeyBase64}\n`);
  }
  return 0;
}

function missing(io: IoStreams, flag: string): number {
  printError(io, `license mint: missing required --${flag}`);
  return 2;
}

async function runMint(command: ParsedCommand, ctx: RunContext): Promise<number> {
  const tenantId = getStringFlag(command, "tenant");
  const privateKey = getStringFlag(command, "private-key");
  const publicKey = getStringFlag(command, "public-key");
  const expiresAt = getStringFlag(command, "expires");
  if (tenantId === null) return missing(ctx.io, "tenant");
  if (privateKey === null) return missing(ctx.io, "private-key");
  if (publicKey === null) return missing(ctx.io, "public-key");
  if (expiresAt === null) return missing(ctx.io, "expires");

  const statusRaw = getStringFlag(command, "status") ?? "active";
  if (!isStatus(statusRaw)) {
    printError(ctx.io, `license mint: invalid --status ${statusRaw} (${STATUSES.join("|")})`);
    return 2;
  }
  const issuedAt = getStringFlag(command, "issued") ?? new Date().toISOString();
  const planId = getStringFlag(command, "plan");
  const featuresRaw = getStringFlag(command, "features");
  const maxRaw = getStringFlag(command, "max-records-per-entity");

  // Plan-derived limits: with --plan, the cap + features come from the plan catalog (default
  // or a supplied --plan-catalog file) — so an offline license carries the SAME limits the
  // cloud path resolves for that plan. Explicit --max-records-per-entity / --features still win.
  let catalog: PlanCatalog = DEFAULT_PLAN_CATALOG;
  const planCatalogFile = getStringFlag(command, "plan-catalog");
  if (planCatalogFile !== null) {
    try {
      catalog = buildPlanCatalog(JSON.parse(await readFile(planCatalogFile, "utf8")));
    } catch (err) {
      printError(ctx.io, `license mint: could not load --plan-catalog: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  const planLimits = planId !== null ? catalog.limitsFor(planId) : undefined;

  const explicitFeatures =
    featuresRaw !== null ? featuresRaw.split(",").map((f) => f.trim()).filter((f) => f.length > 0) : undefined;
  const features = explicitFeatures ?? planLimits?.features;
  const explicitMax = maxRaw !== null && Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : undefined;
  const maxRecordsPerEntity = explicitMax ?? planLimits?.maxRecordsPerEntity;

  const claims: LicenseClaims = {
    tenantId,
    status: statusRaw,
    issuedAt,
    expiresAt,
    ...(planId !== null ? { planId } : {}),
    ...(features !== undefined ? { features: [...features] } : {}),
    ...(maxRecordsPerEntity !== undefined ? { maxRecordsPerEntity } : {}),
  };

  let token: string;
  try {
    token = signLicense(privateKey, publicKey, claims);
  } catch (err) {
    printError(ctx.io, `license mint: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (command.format === "json") {
    printJson(ctx.io, { token, claims });
  } else {
    ctx.io.stdout.write(`${token}\n`);
  }
  return 0;
}

function runInspect(command: ParsedCommand, ctx: RunContext): number {
  const token = command.positional[1] ?? getStringFlag(command, "token");
  const publicKey = getStringFlag(command, "public-key");
  if (token === null || token === undefined) {
    printError(ctx.io, "license inspect: missing token. usage: crossengin license inspect <token> --public-key <b64>");
    return 2;
  }
  if (publicKey === null) {
    printError(ctx.io, "license inspect: missing required --public-key");
    return 2;
  }

  const result = verifyLicense(token, publicKey);
  if (command.format === "json") {
    printJson(ctx.io, result);
  } else if (result.valid) {
    printSuccess(ctx.io, "license is valid");
    ctx.io.stdout.write(`  tenant:  ${result.claims!.tenantId}\n`);
    ctx.io.stdout.write(`  status:  ${result.claims!.status}\n`);
    ctx.io.stdout.write(`  expires: ${result.claims!.expiresAt}\n`);
    if (result.claims!.planId !== undefined) ctx.io.stdout.write(`  plan:    ${result.claims!.planId}\n`);
    if (result.claims!.maxRecordsPerEntity !== undefined) {
      ctx.io.stdout.write(`  cap:     ${result.claims!.maxRecordsPerEntity} records/entity\n`);
    }
  } else {
    printError(ctx.io, `license is invalid: ${result.reason ?? "unknown"}`);
  }
  return result.valid ? 0 : 1;
}
