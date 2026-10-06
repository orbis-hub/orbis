import { describe, expect, it } from "vitest";
import type { WSContext } from "hono/ws";
import { addClient, broadcast, broadcastPerUser, removeClient, sendToUser } from "./ws";

function fakeSocket() {
  const got: unknown[] = [];
  const ws = { send: (d: string) => got.push(JSON.parse(d)) } as unknown as WSContext;
  return { ws, got };
}

describe("websocket delivery", () => {
  it("sends personal events only to that account and per-user variants to everyone", () => {
    const owner = fakeSocket();
    const ownerPhone = fakeSocket();
    const member = fakeSocket();
    addClient(owner.ws, "u-owner");
    addClient(ownerPhone.ws, "u-owner");
    addClient(member.ws, "u-member");
    try {
      sendToUser("u-owner", { type: "notifications:changed", unread: 3 });
      expect(owner.got).toHaveLength(1);
      expect(ownerPhone.got).toHaveLength(1);
      expect(member.got).toHaveLength(0);

      broadcastPerUser((uid) => ({ type: "notifications:changed", unread: uid === "u-owner" ? 3 : 1 }));
      expect(owner.got.at(-1)).toEqual({ type: "notifications:changed", unread: 3 });
      expect(member.got.at(-1)).toEqual({ type: "notifications:changed", unread: 1 });

      broadcast({ type: "modules:changed" });
      expect(member.got.at(-1)).toEqual({ type: "modules:changed" });
    } finally {
      removeClient(owner.ws);
      removeClient(ownerPhone.ws);
      removeClient(member.ws);
    }
  });
});
