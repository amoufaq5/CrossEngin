import { createServer } from "node:http";
import { connect } from "node:net";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_HTTP_LISTENER_SETTINGS,
  HTTP_LISTENER_SETTING_SPECS,
  applyHttpListenerSettings,
  connectionsCheckingIntervalFor,
  closeListener,
  formatHttpListenerSettings,
  httpListenerSettingForFlag,
  parseHttpListenerSetting,
  resolveHttpListenerSettings,
} from "./http-listener.js";

describe("listener settings", () => {
  it("keeps Node's head and request timeouts and outlasts Caddy's 2-minute upstream idle", () => {
    const node = createServer();
    expect(DEFAULT_HTTP_LISTENER_SETTINGS.headersTimeoutMs).toBe(node.headersTimeout);
    expect(DEFAULT_HTTP_LISTENER_SETTINGS.requestTimeoutMs).toBe(node.requestTimeout);
    expect(DEFAULT_HTTP_LISTENER_SETTINGS.keepAliveTimeoutMs).toBeGreaterThan(120_000);
    // The one Node leaves unbounded.
    expect(node.maxConnections).toBeUndefined();
    expect(DEFAULT_HTTP_LISTENER_SETTINGS.maxConnections).toBe(4_096);
    // Inside Docker's 10 s stop timeout, with room for the drains and the pool close.
    expect(DEFAULT_HTTP_LISTENER_SETTINGS.shutdownGraceMs).toBeLessThan(10_000);
  });

  it("maps every flag back to its key and refuses an unknown one", () => {
    for (const [key, spec] of Object.entries(HTTP_LISTENER_SETTING_SPECS)) {
      expect(httpListenerSettingForFlag(spec.flag)).toBe(key);
    }
    expect(httpListenerSettingForFlag("--http-nope")).toBeUndefined();
  });

  it.each([
    ["maxConnections", "0"],
    ["maxConnections", "1.5"],
    ["keepAliveTimeoutMs", "999"],
    ["shutdownGraceMs", "-1"],
    ["requestTimeoutMs", "abc"],
  ] as const)("refuses %s=%s rather than clamping it", (key, raw) => {
    expect(() => parseHttpListenerSetting(key, raw)).toThrow(HTTP_LISTENER_SETTING_SPECS[key].flag);
  });

  it("accepts an in-range value and a zero grace", () => {
    expect(parseHttpListenerSetting("maxConnections", "100")).toBe(100);
    expect(parseHttpListenerSetting("shutdownGraceMs", "0")).toBe(0);
  });

  it("refuses a headers timeout longer than the request timeout, which Node would accept", () => {
    expect(() => resolveHttpListenerSettings({ headersTimeoutMs: 90_000, requestTimeoutMs: 60_000 })).toThrow(
      /must not exceed/,
    );
    expect(resolveHttpListenerSettings({ requestTimeoutMs: 60_000 }).requestTimeoutMs).toBe(60_000);
  });

  it("applies the four bounds to a real server and names all five at boot", () => {
    const server = createServer();
    applyHttpListenerSettings(server, DEFAULT_HTTP_LISTENER_SETTINGS);
    expect(server.keepAliveTimeout).toBe(125_000);
    expect(server.maxConnections).toBe(4_096);
    const line = formatHttpListenerSettings(DEFAULT_HTTP_LISTENER_SETTINGS);
    for (const fragment of ["headers 60000", "request 300000", "keep-alive 125000", "max 4096", "grace 8000"]) {
      expect(line).toContain(fragment);
    }
  });
});

describe("connectionsCheckingIntervalFor", () => {
  it("keeps Node's 30 s sweep for the defaults and halves a short timeout", () => {
    expect(connectionsCheckingIntervalFor(DEFAULT_HTTP_LISTENER_SETTINGS)).toBe(30_000);
    expect(connectionsCheckingIntervalFor({ ...DEFAULT_HTTP_LISTENER_SETTINGS, headersTimeoutMs: 2_000 })).toBe(1_000);
    expect(connectionsCheckingIntervalFor({ ...DEFAULT_HTTP_LISTENER_SETTINGS, headersTimeoutMs: 1_000 })).toBe(1_000);
  });

  it("answers a stalled header within the timeout plus the sweep, not after Node's 30 s", async () => {
    // Measured live before this: a 2 s headers timeout answered a slowloris 408 after 26.2 s.
    const server = createServer((_req, res) => res.end("ok"));
    applyHttpListenerSettings(server, {
      ...DEFAULT_HTTP_LISTENER_SETTINGS,
      headersTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const started = performance.now();
    const answer = await new Promise<string>((resolve) => {
      const sock = connect(port, "127.0.0.1", () => sock.write("GET / HTTP/1.1\r\nHost: x\r\n"));
      let got = "";
      sock.on("data", (d: Buffer) => (got += d.toString()));
      sock.on("close", () => resolve(got));
      sock.on("error", () => resolve(got));
    });
    const elapsed = performance.now() - started;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(answer).toContain("408");
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);
});

describe("closeListener", () => {
  it("lets a running request finish, closes idle keep-alive sockets, and reports drained", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = createServer((req, res) => {
      if (req.url === "/slow") {
        void held.then(() => res.end("done"));
      } else {
        res.end("ok");
      }
    });
    applyHttpListenerSettings(server, DEFAULT_HTTP_LISTENER_SETTINGS);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    // An idle keep-alive socket, which `server.close()` alone would wait on for 125 s.
    const idle = await fetch(`http://127.0.0.1:${String(port)}/`, { keepalive: true });
    expect(await idle.text()).toBe("ok");
    const slow = fetch(`http://127.0.0.1:${String(port)}/slow`).then((r) => r.text());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closed = closeListener(server, 5_000);
    setTimeout(release, 50);
    expect(await slow).toBe("done");
    expect(await closed).toBe("drained");
  });

  it("closes a request still running at the grace and reports it", async () => {
    const server = createServer(() => {
      // Never answers.
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    socket.write("GET /hang HTTP/1.1\r\nHost: x\r\n\r\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const ended = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    expect(await closeListener(server, 50)).toBe("grace_elapsed");
    await ended;
  });
});
