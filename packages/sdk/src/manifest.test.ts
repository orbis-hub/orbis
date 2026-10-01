import { describe, expect, it } from "vitest";
import { parseManifest, safeParseManifest } from "./manifest";

describe("manifest", () => {
  it("fills defaults", () => {
    const m = parseManifest({ id: "clock", name: "Clock", version: "0.1.0", entry: { client: "dist/client.js" } });
    expect(m.widgets).toEqual([]);
    expect(m.permissions).toEqual([]);
    expect(m.minHub).toBe("0.1.0");
  });
  it("rejects bad ids", () => {
    expect(safeParseManifest({ id: "Bad Id", name: "x", version: "1.0.0", entry: {} }).success).toBe(false);
  });
  it("validates widget sizes", () => {
    const r = safeParseManifest({
      id: "w", name: "w", version: "1.0.0", entry: {},
      widgets: [{ id: "a", name: "A", defaultSize: { w: 13, h: 1 } }],
    });
    expect(r.success).toBe(false);
  });
});
