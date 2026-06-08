import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { problemResponse, type RawWebResponse } from "./http.js";

/** The URL path the SSR'd pages load the hydration bundle from. */
export const CLIENT_BUNDLE_PATH = "/assets/operate-web-client.js";

/** The bundle file name `build:client` emits into `dist/assets/`. */
export const CLIENT_BUNDLE_FILE = "operate-web-client.js";

/**
 * Resolves the on-disk path of the built client bundle. The compiled module
 * lives at `dist/src/assets.js`, so the bundle (emitted to `dist/assets/`) is
 * one directory up from `src/` — `<dist>/assets/<file>`.
 */
export function clientBundlePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "assets", CLIENT_BUNDLE_FILE);
}

/** Anything that loads the bundle bytes (injectable for hermetic tests). */
export type BundleLoader = () => Promise<Uint8Array | null>;

/** Default loader: read the built bundle from disk, returning null if absent. */
export const defaultBundleLoader: BundleLoader = async () => {
  try {
    return await readFile(clientBundlePath());
  } catch {
    return null;
  }
};

/**
 * Serves the client hydration bundle as `application/javascript`. When the
 * bundle hasn't been built (the file is missing), responds 503 with a helpful
 * message pointing at the `build:client` script — the SSR pages still render
 * (they're server-complete), they just won't hydrate until the bundle exists.
 */
export async function serveClientBundle(load: BundleLoader = defaultBundleLoader): Promise<RawWebResponse> {
  const bytes = await load();
  if (bytes === null) {
    return problemResponse(
      503,
      "Client bundle not built",
      "run `pnpm --filter @crossengin/operate-web-app build:client` to produce the hydration bundle",
    );
  }
  return {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "content-length": bytes.byteLength.toString(),
      "cache-control": "public, max-age=3600",
    },
    body: bytes,
  };
}
