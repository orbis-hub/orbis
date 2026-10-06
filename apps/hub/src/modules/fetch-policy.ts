/**
 * Outbound fetch policy for modules (`ctx.fetch`, in-process and in worker threads).
 *
 * - only `http:` / `https:`
 * - the hostname is resolved first; loopback, link-local (incl. the 169.254.169.254 cloud metadata address), private
 *   (rfc1918, cgnat) and ula/unspecified/multicast addresses are refused unless the manifest declares `network:lan`
 * - 20 s default timeout (combined with the caller's own `signal`)
 * - at most 5 redirects, followed manually so every hop is checked against the same rules
 * - response bodies are capped (5 MB default, `init.maxBytes` up to 50 MB): a declared content-length above the cap is
 *   refused up front, otherwise the stream errors with "response too large" once the cap is passed
 *
 * `ctx.modules.call` does not go through here, so hub-internal calls keep working without `network:lan`.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ModuleManifest } from "@orbis/sdk";
import type { ModuleFetch, ModuleFetchInit } from "@orbis/sdk/server";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const HARD_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

/** Thrown for policy violations; `code` is stable for callers that want to branch, `message` is meant for users/logs. */
export class FetchPolicyError extends Error {
  constructor(
    public readonly code: "protocol" | "private-address" | "unresolvable" | "too-many-redirects" | "too-large" | "bad-url",
    message: string,
  ) {
    super(message);
    this.name = "FetchPolicyError";
  }
}

export type AddressClass = "public" | "loopback" | "link-local" | "private" | "unspecified" | "multicast" | "reserved";

/** Classify a literal ip address (v4, v6 or v4-mapped v6). Anything that is not clearly public is not "public". */
export function classifyAddress(ip: string): AddressClass {
  const v = isIP(ip);
  if (v === 4) return classifyV4(ip.split(".").map(Number));
  if (v !== 6) return "reserved";
  const words = expandV6(ip);
  if (!words) return "reserved";
  // ::ffff:a.b.c.d (ipv4-mapped) and 64:ff9b::/96 (nat64) carry an embedded ipv4 address
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff) return classifyV4(v4FromWords(words[6]!, words[7]!));
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0) return classifyV4(v4FromWords(words[6]!, words[7]!));
  if (words.every((w) => w === 0)) return "unspecified";
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return "loopback";
  if ((words[0]! & 0xffc0) === 0xfe80) return "link-local";
  if ((words[0]! & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local
  if ((words[0]! & 0xff00) === 0xff00) return "multicast";
  if (words[0] === 0x2001 && words[1] === 0x0db8) return "reserved"; // documentation
  return "public";
}

function classifyV4(o: number[]): AddressClass {
  const [a, b] = o as [number, number, number, number];
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return "reserved";
  if (a === 0) return "unspecified"; // 0.0.0.0/8 ("this host")
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local"; // includes 169.254.169.254 (cloud metadata)
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // cgnat 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return "private"; // benchmarking 198.18/15
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved"; // 240/4 incl. broadcast
  return "public";
}

function v4FromWords(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/** "::ffff:1.2.3.4" / "fe80::1" → 8 sixteen-bit words, or null when unparsable */
function expandV6(ip: string): number[] | null {
  let s = ip;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // trailing dotted ipv4
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const o = m[2]!.split(".").map(Number);
    s = `${m[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const words = [...head, ...Array(fill).fill("0"), ...tail].map((w) => parseInt(w, 16));
  if (words.length !== 8 || words.some((w) => Number.isNaN(w) || w < 0 || w > 0xffff)) return null;
  return words;
}

export const isPublicAddress = (ip: string) => classifyAddress(ip) === "public";

export type LookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export type FetchPolicyOptions = {
  /** dns resolver override (tests) */
  lookup?: LookupFn;
  /** called once per refused request / hop */
  onBlocked?: (info: { url: string; reason: string }) => void;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** underlying fetch (tests) */
  fetch?: typeof fetch;
};

/** strip the brackets `new URL().hostname` keeps around ipv6 literals */
export function hostOf(u: URL): string {
  const h = u.hostname;
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/**
 * Check one url against the policy: protocol, then every address the host resolves to. Resolves to the parsed url
 * or throws a `FetchPolicyError`. With `allowLan` only the protocol check applies.
 */
export async function checkUrl(input: string | URL, allowLan: boolean, lookup: LookupFn = defaultLookup): Promise<URL> {
  let u: URL;
  try {
    u = new URL(String(input));
  } catch {
    throw new FetchPolicyError("bad-url", `blocked: invalid url "${String(input)}"`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchPolicyError("protocol", `blocked: unsupported protocol "${u.protocol}" (only http and https)`);
  if (allowLan) return u;
  const host = hostOf(u);
  if (!host) throw new FetchPolicyError("bad-url", `blocked: invalid url "${String(input)}"`);
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else if (/^localhost(\.localdomain)?$/i.test(host) || host.endsWith(".localhost")) addresses = ["127.0.0.1"];
  else {
    try {
      addresses = await lookup(host);
    } catch (err) {
      throw new FetchPolicyError("unresolvable", `blocked: cannot resolve "${host}" (${(err as Error).message})`);
    }
    if (!addresses.length) throw new FetchPolicyError("unresolvable", `blocked: cannot resolve "${host}"`);
  }
  for (const a of addresses) {
    const cls = classifyAddress(a);
    if (cls === "public") continue;
    const what = cls === "loopback" ? "loopback address" : cls === "link-local" ? "link-local address" : cls === "private" ? "private address" : `${cls} address`;
    throw new FetchPolicyError("private-address", `blocked: ${what} ${a}${a === host ? "" : ` (${host})`} – declare the "network:lan" permission to reach local hosts`);
  }
  return u;
}

/**
 * Wrap a response so reading its body past `maxBytes` fails with "response too large". A content-length above the
 * cap is refused immediately.
 */
export function capResponse(res: Response, maxBytes: number, url: string): Response {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => undefined);
    throw new FetchPolicyError("too-large", `response too large: ${declared} bytes (limit ${maxBytes})`);
  }
  if (!res.body || res.status === 101 || res.status === 204 || res.status === 205 || res.status === 304) return res;
  let seen = 0;
  const capped = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new FetchPolicyError("too-large", `response too large: more than ${maxBytes} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  const out = new Response(capped, { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, "url", { value: url, configurable: true });
  Object.defineProperty(out, "redirected", { value: res.redirected, configurable: true });
  return out;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** `ctx.fetch` for one module: `globalThis.fetch` behind the policy described at the top of the file. */
export function createModuleFetch(manifest: Pick<ModuleManifest, "id" | "permissions">, opts: FetchPolicyOptions = {}): ModuleFetch {
  const allowLan = manifest.permissions.includes("network:lan");
  const lookup = opts.lookup ?? defaultLookup;
  const baseFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const hardMax = Math.min(opts.maxBytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES);

  return async function moduleFetch(input: string | URL | Request, init: ModuleFetchInit = {}): Promise<Response> {
    const { maxBytes: wanted, ...rest } = init;
    let url: string;
    let reqInit: RequestInit = rest;
    if (input instanceof Request) {
      url = input.url;
      reqInit = {
        method: input.method,
        headers: input.headers,
        body: input.body ? await input.arrayBuffer() : undefined,
        signal: input.signal,
        ...rest,
      };
    } else url = String(input);
    const maxBytes = wanted === undefined ? Math.min(DEFAULT_MAX_BYTES, hardMax) : Math.max(1, Math.min(Math.floor(wanted), HARD_MAX_BYTES));
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (reqInit.signal) signals.push(reqInit.signal);
    const signal = AbortSignal.any(signals);
    const redirectMode = reqInit.redirect ?? "follow";

    const blocked = (u: string, err: Error) => {
      opts.onBlocked?.({ url: u, reason: err.message });
      return err;
    };

    let current: URL;
    try {
      current = await checkUrl(url, allowLan, lookup);
    } catch (err) {
      throw blocked(url, err as Error);
    }
    let method = (reqInit.method ?? "GET").toUpperCase();
    let body = reqInit.body;
    let headers = new Headers(reqInit.headers);

    for (let hop = 0; ; hop++) {
      const res = await baseFetch(current, { ...reqInit, method, body, headers, signal, redirect: "manual" });
      const location = res.headers.get("location");
      if (!REDIRECT_STATUS.has(res.status) || !location || redirectMode === "manual") return capResponse(res, maxBytes, current.toString());
      void res.body?.cancel().catch(() => undefined);
      if (redirectMode === "error") throw new FetchPolicyError("too-many-redirects", `redirect not allowed (${res.status} → ${location})`);
      if (hop >= maxRedirects) throw new FetchPolicyError("too-many-redirects", `too many redirects (more than ${maxRedirects})`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new FetchPolicyError("bad-url", `blocked: invalid redirect location "${location}"`);
      }
      try {
        next = await checkUrl(next, allowLan, lookup);
      } catch (err) {
        throw blocked(next.toString(), err as Error);
      }
      // same rules as browsers: 303 (and 301/302 for POST) turn into a bodyless GET; 307/308 keep method and body
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers = new Headers(headers);
        headers.delete("content-type");
        headers.delete("content-length");
      } else if (body && typeof body !== "string" && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && !(body instanceof URLSearchParams) && !(body instanceof Blob) && !(body instanceof FormData)) {
        throw new FetchPolicyError("too-many-redirects", `cannot follow ${res.status} redirect with a streaming body`);
      }
      // credentials never travel to another origin
      if (next.origin !== current.origin) {
        headers = new Headers(headers);
        headers.delete("authorization");
        headers.delete("cookie");
      }
      current = next;
    }
  };
}
