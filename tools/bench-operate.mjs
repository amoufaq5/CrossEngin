import { performance } from "node:perf_hooks";

const baseUrl = (process.env.OPERATE_BENCH_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const path = process.env.OPERATE_BENCH_PATH ?? "/v1/meta/schema";
const credential = process.env.OPERATE_BENCH_CREDENTIAL;
const authMode = process.env.OPERATE_BENCH_AUTH ?? (credential?.split(".").length === 3 ? "bearer" : "api-key");
const tenant = process.env.OPERATE_BENCH_TENANT;
const concurrency = positiveInteger("OPERATE_BENCH_CONCURRENCY", 20);
const durationSeconds = positiveInteger("OPERATE_BENCH_SECONDS", 15);

if (!credential) throw new Error("Set OPERATE_BENCH_CREDENTIAL to a test API key or JWT");

const headers = { accept: "application/json" };
if (authMode === "bearer") headers.authorization = `Bearer ${credential}`;
else if (authMode === "api-key") headers["x-api-key"] = credential;
else throw new Error("OPERATE_BENCH_AUTH must be 'api-key' or 'bearer'");
if (tenant) headers["x-tenant-id"] = tenant;

const deadline = performance.now() + durationSeconds * 1000;
const latencies = [];
const statuses = new Map();
let transportErrors = 0;

await Promise.all(Array.from({ length: concurrency }, async () => {
  while (performance.now() < deadline) {
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
      await response.arrayBuffer();
      latencies.push(performance.now() - started);
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    } catch {
      transportErrors += 1;
    }
  }
}));

latencies.sort((a, b) => a - b);
const elapsedSeconds = durationSeconds;
const successful = [...statuses].filter(([status]) => status < 400).reduce((sum, [, count]) => sum + count, 0);
const report = {
  target: `${baseUrl}${path}`,
  concurrency,
  durationSeconds,
  requests: latencies.length + transportErrors,
  successful,
  requestsPerSecond: Number((latencies.length / elapsedSeconds).toFixed(2)),
  latencyMs: {
    p50: percentile(latencies, 0.50),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    max: latencies.length ? Number(latencies.at(-1).toFixed(2)) : null,
  },
  statuses: Object.fromEntries([...statuses].sort(([a], [b]) => a - b)),
  transportErrors,
};
console.log(JSON.stringify(report, null, 2));
if (transportErrors > 0 || successful !== latencies.length) process.exitCode = 1;

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1);
  return Number(values[index].toFixed(2));
}
