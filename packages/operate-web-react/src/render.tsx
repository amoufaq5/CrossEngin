import { renderToStaticMarkup, renderToString } from "react-dom/server";
import type { ReactNode } from "react";

import { PageRoot } from "./page.js";
import { PAGE_STATE_GLOBAL, serializePageState } from "./page-state.js";
import type { WebPageState } from "./page-state.js";

/**
 * A minimal inline stylesheet so the server-rendered pages are legible without
 * any external asset (the SSR-only renderer ships zero bundled JS/CSS). Kept
 * intentionally tiny — the product decision is hermetic SSR, not a design
 * system.
 */
const BASE_STYLES = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; line-height: 1.4; }
.ce-app-header { padding: 0.75rem 1rem; border-bottom: 1px solid #ccc; }
.ce-app-title { margin: 0; font-size: 1.25rem; }
.ce-app-nav ul { list-style: none; display: flex; gap: 1rem; padding: 0.5rem 1rem; margin: 0; flex-wrap: wrap; }
.ce-app-main { padding: 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; }
.ce-detail-section { margin-bottom: 1rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dt { font-weight: 600; }
.ce-form-field { margin-bottom: 0.75rem; display: flex; flex-direction: column; gap: 0.25rem; max-width: 32rem; }
.ce-required { color: #b00; }
`.trim();

export interface RenderPageOptions {
  /** The document `<title>` (default "CrossEngin Operate"). */
  readonly title?: string;
  /** Language attribute on `<html>` (default "en"). */
  readonly lang?: string;
}

/**
 * Server-renders a React node into a complete, self-contained HTML document:
 * `<!doctype html>` + a `<title>` + a tiny inline stylesheet + the statically
 * rendered markup. Uses `renderToStaticMarkup` (no hydration markers) — these
 * pages are read-only, SSR-only output. There is NO client bundle: client-side
 * hydration + a bundler are an explicit deferred follow-up.
 */
export function renderPage(node: ReactNode, options: RenderPageOptions = {}): string {
  const title = options.title ?? "CrossEngin Operate";
  const lang = options.lang ?? "en";
  const body = renderToStaticMarkup(node);
  const head =
    `<meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"/>` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>${BASE_STYLES}</style>`;
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head>${head}</head><body>${body}</body></html>`;
}

/** Escapes the few characters that matter in the `<head>` we assemble by hand. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface RenderHydratablePageOptions extends RenderPageOptions {
  /** URL of the client bundle to load (default `/assets/operate-web-client.js`). */
  readonly clientScriptSrc?: string;
}

/**
 * Server-renders a `WebPageState` to a *hydratable* HTML document: the React
 * tree (`PageRoot`) goes inside `<div id="root">…</div>` via `renderToString`
 * (which emits the hydration markers `hydrateRoot` needs to attach without a
 * mismatch), the same state is embedded as an XSS-safe inline `<script>` global
 * (`serializePageState` neutralizes any `</script>` in the data), and a deferred
 * `<script src>` loads the client bundle. The embedded state is the *exact*
 * already-redacted models + data the SSR rendered — so the client never receives
 * a field the caller couldn't see either.
 */
export function renderHydratablePage(
  state: WebPageState,
  options: RenderHydratablePageOptions = {},
): string {
  const title = options.title ?? "CrossEngin Operate";
  const lang = options.lang ?? "en";
  const clientSrc = options.clientScriptSrc ?? "/assets/operate-web-client.js";
  const body = renderToString(<PageRoot state={state} />);
  const serialized = serializePageState(state);
  const head =
    `<meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"/>` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>${BASE_STYLES}</style>`;
  const stateScript = `<script>window.${PAGE_STATE_GLOBAL} = ${serialized};</script>`;
  const clientScript = `<script src="${escapeHtml(clientSrc)}" defer></script>`;
  return (
    `<!doctype html><html lang="${escapeHtml(lang)}"><head>${head}</head>` +
    `<body><div id="root">${body}</div>${stateScript}${clientScript}</body></html>`
  );
}
