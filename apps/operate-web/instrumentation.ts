import { PROXY_LIMIT_ENV, proxyLimitsFromEnv } from "@/lib/proxy-guard";

/**
 * Runs once when the server starts, before the first request. Its one job is to validate and
 * announce the proxy's two declared limits: the route module reads them at import, so without this
 * a malformed value would surface as a 500 on the first `/api` request rather than at startup, and a
 * deployment would have no line saying which cap and timeout it is running under.
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const limits = proxyLimitsFromEnv(process.env);
  console.log(
    `[web] api proxy: request body cap ${limits.maxRequestBodyBytes.toString()} bytes ` +
      `(${PROXY_LIMIT_ENV.maxRequestBodyBytes}), upstream timeout ${limits.upstreamTimeoutMs.toString()} ms ` +
      `(${PROXY_LIMIT_ENV.upstreamTimeoutMs}); state-changing requests accepted from this origin only`,
  );
}
