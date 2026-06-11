import {
  CliUsageError as PackageCliUsageError,
  parseMarketplaceArgs as packageParseMarketplaceArgs,
  type MarketplaceCliOptions,
} from "@crossengin/marketplace-pg";

import { CliUsageError } from "./cli.js";

export type { MarketplaceCliOptions, MarketplaceCommand } from "@crossengin/marketplace-pg";
export { marketplaceHelpText, runMarketplace, type MarketplaceSource } from "@crossengin/marketplace-pg";

/**
 * Parses `operate-server marketplace <list|verify|install|uninstall> [options]`
 * argv (the slice after the `marketplace` verb), delegating to
 * `@crossengin/marketplace-pg`'s framework-neutral `parseMarketplaceArgs` and
 * re-wrapping its `CliUsageError` as the operate-server `CliUsageError` so the
 * bin's exit-code mapping covers it uniformly with the serve / incidents / slo /
 * sdk-releases parsers. `list`/`verify` read the per-tenant install ledger
 * (`meta.pack_installations`); `install`/`uninstall` drive the install-lifecycle
 * engine and persist the resulting record. `verify` exits 1 on ledger drift.
 */
export function parseMarketplaceArgs(argv: readonly string[]): MarketplaceCliOptions {
  try {
    return packageParseMarketplaceArgs(argv);
  } catch (err) {
    if (err instanceof PackageCliUsageError) throw new CliUsageError(err.message);
    throw err;
  }
}
