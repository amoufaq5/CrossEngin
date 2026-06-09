import { hydrateRoot } from "react-dom/client";

import { AppRouter } from "./router.js";
import { PAGE_STATE_GLOBAL, parsePageState } from "./page-state.js";
import type { WebPageState } from "./page-state.js";

/**
 * The browser entry point — bundled by `apps/operate-web`'s `build:client`
 * (esbuild, `platform: browser`) and loaded by the SSR'd page's deferred
 * `<script src>`. It reads the embedded `WebPageState` global the SSR wrote, then
 * `hydrateRoot`s the `AppRouter` (which renders the *same* `PageRoot` tree the
 * SSR did, so it attaches cleanly to the server markup) into `#root`. The router
 * then turns same-origin `/app/...` navigation — link clicks, Back/Forward, and
 * write redirects (create/edit/delete/transition) — into in-page state swaps
 * over each page's `?__state=1` JSON, with no full reload.
 *
 * This module imports `react-dom/client`, so it is NEVER pulled into the Node /
 * vitest path — only the bundler (and the browser) load it. The pure helpers it
 * relies on (`parsePageState`, `appStateUrl`, `PageRoot`'s data shaping) live in
 * DOM-free modules and are unit-tested there.
 */

/** Reads + parses the embedded page-state global, or null when it's absent. */
export function readEmbeddedState(): WebPageState | null {
  const raw = (globalThis as Record<string, unknown>)[PAGE_STATE_GLOBAL];
  if (typeof raw === "object" && raw !== null) {
    return raw as WebPageState;
  }
  if (typeof raw === "string") {
    return parsePageState(raw);
  }
  return null;
}

/** Hydrates the `AppRouter` (SSR-parity `PageRoot`) from the embedded state into the mount element. */
export function hydrate(mount: Element, state: WebPageState): void {
  hydrateRoot(mount, <AppRouter initial={state} />);
}

/** The default boot path: find `#root` + the embedded state, then hydrate. */
export function bootstrap(): void {
  const mount = document.getElementById("root");
  const state = readEmbeddedState();
  if (mount === null || state === null) return;
  hydrate(mount, state);
}

bootstrap();
