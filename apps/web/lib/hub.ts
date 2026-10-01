"use client";

import type { HubEvent } from "@orbis/sdk";

/**
 * Connection to the Orbis Hub. Static export + Capacitor means the web app can run on a different
 * origin than the hub, so the hub URL and a bearer token are kept in localStorage.
 * In the browser served by the hub itself, the hub URL defaults to window.location.origin.
 */

const KEY_URL = "orbis.hubUrl";
const KEY_TOKEN = "orbis.token";

function ls() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function isCapacitor() {
  return typeof window !== "undefined" && (window.location.protocol === "capacitor:" || (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true);
}

export function getHubUrl(): string | null {
  const saved = ls()?.getItem(KEY_URL);
  if (saved) return saved.replace(/\/+$/, "");
  if (typeof window === "undefined") return null;
  // dev: Next on :3000, hub on :3001
  if (window.location.port === "3000") return `${window.location.protocol}//${window.location.hostname}:3001`;
  if (isCapacitor() || window.location.protocol === "file:") return null;
  return window.location.origin;
}

export function setHubUrl(url: string | null) {
  if (url) ls()?.setItem(KEY_URL, url.replace(/\/+$/, ""));
  else ls()?.removeItem(KEY_URL);
}

export function getToken(): string | null {
  return ls()?.getItem(KEY_TOKEN) ?? null;
}

export function setToken(token: string | null) {
  if (token) ls()?.setItem(KEY_TOKEN, token);
  else ls()?.removeItem(KEY_TOKEN);
}

export class HubError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export async function hubFetch<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const base = getHubUrl();
  if (!base) throw new HubError(0, "no hub configured");
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers, body, credentials: "include" });
  } catch (err) {
    throw new HubError(0, `hub unreachable: ${(err as Error).message}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    const msg = (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string" ? (data as { error: string }).error : null) ?? `HTTP ${res.status}`;
    throw new HubError(res.status, msg, data);
  }
  return data as T;
}

/** Absolute URL for a hub path (module bundles, assets). */
export function hubAbs(path: string) {
  const base = getHubUrl() ?? "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/* ---------- websocket ---------- */

type Listener = (ev: HubEvent) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let retry = 0;
let wanted = false;
let statusListeners = new Set<(s: "open" | "closed" | "connecting") => void>();
let status: "open" | "closed" | "connecting" = "closed";

function setStatus(s: typeof status) {
  status = s;
  for (const l of statusListeners) l(s);
}

export function wsStatus() {
  return status;
}

export function onWsStatus(cb: (s: typeof status) => void) {
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

export function connectWs() {
  wanted = true;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const base = getHubUrl();
  if (!base) return;
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  const token = getToken();
  if (token) url.searchParams.set("token", token);
  setStatus("connecting");
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    setStatus("open");
  };
  ws.onmessage = (m) => {
    if (m.data === "pong") return;
    try {
      const ev = JSON.parse(String(m.data)) as HubEvent;
      for (const l of listeners) l(ev);
    } catch {
      /* ignore */
    }
  };
  ws.onclose = (ev) => {
    socket = null;
    setStatus("closed");
    if (!wanted || ev.code === 4401) return;
    const delay = Math.min(30_000, 500 * 2 ** retry++);
    setTimeout(connectWs, delay);
  };
  ws.onerror = () => ws.close();
}

export function disconnectWs() {
  wanted = false;
  socket?.close();
  socket = null;
}

export function subscribeHub(cb: Listener) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// keep-alive
if (typeof window !== "undefined") {
  setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
  }, 25_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wanted) connectWs();
  });
}
