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

import { createTranslator, languageChain, localizeManifest, pickLanguage } from "./i18n";

describe("i18n", () => {
  const bundles = {
    en: { hello: "hello {name}", tasks: { one: "{count} task", other: "{count} tasks" }, "manifest.name": "Todo", "widget.list.name": "Todo list", only_en: "english only" },
    de: { hello: "hallo {name}", tasks: { one: "{count} aufgabe", other: "{count} aufgaben" }, "manifest.name": "Aufgaben", "widget.list.name": "Aufgabenliste" },
  };
  it("builds the fallback chain", () => {
    expect(languageChain("de-AT")).toEqual(["de-AT", "de", "en"]);
    expect(languageChain("en")).toEqual(["en"]);
    expect(languageChain("")).toEqual(["en"]);
    expect(pickLanguage("de-CH", ["en", "de"])).toBe("de");
    expect(pickLanguage("fr", ["en", "de"])).toBe("en");
  });
  it("translates with placeholders, plurals and fallbacks", () => {
    const t = createTranslator("de", bundles);
    expect(t("hello", { name: "mia" })).toBe("hallo mia");
    expect(t("tasks", { count: 1 })).toBe("1 aufgabe");
    expect(t("tasks", { count: 3 })).toBe("3 aufgaben");
    expect(t("only_en")).toBe("english only");
    expect(t("missing.key")).toBe("missing.key");
    expect(t.language).toBe("de");
  });
  it("localizes manifest names", () => {
    const m = { name: "Todo", description: "x", widgets: [{ id: "list", name: "Todo list" }, { id: "today", name: "Due today" }], pages: [{ id: "tasks", name: "Tasks" }] };
    const de = localizeManifest(m, createTranslator("de", bundles));
    expect(de.name).toBe("Aufgaben");
    expect(de.widgets?.[0]?.name).toBe("Aufgabenliste");
    expect(de.widgets?.[1]?.name).toBe("Due today");
    expect(de.pages?.[0]?.name).toBe("Tasks");
    expect(de.description).toBe("x");
  });
});
