import type { HubEvent } from "@orbis/sdk";
import type { WSContext } from "hono/ws";
import { childLog } from "./log";

const log = childLog("ws");
/** connected sockets → the account they belong to */
const clients = new Map<WSContext, string>();

export function addClient(ws: WSContext, userId: string) {
  clients.set(ws, userId);
  log.debug({ clients: clients.size }, "client connected");
}

export function removeClient(ws: WSContext) {
  clients.delete(ws);
  log.debug({ clients: clients.size }, "client disconnected");
}

function send(ws: WSContext, data: string) {
  try {
    ws.send(data);
  } catch (err) {
    log.warn({ err }, "send failed, dropping client");
    clients.delete(ws);
  }
}

/** to every connected client */
export function broadcast(event: HubEvent) {
  const data = JSON.stringify(event);
  for (const ws of [...clients.keys()]) send(ws, data);
}

/** only to the sockets of one account (personal notifications must not reach other people's devices) */
export function sendToUser(userId: string, event: HubEvent) {
  const data = JSON.stringify(event);
  for (const [ws, uid] of [...clients]) if (uid === userId) send(ws, data);
}

/** a per-account variant of the same event, e.g. with that account's unread count */
export function broadcastPerUser(make: (userId: string) => HubEvent | null) {
  const cache = new Map<string, string | null>();
  for (const [ws, uid] of [...clients]) {
    if (!cache.has(uid)) {
      const ev = make(uid);
      cache.set(uid, ev ? JSON.stringify(ev) : null);
    }
    const data = cache.get(uid);
    if (data) send(ws, data);
  }
}

export function clientCount() {
  return clients.size;
}
