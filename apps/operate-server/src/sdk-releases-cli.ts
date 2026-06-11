import {
  CliUsageError as PackageCliUsageError,
  parseSdkReleasesArgs as packageParseSdkReleasesArgs,
  type SdkReleasesCliOptions,
} from "@crossengin/sdk-clients-pg";

import { CliUsageError } from "./cli.js";

export type { SdkReleasesCliOptions, SdkReleasesCommand } from "@crossengin/sdk-clients-pg";
export { runSdkReleases, sdkReleasesHelpText, type SdkLedgerSource } from "@crossengin/sdk-clients-pg";

/**
 * Parses `operate-server sdk-releases <list|compat|verify> [options]` argv (the
 * slice after the `sdk-releases` verb), delegating to `@crossengin/sdk-clients-pg`'s
 * framework-neutral `parseSdkReleasesArgs` and re-wrapping its `CliUsageError` as
 * the operate-server `CliUsageError` so the bin's exit-code mapping covers it
 * uniformly with the serve / incidents / slo parsers. `list`/`compat` read the
 * ledger; `verify` runs the cross-table drift sweep and exits 1 on any drift —
 * populated by operate-server's own `openapi-client --release-version --persist`.
 */
export function parseSdkReleasesArgs(argv: readonly string[]): SdkReleasesCliOptions {
  try {
    return packageParseSdkReleasesArgs(argv);
  } catch (err) {
    if (err instanceof PackageCliUsageError) throw new CliUsageError(err.message);
    throw err;
  }
}
