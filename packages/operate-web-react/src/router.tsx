import { useEffect, useState, type JSX } from "react";

import { PageRoot, type ListPageFetcher } from "./page.js";
import {
  fetchPageState,
  isInternalAppHref,
  type PageStateFetcher,
  type WebPageState,
  type WriteFetcher,
} from "./page-state.js";

export interface AppRouterProps {
  /** The SSR'd page's state — the router hydrates against it, then swaps on navigation. */
  readonly initial: WebPageState;
  /** Test seams (default to the global fetch + browser history). */
  readonly pageFetcher?: PageStateFetcher;
  readonly writeFetcher?: WriteFetcher;
  readonly listFetcher?: ListPageFetcher;
}

/**
 * The single-page-app router: it renders the *same* `PageRoot` the SSR did
 * (so `hydrateRoot` attaches cleanly), then turns same-origin `/app/...`
 * navigation into in-page state swaps — no full reload. It intercepts clicks on
 * internal `/app` links and `popstate` (Back/Forward), fetches the target page's
 * `WebPageState` via its `?__state=1` JSON (the server reuses the exact compile +
 * redaction), and replaces the rendered page. Write redirects flow through the
 * same `navigate` (threaded as `PageRoot.onNavigate`), so create/edit/delete/
 * transition all land on the next page without a reload.
 *
 * All browser interaction (document listeners, `history`, `fetch`) happens in an
 * effect / handler, never during SSR — so the server renders just `PageRoot`.
 */
export function AppRouter({ initial, pageFetcher, writeFetcher, listFetcher }: AppRouterProps): JSX.Element {
  const [state, setState] = useState<WebPageState>(initial);

  async function navigate(href: string, push: boolean): Promise<void> {
    const next = await fetchPageState(href, pageFetcher);
    setState(next);
    if (push && typeof window !== "undefined") {
      window.history.pushState(null, "", href);
    }
  }

  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest("a");
      if (anchor === null || anchor === undefined) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (href === null || !isInternalAppHref(href, window.location.origin)) return;
      event.preventDefault();
      void navigate(href, true);
    };
    const onPopState = (): void => {
      void navigate(window.location.pathname + window.location.search, false);
    };
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPopState);
    };
    // The handlers close over `navigate` (stable enough — `pageFetcher` doesn't
    // change), so the effect runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PageRoot
      state={state}
      onNavigate={(href) => void navigate(href, true)}
      {...(writeFetcher !== undefined ? { writeFetcher } : {})}
      {...(listFetcher !== undefined ? { fetcher: listFetcher } : {})}
    />
  );
}
