/**
 * Regression tests for qa round 1: #36 backup/restore, #40 e-ink, #41 notifications per user, #42 settings validation.
 * Everything runs against a temp data dir / sqlite file; the live hub is never touched.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, type AuthUser } from "./auth";
import { closeDb, openDb } from "./db";
import { applySettingsPatch, SettingsValidationError, validateSchema } from "./modules/settings-schema";
import { applyRestore, BadArchive, extractUpload, keepCurrentData, pruneRestoreCopies, RESTORE_COPY_PREFIX } from "./routes/backup";
import { describeIssues, isValidHost, isValidLocale, isValidTimezone, settingsPatch } from "./routes/core";
import * as dash from "./services/dashboards";
import * as eink from "./services/eink";
import * as notif from "./services/notifications";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "orbis-qa1-"));
  openDb(join(dir, "test.sqlite"));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/* ---------- #42 module settingsSchema validator ---------- */

describe("settings-schema validator (#42)", () => {
  const calendar = { type: "object", properties: { refreshMinutes: { type: "integer", minimum: 2, maximum: 240 }, name: { type: "string", minLength: 1, maxLength: 5, pattern: "^[a-z]+$" }, units: { type: "string", enum: ["metric", "imperial"] }, tags: { type: "array", items: { type: "string" } }, on: { type: "boolean" } } };

  it("accepts values that fit", () => {
    expect(validateSchema(calendar, { refreshMinutes: 10, name: "abc", units: "metric", tags: ["a"], on: true })).toEqual([]);
  });
  it("rejects wrong types, ranges, enums, patterns and item types", () => {
    const msgs = validateSchema(calendar, { refreshMinutes: "abc", name: "ABCDEFG", units: "nope", tags: [1], on: "yes" }).map((i) => `${i.path}: ${i.message}`);
    expect(msgs).toContain("refreshMinutes: expected integer, got string");
    expect(msgs.some((m) => m.startsWith("name: must be at most 5"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("name: must match"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("units: must be one of"))).toBe(true);
    expect(msgs).toContain("tags.0: expected string, got number");
    expect(msgs).toContain("on: expected boolean, got string");
    expect(validateSchema(calendar, { refreshMinutes: 1 })[0]?.message).toBe("must be >= 2");
    expect(validateSchema(calendar, { refreshMinutes: 241 })[0]?.message).toBe("must be <= 240");
    expect(validateSchema(calendar, { refreshMinutes: 2.5 })[0]?.message).toBe("expected integer, got number");
  });
  it("rejects unknown keys unless additionalProperties is true, checks required", () => {
    expect(validateSchema(calendar, { unknownKey: { deep: [1] } })).toEqual([{ path: "unknownKey", message: "unknown key" }]);
    expect(validateSchema({ ...calendar, additionalProperties: true }, { unknownKey: 1 })).toEqual([]);
    expect(validateSchema({ type: "object" }, { anything: 1 })).toEqual([]); // no properties listed → open
    expect(validateSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, {})).toEqual([{ path: "a", message: "is required" }]);
  });
  it("applies a patch: null deletes, result is validated", () => {
    const next = applySettingsPatch(calendar, { refreshMinutes: 10, name: "abc" }, { name: null, on: false });
    expect(next).toEqual({ refreshMinutes: 10, on: false });
    expect(() => applySettingsPatch(calendar, {}, { refreshMinutes: "abc", unknownKey: 1 })).toThrow(SettingsValidationError);
    try {
      applySettingsPatch(calendar, {}, { refreshMinutes: "abc", unknownKey: 1 });
    } catch (err) {
      expect((err as Error).message).toMatch(/refreshMinutes: expected integer/);
      expect((err as Error).message).toMatch(/unknownKey: unknown key/);
      expect((err as SettingsValidationError).status).toBe(400);
    }
    // stale unknown keys already in the store are dropped, unknown keys in the patch are still refused
    expect(applySettingsPatch(calendar, { refreshMinutes: 10, legacyJunk: 1 }, { on: true })).toEqual({ refreshMinutes: 10, on: true });
    expect(() => applySettingsPatch(calendar, { legacyJunk: 1 }, { legacyJunk: 2 })).toThrow(/legacyJunk: unknown key/);
    // without a schema anything goes, but null still deletes
    expect(applySettingsPatch(undefined, { a: 1, b: 2 }, { a: null, c: 3 })).toEqual({ b: 2, c: 3 });
  });
});

/* ---------- #42 hub settings + devices ---------- */

describe("hub settings validation (#42)", () => {
  const parse = (v: unknown) => settingsPatch.safeParse(v);
  const errorOf = (v: unknown) => {
    const r = parse(v);
    return r.success ? null : describeIssues(r.error);
  };

  it("locale and timezone", () => {
    expect(isValidLocale("de-DE")).toBe(true);
    expect(isValidLocale("en")).toBe(true);
    expect(isValidLocale("xx")).toBe(false);
    expect(isValidLocale("x_y")).toBe(false);
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(errorOf({ locale: "xx" })).toMatch(/locale: unknown locale/);
    expect(errorOf({ timezone: "Mars/Olympus" })).toMatch(/timezone: unknown time zone/);
    expect(parse({ locale: "de-DE", timezone: "Europe/Berlin" }).success).toBe(true);
  });
  it("registries and ntfy server must be http(s)", () => {
    expect(errorOf({ registries: ["javascript:alert(1)"] })).toMatch(/registries.0: registry must be an http\(s\) url/);
    expect(errorOf({ registries: ["file:///etc/passwd"] })).toMatch(/http\(s\)/);
    expect(parse({ registries: ["https://example.com/index.json"] }).success).toBe(true);
    expect(errorOf({ notifyChannels: { ntfy: { server: "not-a-url", topic: "t" } } })).toMatch(/notifyChannels.ntfy.server/);
    expect(parse({ notifyChannels: { ntfy: { server: "", topic: "t" } } }).success).toBe(true);
    expect(parse({ notifyChannels: { ntfy: { server: "https://ntfy.example", topic: "t" } } }).success).toBe(true);
    expect(parse({ notifyChannels: { ntfy: { topic: "" } } }).success).toBe(false);
  });
  it("location ranges", () => {
    expect(errorOf({ location: { lat: 999, lon: -999, name: "x" } })).toMatch(/location.lat/);
    expect(errorOf({ location: { lat: 999, lon: -999, name: "x" } })).toMatch(/location.lon/);
    expect(parse({ location: { lat: 49.8, lon: 9.9, name: "Würzburg" } }).success).toBe(true);
    expect(parse({ location: null }).success).toBe(true);
  });
  it("unknown keys are listed", () => {
    expect(errorOf({ unknownKey: 1, other: 2 })).toBe("unknown keys: unknownKey, other");
    expect(errorOf({ hubName: "ok", notifyChannels: { slack: {} } })).toMatch(/unknown keys in notifyChannels: slack/);
  });
  it("the old checks still hold", () => {
    expect(parse({ theme: "neon" }).success).toBe(false);
    expect(parse({ units: "furlongs" }).success).toBe(false);
    expect(parse({ hubName: "" }).success).toBe(false);
  });
});

describe("device host validation (#42)", () => {
  it("accepts ipv4, ipv6 and hostnames, rejects garbage", () => {
    for (const ok of ["192.168.1.10", "10.0.0.1", "::1", "fe80::1", "shelly-kitchen", "printer.local", "nas.home.example.com"]) expect(isValidHost(ok), ok).toBe(true);
    for (const bad of ["not an ip", "999.999.999.999", "<script>alert(1)</script>", "-bad.host", "a..b", "", "host_name", "x".repeat(300)]) expect(isValidHost(bad), bad).toBe(false);
  });
});

/* ---------- #41 notifications per user ---------- */

describe("notifications per user (#41)", () => {
  let owner: AuthUser;
  let mia: AuthUser;
  let shared: string;
  let mine: string;
  let theirs: string;

  it("delivers shared ones to everyone and private ones to one account", () => {
    const o = createUser("owner", "ownerpass", "owner");
    owner = { id: o.id, name: o.name, role: o.role };
    const m = createUser("mia", "miapass", "member");
    mia = { id: m.id, name: m.name, role: m.role };
    shared = notif.notify("hub", { title: "shared" })!.id;
    mine = notif.notify("todo", { title: "mia's task", userId: mia.id })!.id;
    theirs = notif.notify("todo", { title: "owner's task", userId: owner.id })!.id;
    expect(notif.notify("todo", { title: "nobody", userId: "ghost" })).toBeNull();

    const forMia = notif.listNotifications(mia.id).map((n) => n.id);
    expect(forMia).toContain(shared);
    expect(forMia).toContain(mine);
    expect(forMia).not.toContain(theirs);
    expect(notif.listNotifications(mia.id).find((n) => n.id === mine)?.userId).toBe(mia.id);
    expect(notif.unreadCount(mia.id)).toBe(2);
    expect(notif.unreadCount(owner.id)).toBe(2);
    expect(notif.getNotification(theirs, mia.id)).toBeNull();
  });

  it("read state is per account", () => {
    notif.markRead(mia.id, "all");
    expect(notif.unreadCount(mia.id)).toBe(0);
    expect(notif.unreadCount(owner.id)).toBe(2); // the owner's bell does not drop
    expect(notif.getNotification(shared, owner.id)?.readAt).toBeNull();
    expect(notif.getNotification(shared, mia.id)?.readAt).not.toBeNull();
    expect(notif.listNotifications(owner.id, { unreadOnly: true }).map((n) => n.id).sort()).toEqual([shared, theirs].sort());
    // marking someone else's private notification does nothing
    notif.markRead(mia.id, [theirs]);
    expect(notif.getNotification(theirs, owner.id)?.readAt).toBeNull();
  });

  it("members delete their own, dismiss shared ones, cannot touch others'; admins delete", () => {
    expect(notif.remove("nope", mia)).toBeNull();
    expect(notif.remove(theirs, mia)).toBeNull();
    expect(notif.remove(shared, mia)).toEqual({ deleted: false });
    expect(notif.getNotification(shared, owner.id)).not.toBeNull(); // still there for the owner
    expect(notif.remove(mine, mia)).toEqual({ deleted: true });
    expect(notif.getNotification(mine, mia.id)).toBeNull();
    expect(notif.remove(shared, owner)).toEqual({ deleted: true });
    expect(notif.getNotification(shared, mia.id)).toBeNull();
  });

  it("a replaced (keyed) notification is unread again for everyone; clear-read respects ownership", () => {
    const a = notif.notify("todo", { title: "due", key: "due:1" })!;
    notif.markRead(mia.id, [a.id]);
    expect(notif.unreadCount(mia.id)).toBe(0);
    const b = notif.notify("todo", { title: "due again", key: "due:1" })!;
    expect(b.id).toBe(a.id);
    expect(notif.unreadCount(mia.id)).toBe(1);
    notif.markRead(mia.id, "all");
    notif.clearRead(mia); // member: shared ones stay
    expect(notif.getNotification(a.id, owner.id)).not.toBeNull();
    notif.markRead(owner.id, "all");
    notif.clearRead(owner); // admin: shared read ones go
    expect(notif.getNotification(a.id, owner.id)).toBeNull();
  });
});

/* ---------- #40 e-ink ---------- */

describe("e-ink displays (#40)", () => {
  it("detaches a display whose dashboard was deleted and caps the board string", () => {
    const d = dash.createDashboard("Wall", "home", undefined, true);
    expect(eink.dashboardExists(d.id)).toBe(true);
    expect(eink.dashboardExists("nonexistent")).toBe(false);
    const disp = eink.createDisplay({ name: "kitchen", width: 800, height: 480, dashboardId: d.id, board: "x".repeat(2000) });
    expect(disp.dashboardId).toBe(d.id);
    expect(disp.board?.length).toBe(eink.BOARD_MAX);
    dash.deleteDashboard(d.id);
    expect(eink.getDisplay(disp.id)?.dashboardId).toBeNull();
    expect(eink.listDisplays().find((x) => x.id === disp.id)?.dashboardId).toBeNull();
    eink.touchDisplay(disp.id, { board: "lilygo-t5\u0000\u0001" + "y".repeat(100), battery: 250 });
    const after = eink.getDisplay(disp.id)!;
    expect(after.board?.startsWith("lilygo-t5y")).toBe(true);
    expect(after.board?.length).toBe(eink.BOARD_MAX);
    expect(after.battery).toBe(100);
    expect(eink.frameSize({ width: 800, height: 480, rotate: 90 })).toEqual({ W: 480, H: 800 });
    expect(eink.deleteDisplay(disp.id)).toBe(true);
    expect(eink.deleteDisplay(disp.id)).toBe(false);
  });
});

/* ---------- #36 backup / restore ---------- */

describe("backup restore (#36)", () => {
  let dataDir: string;
  let tgz: Buffer;
  const NEW_MARKER = "new-data";

  const sqliteBytes = (path: string, marker: string) => {
    const db = new Database(path);
    db.exec(`CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('${marker}')`);
    db.close();
  };
  const markerOf = (path: string) => {
    const db = new Database(path, { readonly: true });
    const v = (db.prepare("SELECT v FROM marker").get() as { v: string }).v;
    db.close();
    return v;
  };

  beforeAll(async () => {
    dataDir = join(dir, "data");
    mkdirSync(join(dataDir, "modules", "old-mod"), { recursive: true });
    mkdirSync(join(dataDir, "module-data", "old-mod"), { recursive: true });
    sqliteBytes(join(dataDir, "orbis.sqlite"), "old-data");
    writeFileSync(join(dataDir, "modules", "old-mod", "module.json"), "{}");
    writeFileSync(join(dataDir, "module-data", "old-mod", "kv.json"), "old");

    // build a backup archive the way GET /api/backup does
    const stage = await mkdtemp(join(dir, "stage-"));
    mkdirSync(join(stage, "orbis"));
    sqliteBytes(join(stage, "orbis", "orbis.sqlite"), NEW_MARKER);
    writeFileSync(join(stage, "orbis", "meta.json"), "{}");
    const modSrc = join(stage, "src");
    mkdirSync(join(modSrc, "modules", "new-mod"), { recursive: true });
    writeFileSync(join(modSrc, "modules", "new-mod", "module.json"), "{}");
    await tar.c({ cwd: modSrc, file: join(stage, "modules.tar"), portable: true }, ["modules"]);
    await tar.c({ cwd: stage, file: join(stage, "backup.tgz"), gzip: true, portable: true }, ["orbis", "modules.tar"]);
    tgz = readFileSync(join(stage, "backup.tgz"));
  });

  it("rejects garbage and archives without a database with a 400-style error", async () => {
    await expect(extractUpload(Buffer.from("this is not a tarball at all, just some bytes ".repeat(10)), await mkdtemp(join(dir, "t-")))).rejects.toThrow(BadArchive);
    await expect(extractUpload(Buffer.from("this is not a tarball"), await mkdtemp(join(dir, "t-")))).rejects.toThrow(/not an orbis backup/);
    const stage = await mkdtemp(join(dir, "t-"));
    mkdirSync(join(stage, "orbis"));
    writeFileSync(join(stage, "orbis", "orbis.sqlite"), "definitely not sqlite");
    await tar.c({ cwd: stage, file: join(stage, "bad.tgz"), gzip: true }, ["orbis"]);
    await expect(extractUpload(readFileSync(join(stage, "bad.tgz")), await mkdtemp(join(dir, "t-")))).rejects.toThrow(/not a sqlite database/);
  });

  it("keeps the OLD data before swapping in the backup and recreates the module dirs", async () => {
    const x = await extractUpload(tgz, await mkdtemp(join(dir, "t-")));
    const { previous } = await applyRestore(x, dataDir, { copyName: `${RESTORE_COPY_PREFIX}2026-01-01-00-00-01` });
    expect(previous).toBe(join(dataDir, `${RESTORE_COPY_PREFIX}2026-01-01-00-00-01`));
    // the copy is the old data, not the upload
    expect(markerOf(join(previous!, "orbis.sqlite"))).toBe("old-data");
    expect(existsSync(join(previous!, "modules", "old-mod", "module.json"))).toBe(true);
    expect(readFileSync(join(previous!, "module-data", "old-mod", "kv.json"), "utf8")).toBe("old");
    // the data dir now holds the backup
    expect(markerOf(join(dataDir, "orbis.sqlite"))).toBe(NEW_MARKER);
    expect(existsSync(join(dataDir, "modules", "new-mod", "module.json"))).toBe(true);
    expect(existsSync(join(dataDir, "modules", "old-mod"))).toBe(false);
    for (const d of ["modules", "modules-dev", "module-data"]) expect(existsSync(join(dataDir, d)), d).toBe(true);
  });

  it("keeps at most 3 copies, dropping the oldest", async () => {
    for (const n of [2, 3, 4, 5]) {
      const x = await extractUpload(tgz, await mkdtemp(join(dir, "t-")));
      await applyRestore(x, dataDir, { copyName: `${RESTORE_COPY_PREFIX}2026-01-01-00-00-0${n}` });
    }
    const copies = readdirSync(dataDir).filter((n) => n.startsWith(RESTORE_COPY_PREFIX)).sort();
    expect(copies).toEqual(["2026-01-01-00-00-03", "2026-01-01-00-00-04", "2026-01-01-00-00-05"].map((s) => RESTORE_COPY_PREFIX + s));
    expect(pruneRestoreCopies(dataDir, 1)).toEqual([`${RESTORE_COPY_PREFIX}2026-01-01-00-00-03`, `${RESTORE_COPY_PREFIX}2026-01-01-00-00-04`]);
    const empty = join(dir, "empty");
    mkdirSync(empty, { recursive: true });
    expect(keepCurrentData(empty)).toBeNull();
  });
});
