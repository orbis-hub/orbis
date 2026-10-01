import type { HubEvent } from "@orbis/sdk";
import type { WSContext } from "hono/ws";
import { childLog } from "./log";

const log = childLog("ws");
const clients = new Set<WSContext>();

export function addClient(ws: WSContext) {
  clients.add(ws);
  log.debug({ clients: clients.size }, "client connected");
}

export function removeClient(ws: WSContext) {
  clients.delete(ws);
  log.debug({ clients: clients.size }, "client disconnected");
}

export function broadcast(event: HubEvent) {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    try {
      ws.send(data);
    } catch (err) {
      log.warn({ err }, "send failed, dropping client");
      clients.delete(ws);
    }
  }
}

export function clientCount() {
  return clients.size;
}
