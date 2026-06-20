// Minimal zero-dependency dev server for the CrossEngin operate-server.
//
// It does two things:
//   1. Serves index.html (the UI) at /
//   2. Proxies every other request to the operate-server API, injecting the
//      x-api-key header. Because the browser only ever talks to THIS server,
//      there are no CORS problems and the API key never leaves the machine.
//
// Run:  node web-ui/server.mjs
// Env:  PORT (default 5173)  TARGET (default http://localhost:8787)  API_KEY (default devkey)

import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = Number(process.env.PORT ?? 5173);
const TARGET = process.env.TARGET ?? "http://localhost:8787";
const API_KEY = process.env.API_KEY ?? "devkey";
const target = new URL(TARGET);
const here = dirname(fileURLToPath(import.meta.url));

const server = createServer((req, res) => {
  // Serve the single-page UI.
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    readFile(join(here, "index.html"))
      .then((html) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      })
      .catch(() => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("index.html not found next to server.mjs");
      });
    return;
  }

  // Proxy everything else to the operate-server, adding auth.
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const headers = { "x-api-key": API_KEY, accept: "application/json" };
    if (body.length > 0) {
      headers["content-type"] = req.headers["content-type"] ?? "application/json";
      headers["content-length"] = body.length;
    }

    const proxyReq = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "upstream_unreachable",
          detail: String(err),
          hint: `Is operate-server running at ${TARGET}?`,
        }),
      );
    });

    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  console.log(
    `\n  operate-web UI →  http://localhost:${PORT}\n  proxying API   →  ${TARGET}  (x-api-key: ${API_KEY})\n`,
  );
});
