import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { dateKey, hexColor, idParam, intRange, isoDate, nonEmptyString, parseBody, parseQuery, z } from "./validate";

function app() {
  const h = new Hono();
  h.post("/x", async (c) => {
    const b = await parseBody(c, z.object({ name: nonEmptyString(5), n: intRange(1, 7).optional() }));
    if (!b.ok) return b.res;
    return c.json(b.data);
  });
  h.get("/q", (c) => {
    const q = parseQuery(c, z.object({ days: z.coerce.number().int().min(1).max(400).default(400) }));
    if (!q.ok) return q.res;
    return c.json(q.data);
  });
  return h;
}
const post = (body: string) => app().request("/x", { method: "POST", body, headers: { "content-type": "application/json" } });

describe("parseBody", () => {
  it("returns trimmed, typed data", async () => {
    const r = await post(JSON.stringify({ name: "  ab ", n: 3 }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ name: "ab", n: 3 });
  });
  it("400 invalid json for garbage and empty bodies", async () => {
    for (const body of ["nope", "", "{"]) {
      const r = await post(body);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid json" });
    }
  });
  it("400 invalid input with issue paths", async () => {
    const r = await post(JSON.stringify({ name: "   ", n: "7" }));
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string; issues: Array<{ path: string }> };
    expect(j.error).toBe("invalid input");
    expect(j.issues.map((i) => i.path).sort()).toEqual(["n", "name"]);
  });
  it("rejects non-object json", async () => {
    expect((await post("[]")).status).toBe(400);
    expect((await post('"str"')).status).toBe(400);
  });
});

describe("parseQuery", () => {
  it("applies defaults and bounds", async () => {
    expect(await (await app().request("/q")).json()).toEqual({ days: 400 });
    expect(await (await app().request("/q?days=30")).json()).toEqual({ days: 30 });
    expect((await app().request("/q?days=0")).status).toBe(400);
    expect((await app().request("/q?days=abc")).status).toBe(400);
  });
});

describe("schemas", () => {
  it("dateKey wants real calendar days", () => {
    expect(dateKey.safeParse("2026-10-06").success).toBe(true);
    expect(dateKey.safeParse("2026-02-30").success).toBe(false);
    expect(dateKey.safeParse("2026-10-06T00:00:00Z").success).toBe(false);
    expect(dateKey.safeParse("06.10.2026").success).toBe(false);
  });
  it("isoDate wants a zone", () => {
    expect(isoDate.safeParse("2026-10-06T08:00:00.000Z").success).toBe(true);
    expect(isoDate.safeParse("2026-10-06T08:00:00+02:00").success).toBe(true);
    expect(isoDate.safeParse("2026-10-06T08:00:00").success).toBe(false);
    expect(isoDate.safeParse("2026-10-06").success).toBe(false);
  });
  it("idParam, hexColor, intRange", () => {
    expect(idParam.safeParse("inbox").success).toBe(true);
    expect(idParam.safeParse("a/b").success).toBe(false);
    expect(hexColor.safeParse("#4fc47f").success).toBe(true);
    expect(hexColor.safeParse("#abc").success).toBe(true);
    expect(hexColor.safeParse("red").success).toBe(false);
    expect(intRange(1, 7).safeParse(7.5).success).toBe(false);
    expect(intRange(1, 7).safeParse("7").success).toBe(false);
    expect(intRange(1, 7).safeParse(8).success).toBe(false);
    expect(intRange(1, 7).safeParse(7).success).toBe(true);
  });
});
