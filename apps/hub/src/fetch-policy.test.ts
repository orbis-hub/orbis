import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capResponse, checkUrl, classifyAddress, createModuleFetch, FetchPolicyError, hostOf, type LookupFn } from "./modules/fetch-policy";

/** test resolver: *.public → a public ip, *.lan → rfc1918, *.mixed → one public + one private, anything else fails */
const lookup: LookupFn = async (host) => {
  if (host.endsWith(".public")) return ["93.184.216.34"];
  if (host.endsWith(".lan")) return ["192.168.1.20"];
  if (host.endsWith(".mixed")) return ["93.184.216.34", "10.0.0.5"];
  if (host.endsWith(".v6")) return ["2606:2800:220:1:248:1893:25c8:1946"];
  throw new Error("ENOTFOUND");
};

describe("address classification", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["::1", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["169.254.169.254", "link-local"],
    ["169.254.1.1", "link-local"],
    ["fe80::1", "link-local"],
    ["fe80::1%eth0", "link-local"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["100.64.0.1", "private"],
    ["198.18.0.1", "private"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:192.168.1.1", "private"],
    ["::ffff:7f00:1", "loopback"],
    ["64:ff9b::10.0.0.1", "private"],
    ["224.0.0.1", "multicast"],
    ["ff02::1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["2001:db8::1", "reserved"],
    ["not-an-ip", "reserved"],
    ["8.8.8.8", "public"],
    ["93.184.216.34", "public"],
    ["172.32.0.1", "public"],
    ["2606:4700::1111", "public"],
    ["::ffff:8.8.8.8", "public"],
  ])("%s → %s", (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });

  it("strips brackets from ipv6 literals in urls", () => {
    expect(hostOf(new URL("http://[::1]:3001/x"))).toBe("::1");
    expect(hostOf(new URL("http://example.com/"))).toBe("example.com");
  });
});

describe("url check", () => {
  const blocked = async (url: string, code: FetchPolicyError["code"], message: RegExp) => {
    const err = await checkUrl(url, false, lookup).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(FetchPolicyError);
    expect((err as FetchPolicyError).code).toBe(code);
    expect((err as Error).message).toMatch(message);
  };

  it("allows http(s) to public hosts and literals", async () => {
    expect((await checkUrl("https://site.public/feed.xml", false, lookup)).hostname).toBe("site.public");
    expect((await checkUrl("http://8.8.8.8/", false, lookup)).hostname).toBe("8.8.8.8");
    expect((await checkUrl("https://host.v6/", false, lookup)).hostname).toBe("host.v6");
  });

  it("refuses other protocols", async () => {
    await blocked("file:///etc/passwd", "protocol", /unsupported protocol "file:"/);
    await blocked("ftp://site.public/x", "protocol", /unsupported protocol/);
    await blocked("javascript:alert(1)", "protocol", /unsupported protocol/);
    await blocked("ws://site.public/", "protocol", /unsupported protocol/);
    await blocked("not a url", "bad-url", /invalid url/);
  });

  it("refuses loopback, link-local, metadata and private ranges", async () => {
    await blocked("http://127.0.0.1:3001/api/health", "private-address", /blocked: loopback address 127\.0\.0\.1/);
    await blocked("http://localhost:3001/api/auth/me", "private-address", /loopback address 127\.0\.0\.1 \(localhost\)/);
    await blocked("http://foo.localhost/", "private-address", /loopback/);
    await blocked("http://[::1]:3001/", "private-address", /loopback address ::1/);
    await blocked("http://169.254.169.254/latest/meta-data/", "private-address", /link-local address 169\.254\.169\.254/);
    await blocked("http://10.1.2.3/", "private-address", /private address 10\.1\.2\.3/);
    await blocked("http://192.168.178.1/", "private-address", /private address/);
    await blocked("http://[fd00::1]/", "private-address", /private address fd00::1/);
    await blocked("http://[::ffff:127.0.0.1]/", "private-address", /loopback/);
    await blocked("http://0.0.0.0:3001/", "private-address", /unspecified address/);
    await blocked("http://router.lan/", "private-address", /private address 192\.168\.1\.20 \(router\.lan\)/);
    await blocked("http://site.mixed/", "private-address", /private address 10\.0\.0\.5/);
  });

  it("mentions the permission that would allow it", async () => {
    await blocked("http://10.0.0.1/", "private-address", /network:lan/);
  });

  it("refuses unresolvable hosts", async () => {
    await blocked("http://nope.invalid/", "unresolvable", /cannot resolve "nope\.invalid"/);
  });

  it("only checks the protocol with network:lan", async () => {
    expect((await checkUrl("http://127.0.0.1:3001/", true, lookup)).port).toBe("3001");
    expect((await checkUrl("http://router.lan/", true, lookup)).hostname).toBe("router.lan");
    await expect(checkUrl("file:///x", true, lookup)).rejects.toThrow(/unsupported protocol/);
  });
});

describe("module fetch against a local server", () => {
  let server: Server;
  let port: number;
  let hits: string[] = [];
  const BIG = 64 * 1024;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const u = new URL(req.url ?? "/", "http://x");
      switch (u.pathname) {
        case "/ok":
          return res.writeHead(200, { "content-type": "text/plain" }).end("hello");
        case "/to-private":
          return res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }).end();
        case "/to-metadata":
          return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
        case "/to-public":
          return res.writeHead(301, { location: "/ok" }).end();
        case "/to-other-origin":
          return res.writeHead(302, { location: "http://other.public/echo-auth" }).end();
        case "/echo-auth":
          return res.writeHead(200).end(req.headers.authorization ?? "none");
        case "/see-other":
          return res.writeHead(303, { location: "/method" }).end();
        case "/temp":
          return res.writeHead(307, { location: "/method" }).end();
        case "/method":
          return res.writeHead(200).end(req.method);
        case "/loop":
          return res.writeHead(302, { location: "/loop" }).end();
        case "/declared-big":
          res.writeHead(200, { "content-length": String(BIG) });
          return res.end(Buffer.alloc(BIG, 97));
        case "/chunked-big": {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          let left = BIG;
          const push = () => {
            while (left > 0) {
              const n = Math.min(4096, left);
              left -= n;
              if (!res.write(Buffer.alloc(n, 98))) return void res.once("drain", push);
            }
            res.end();
          };
          return push();
        }
        case "/no-content":
          return res.writeHead(204).end();
        case "/slow":
          return void setTimeout(() => res.writeHead(200).end("late"), 1500);
        case "/secret":
          return res.writeHead(200).end("SECRET");
        default:
          return res.writeHead(404).end("nope");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  /** *.public resolves "publicly" but the actual connection goes to the local test server */
  const toLocal = (u: URL) => {
    const l = new URL(u);
    l.hostname = "127.0.0.1";
    l.port = String(port);
    return l;
  };
  const underlying: typeof fetch = (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    return fetch(u.hostname.endsWith(".public") ? toLocal(u) : u, init);
  };
  const make = (perms: string[] = ["network:fetch"], extra: Parameters<typeof createModuleFetch>[1] = {}) => {
    const blocked: string[] = [];
    const f = createModuleFetch({ id: "t", permissions: perms as never }, { lookup, fetch: underlying, onBlocked: (b) => blocked.push(b.reason), ...extra });
    return { f, blocked };
  };

  it("fetches a public url and keeps url/status", async () => {
    const { f } = make();
    const res = await f("http://site.public/ok");
    expect(res.status).toBe(200);
    expect(res.url).toBe("http://site.public/ok");
    expect(await res.text()).toBe("hello");
  });

  it("blocks a private url before any connection and reports it", async () => {
    hits = [];
    const { f, blocked } = make();
    await expect(f(`http://127.0.0.1:${port}/secret`)).rejects.toThrow(/blocked: loopback address/);
    expect(hits).toEqual([]);
    expect(blocked).toHaveLength(1);
  });

  it("allows the same url with network:lan", async () => {
    const { f } = make(["network:fetch", "network:lan"]);
    expect(await (await f(`http://127.0.0.1:${port}/secret`)).text()).toBe("SECRET");
  });

  it("re-checks every redirect hop", async () => {
    hits = [];
    const { f, blocked } = make();
    await expect(f("http://site.public/to-private")).rejects.toThrow(/blocked: loopback address 127\.0\.0\.1/);
    await expect(f("http://site.public/to-metadata")).rejects.toThrow(/link-local address 169\.254\.169\.254/);
    expect(hits).toEqual(["GET /to-private", "GET /to-metadata"]);
    expect(blocked).toHaveLength(2);
  });

  it("follows allowed redirects and limits the hop count", async () => {
    const { f } = make();
    const res = await f("http://site.public/to-public");
    expect(res.status).toBe(200);
    expect(res.url).toBe("http://site.public/ok");
    expect(res.redirected).toBe(false); // underlying fetch ran in manual mode; our wrapper is the one that followed
    await expect(f("http://site.public/loop")).rejects.toThrow(/too many redirects/);
  });

  it("turns 303 into GET, keeps the method on 307 and drops credentials across origins", async () => {
    const { f } = make();
    expect(await (await f("http://site.public/see-other", { method: "POST", body: "x" })).text()).toBe("GET");
    expect(await (await f("http://site.public/temp", { method: "POST", body: "x" })).text()).toBe("POST");
    expect(await (await f("http://site.public/to-other-origin", { headers: { authorization: "Bearer t" } })).text()).toBe("none");
    expect(await (await f("http://site.public/echo-auth", { headers: { authorization: "Bearer t" } })).text()).toBe("Bearer t");
  });

  it("honours redirect: manual and redirect: error", async () => {
    const { f } = make();
    const manual = await f("http://site.public/to-public", { redirect: "manual" });
    expect(manual.status).toBe(301);
    await expect(f("http://site.public/to-public", { redirect: "error" })).rejects.toThrow(/redirect not allowed/);
  });

  it("refuses a declared content-length above the cap", async () => {
    const { f } = make();
    await expect(f("http://site.public/declared-big", { maxBytes: 1024 })).rejects.toThrow(/response too large: 65536 bytes \(limit 1024\)/);
  });

  it("errors the body stream once the cap is passed", async () => {
    const { f } = make();
    const res = await f("http://site.public/chunked-big", { maxBytes: 10_000 });
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow(/response too large: more than 10000 bytes/);
    // under the cap everything arrives
    const ok = await f("http://site.public/chunked-big", { maxBytes: BIG });
    expect((await ok.arrayBuffer()).byteLength).toBe(BIG);
  });

  it("applies a default cap and clamps overrides to the hard maximum", async () => {
    const { f } = make(["network:fetch"], { maxBytes: 100 });
    await expect(f("http://site.public/declared-big")).rejects.toThrow(/limit 100/);
    const { f: g } = make(["network:fetch"], { maxBytes: 100 });
    await expect(g("http://site.public/declared-big", { maxBytes: 10 * 1024 * 1024 * 1024 })).resolves.toBeInstanceOf(Response);
  });

  it("passes bodyless responses through", async () => {
    const { f } = make();
    const res = await f("http://site.public/no-content");
    expect(res.status).toBe(204);
  });

  it("times out", async () => {
    const { f } = make(["network:fetch"], { timeoutMs: 200 });
    await expect(f("http://site.public/slow")).rejects.toThrow(/timeout|abort/i);
  });

  it("combines with the caller's own signal", async () => {
    const { f } = make();
    await expect(f("http://site.public/slow", { signal: AbortSignal.timeout(100) })).rejects.toThrow(/timeout|abort/i);
  });

  it("capResponse leaves small responses readable", async () => {
    const res = capResponse(new Response("abc", { status: 200, headers: { "content-type": "text/plain" } }), 10, "http://x/");
    expect(res.url).toBe("http://x/");
    expect(await res.text()).toBe("abc");
    expect(() => capResponse(new Response("abc", { headers: { "content-length": "999" } }), 10, "http://x/")).toThrow(/response too large/);
  });
});
