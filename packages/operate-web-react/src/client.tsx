import { hydrateRoot } from "react-dom/client";

import { PageRoot } from "./page.js";
import { PAGE_STATE_GLOBAL, parsePageState } from "./page-state.js";
import type { WebPageState } from "./page-state.js";

/**
 * The browser entry point — bundled by `apps/operate-web`'s `build:client`
 * (esbuild, `platform: browser`) and loaded by the SSR'd page's deferred
 * `<script src>`. It reads the embedded `WebPageState` global the SSR wrote, then
 * `hydrateRoot`s the *same* `PageRoot` component tree into `#root`, attaching to
 * the server markup (so the table page becomes interactive — sort + pagination
 * over the existing `/ui/:entity` JSON endpoints — with no full reload). Detail /
 * form / app pages hydrate to identical static markup; their row links remain
 * normal navigations to the SSR detail pages.
 *
 * This module imports `react-dom/client`, so it is NEVER pulled into the Node /
 * vitest path — only the bundler (and the browser) load it. The pure helpers it
 * relies on (`parsePageState`, `PageRoot`'s data shaping) live in DOM-free
 * modules and are unit-tested there.
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

/** Hydrates `PageRoot` from the embedded state into the given mount element. */
export function hydrate(mount: Element, state: WebPageState): void {
  hydrateRoot(mount, <PageRoot state={state} />);
}

/** The default boot path: find `#root` + the embedded state, then hydrate. */
export function bootstrap(): void {
  const mount = document.getElementById("root");
  const state = readEmbeddedState();
  if (mount === null || state === null) return;
  hydrate(mount, state);
}

bootstrap();
