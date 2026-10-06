import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientIp, createSession, createUser, findUserByName, hashPassword, requestIsHttps, resolveToken, tokenFromRequest, verifyPassword, type AuthUser } from "./auth";
import { closeDb, openDb } from "./db";
import { readManifest } from "./modules/installer";
import { secretSettingKeys, settingsForRole, stripSecretSettings } from "./modules/secrets";
import { LOGIN_RATE_LIMIT, clearLoginFailures, loginThrottle, recordLoginFailure, resetLoginThrottle } from "./ratelimit";
import * as dash from "./services/dashboards";
import { getMemberSettings, getSettingsFor, setSetting, type HubSettings } from "./services/settings";
import { createUserAccount, deleteUser, getUser, listUsers, revokeAllSessions, updateUser } from "./services/users";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "orbis-test-"));
  openDb(join(dir, "test.sqlite"));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { status?: number }).status;
  }
};

describe("passwords", () => {
  it("hashes with a salt and verifies", () => {
    const h = hashPassword("secret-1");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(hashPassword("secret-1")).not.toBe(h);
    expect(verifyPassword("secret-1", h)).toBe(true);
    expect(verifyPassword("secret-2", h)).toBe(false);
    expect(verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("manifest reading", () => {
  it("accepts a valid module dir and rejects a broken one", () => {
    const good = join(dir, "good");
    mkdirSync(join(good, "dist"), { recursive: true });
    writeFileSync(join(good, "dist", "client.js"), "export default {}");
    writeFileSync(join(good, "module.json"), JSON.stringify({ id: "good", name: "Good", version: "1.0.0", entry: { client: "dist/client.js" } }));
    expect(readManifest(good).id).toBe("good");

    const missingEntry = join(dir, "bad1");
    mkdirSync(missingEntry, { recursive: true });
    writeFileSync(join(missingEntry, "module.json"), JSON.stringify({ id: "bad", name: "Bad", version: "1.0.0", entry: { client: "dist/nope.js" } }));
    expect(() => readManifest(missingEntry)).toThrow(/not found/);

    const futureHub = join(dir, "bad2");
    mkdirSync(futureHub, { recursive: true });
    writeFileSync(join(futureHub, "module.json"), JSON.stringify({ id: "bad2", name: "Bad", version: "1.0.0", minHub: "99.0.0", entry: {} }));
    expect(() => readManifest(futureHub)).toThrow(/needs hub/);
  });
});

describe("accounts and dashboard access", () => {
  let owner: AuthUser;
  let admin: AuthUser;
  let admin2: AuthUser;
  let member: AuthUser;
  let other: AuthUser;

  it("creates the owner and further accounts", () => {
    const o = createUser("owner", "ownerpass", "owner");
    owner = { id: o.id, name: o.name, role: o.role };
    const a = createUserAccount("admin", "adminpass", "admin");
    admin = { id: a.id, name: a.name, role: a.role };
    const a2 = createUserAccount("admin2", "adminpass", "admin");
    admin2 = { id: a2.id, name: a2.name, role: a2.role };
    const m = createUserAccount("member", "memberpass", "member");
    member = { id: m.id, name: m.name, role: m.role };
    const x = createUserAccount("other", "otherpass");
    other = { id: x.id, name: x.name, role: x.role };
    expect(status(() => createUserAccount("member", "dup", "member"))).toBe(409);
    // nobody can become a second owner: a 400, not a silent downgrade (#39)
    expect(status(() => createUserAccount("wannabe", "pass123", "owner"))).toBe(400);
    expect(listUsers().find((u) => u.name === "wannabe")).toBeUndefined();
  });

  it("treats names case-insensitively and rejects control characters (#39)", () => {
    expect(status(() => createUserAccount("Member", "pass123"))).toBe(409);
    expect(status(() => createUserAccount("  OWNER ", "pass123"))).toBe(409);
    expect(status(() => createUserAccount("bad\nname", "pass123"))).toBe(400);
    expect(status(() => createUserAccount("bad\u0000x", "pass123"))).toBe(400);
    expect(status(() => createUserAccount("zero​width", "pass123"))).toBe(400);
    expect(status(() => createUserAccount("   ", "pass123"))).toBe(400);
    expect(status(() => createUserAccount("x".repeat(65), "pass123"))).toBe(400);
    const spaced = createUserAccount("  Jane Doe  ", "pass123");
    expect(spaced.name).toBe("Jane Doe"); // trimmed
    expect(status(() => updateUser(spaced.id, { name: "jane doe" }, owner))).toBeUndefined(); // same account, case change ok
    expect(status(() => updateUser(spaced.id, { name: "MEMBER" }, owner))).toBe(409);
    expect(status(() => updateUser(spaced.id, { name: "a\tb" }, owner))).toBe(400);
    // login lookup is case-insensitive as well
    expect(findUserByName("JANE DOE")?.id).toBe(spaced.id);
    deleteUser(spaced.id, owner);
  });

  it("role matrix: rename (#39)", () => {
    // owner may rename anyone
    expect(updateUser(admin.id, { name: "admin-renamed" }, owner).name).toBe("admin-renamed");
    updateUser(admin.id, { name: "admin" }, owner);
    expect(updateUser(member.id, { name: "member-renamed" }, owner).name).toBe("member-renamed");
    updateUser(member.id, { name: "member" }, owner);
    // admin may rename members and themselves, not the owner or other admins
    expect(updateUser(member.id, { name: "member2" }, admin).name).toBe("member2");
    updateUser(member.id, { name: "member" }, admin);
    expect(updateUser(admin.id, { name: "admin-self" }, admin).name).toBe("admin-self");
    updateUser(admin.id, { name: "admin" }, admin);
    expect(status(() => updateUser(owner.id, { name: "renamed-owner" }, admin))).toBe(403);
    expect(status(() => updateUser(admin2.id, { name: "renamed-admin" }, admin))).toBe(403);
    expect(getUser(owner.id)?.name).toBe("owner");
    expect(getUser(admin2.id)?.name).toBe("admin2");
    // member may only rename themselves
    expect(updateUser(member.id, { name: "me" }, member).name).toBe("me");
    updateUser(member.id, { name: "member" }, member);
    expect(status(() => updateUser(other.id, { name: "x" }, member))).toBe(403);
    expect(status(() => updateUser(admin.id, { name: "x" }, member))).toBe(403);
    expect(status(() => updateUser(owner.id, { name: "x" }, member))).toBe(403);
    // unknown target
    expect(status(() => updateUser("nope", { name: "x" }, owner))).toBe(404);
  });

  it("role matrix: logout (#39)", () => {
    const tokenOf = (u: AuthUser) => createSession(u.id).token;
    const ownerTok = tokenOf(owner);
    const adminTok = tokenOf(admin);
    const admin2Tok = tokenOf(admin2);
    const memberTok = tokenOf(member);
    // admin cannot log out the owner or another admin
    expect(status(() => revokeAllSessions(owner.id, admin))).toBe(403);
    expect(status(() => revokeAllSessions(admin2.id, admin))).toBe(403);
    expect(resolveToken(ownerTok)?.id).toBe(owner.id);
    expect(resolveToken(admin2Tok)?.id).toBe(admin2.id);
    // admin can log out members and themselves
    revokeAllSessions(member.id, admin);
    expect(resolveToken(memberTok)).toBeNull();
    revokeAllSessions(admin.id, admin);
    expect(resolveToken(adminTok)).toBeNull();
    // member cannot log out anyone else
    expect(status(() => revokeAllSessions(other.id, member))).toBe(403);
    // owner can log out admins; unknown ids are a 404 instead of a silent 200
    revokeAllSessions(admin2.id, owner);
    expect(resolveToken(admin2Tok)).toBeNull();
    expect(status(() => revokeAllSessions("does-not-exist", owner))).toBe(404);
    revokeAllSessions(owner.id, owner);
    expect(resolveToken(ownerTok)).toBeNull();
  });

  it("protects the owner and limits admins", () => {
    expect(status(() => updateUser(owner.id, { role: "member" }, owner))).toBe(403);
    expect(status(() => updateUser(owner.id, { disabled: true }, admin))).toBe(403);
    expect(status(() => updateUser(owner.id, { disabled: true }, owner))).toBe(403);
    expect(status(() => updateUser(admin2.id, { role: "member" }, admin))).toBe(403);
    expect(status(() => updateUser(admin2.id, { disabled: true }, admin))).toBe(403);
    expect(status(() => updateUser(member.id, { role: "admin" }, admin))).toBe(403);
    expect(status(() => updateUser(member.id, { role: "owner" }, owner))).toBe(400);
    expect(status(() => deleteUser(owner.id, owner))).toBe(403);
    expect(status(() => deleteUser(admin.id, admin))).toBe(400);
    expect(status(() => deleteUser(admin2.id, admin))).toBe(403);
    expect(status(() => deleteUser("nope", owner))).toBe(404);
    expect(updateUser(member.id, { disabled: true }, admin).disabled).toBe(true);
    expect(updateUser(member.id, { disabled: false }, admin).disabled).toBe(false);
    expect(updateUser(member.id, { role: "admin" }, owner).role).toBe("admin");
    expect(updateUser(member.id, { role: "member" }, owner).role).toBe("member");
  });

  it("disabled accounts get no session through resolveToken", () => {
    const tok = createSession(other.id).token;
    expect(resolveToken(tok)?.id).toBe(other.id);
    updateUser(other.id, { disabled: true }, owner);
    expect(resolveToken(tok)).toBeNull();
    updateUser(other.id, { disabled: false }, owner);
  });

  it("shows shared dashboards to everyone and private ones only to grantees", () => {
    const shared = dash.createDashboard("Home", "home", owner, true);
    const priv = dash.createDashboard("Mine", "heart", member, false);

    const forMember = dash.listDashboards(member).map((d) => d.id);
    expect(forMember).toContain(shared.id);
    expect(forMember).toContain(priv.id);
    expect(dash.listDashboards(other).map((d) => d.id)).not.toContain(priv.id);
    expect(dash.listDashboards(admin).map((d) => d.id)).toContain(priv.id);

    dash.setAccess(priv.id, [other.id]);
    const forOther = dash.getDashboard(priv.id, other);
    expect(forOther?.canEdit).toBe(false);
    expect(dash.getDashboard(priv.id, member)?.canEdit).toBe(true);
    expect(dash.getDashboard(shared.id, member)?.canEdit).toBe(false); // created by the owner
    expect(dash.getDashboard(shared.id, admin)?.canEdit).toBe(true);
    expect(() => dash.assertEdit(priv.id, other)).toThrow(/cannot edit/);
  });

  it("scopes layout saves to the dashboard in the url (#37)", () => {
    const ownersDash = dash.createDashboard("Owner private", "lock", owner, false);
    const membersDash = dash.createDashboard("Member private", "heart", member, false);
    const w1 = dash.addWidget(ownersDash.id, { module: "clock", widget: "time", x: 0, y: 0, w: 4, h: 2, config: {} });
    const w2 = dash.addWidget(membersDash.id, { module: "clock", widget: "time", x: 0, y: 0, w: 4, h: 2, config: {} });
    // the member's dashboard may be edited, but a foreign widget id in the payload must not touch the owner's dashboard
    dash.assertEdit(membersDash.id, member);
    const changed = dash.saveLayout(membersDash.id, [
      { id: w1.id, x: 7, y: 7, w: 1, h: 1 },
      { id: w2.id, x: 2, y: 3, w: 6, h: 4 },
    ]);
    expect(changed).toBe(1);
    const untouched = dash.getDashboard(ownersDash.id, owner)!.widgets.find((w) => w.id === w1.id)!;
    expect([untouched.x, untouched.y, untouched.w, untouched.h]).toEqual([0, 0, 4, 2]);
    const moved = dash.getDashboard(membersDash.id, member)!.widgets.find((w) => w.id === w2.id)!;
    expect([moved.x, moved.y, moved.w, moved.h]).toEqual([2, 3, 6, 4]);
  });

  it("accepts an access-only patch (#37)", () => {
    const d = dash.createDashboard("Share me", "sun", member, false);
    // PATCH {access:[...]} alone: updateDashboard must be a no-op for an empty patch instead of throwing
    expect(dash.updateDashboard(d.id, {}, member)?.id).toBe(d.id);
    const after = dash.setAccess(d.id, [other.id], member);
    expect(after?.access).toEqual([other.id]);
    expect(dash.listDashboards(other).map((x) => x.id)).toContain(d.id);
  });

  it("hands shared dashboards of a deleted user to the owner and drops private ones", () => {
    const keep = dash.createDashboard("Public by member", "sun", member, true);
    const drop = dash.createDashboard("Private by member", "moon", member, false);
    deleteUser(member.id, owner);
    expect(dash.getDashboard(keep.id)?.ownerId).toBe(owner.id);
    expect(dash.getDashboard(drop.id)).toBeNull();
  });
});

describe("settings visibility (#38)", () => {
  it("hides notification tokens and registries from members", () => {
    setSetting("hubName", "QA Hub");
    setSetting("registries", ["https://example.com/index.json"]);
    setSetting("notifyChannels", { ntfy: { topic: "qa", token: "tk_FAKE" }, telegram: { botToken: "000:FAKE", chatId: "1" } });
    const member = getMemberSettings() as Record<string, unknown>;
    expect(member.hubName).toBe("QA Hub");
    expect(Object.keys(member).sort()).toEqual(["hubName", "language", "locale", "location", "registries", "theme", "timezone", "units"]);
    expect(member.notifyChannels).toBeUndefined();
    expect(member.registries).toEqual([]);
    expect(JSON.stringify(member)).not.toMatch(/FAKE|example\.com/);
    for (const role of ["member", "guest", ""]) expect((getSettingsFor(role) as Record<string, unknown>).notifyChannels).toBeUndefined();
    for (const role of ["owner", "admin"]) {
      const full = getSettingsFor(role) as HubSettings;
      expect(full.notifyChannels.ntfy?.token).toBe("tk_FAKE");
      expect(full.registries).toEqual(["https://example.com/index.json"]);
    }
  });
});

describe("module secret settings (#38)", () => {
  const manifest = {
    settingsSchema: {
      type: "object",
      properties: {
        stravaClientId: { type: "string" },
        stravaClientSecret: { type: "string", format: "secret" },
        token: { type: "string", format: "password" },
        units: { type: "string", enum: ["km", "mi"] },
      },
    },
  };
  const settings = { stravaClientId: "123", stravaClientSecret: "QA-FAKE-SECRET", token: "tk", units: "km" };

  it("finds secret keys by format and strips them for members only", () => {
    expect(secretSettingKeys(manifest).sort()).toEqual(["stravaClientSecret", "token"]);
    expect(stripSecretSettings(manifest, settings)).toEqual({ stravaClientId: "123", units: "km" });
    expect(settingsForRole(manifest, settings, "member")).toEqual({ stravaClientId: "123", units: "km" });
    expect(settingsForRole(manifest, settings, "admin")).toEqual(settings);
    expect(settingsForRole(manifest, settings, "owner")).toEqual(settings);
    expect(settings.stravaClientSecret).toBe("QA-FAKE-SECRET"); // input untouched
  });

  it("copes with modules without a schema", () => {
    expect(stripSecretSettings({}, settings)).toEqual(settings);
    expect(stripSecretSettings(null, settings)).toEqual(settings);
    expect(secretSettingKeys({ settingsSchema: { properties: { a: "nope" } } })).toEqual([]);
  });
});

describe("login rate limit (#39)", () => {
  it("blocks after the configured failures inside the window and recovers", () => {
    resetLoginThrottle();
    const t0 = 1_000_000;
    const key = "127.0.0.1|tester";
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxFailures; i++) {
      expect(loginThrottle(key, t0 + i).blocked).toBe(false);
      recordLoginFailure(key, t0 + i);
    }
    const blocked = loginThrottle(key, t0 + 100);
    expect(blocked.blocked).toBe(true);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(LOGIN_RATE_LIMIT.windowMs / 1000);
    // other ip / other name are independent
    expect(loginThrottle("10.0.0.2|tester", t0 + 100).blocked).toBe(false);
    expect(loginThrottle("127.0.0.1|mia", t0 + 100).blocked).toBe(false);
    // the window slides
    expect(loginThrottle(key, t0 + LOGIN_RATE_LIMIT.windowMs + 1).blocked).toBe(false);
    // a successful login clears it
    recordLoginFailure(key, t0 + LOGIN_RATE_LIMIT.windowMs + 2);
    clearLoginFailures(key);
    expect(loginThrottle(key, t0 + LOGIN_RATE_LIMIT.windowMs + 3).remaining).toBe(LOGIN_RATE_LIMIT.maxFailures);
    resetLoginThrottle();
  });
});

describe("request helpers (#39)", () => {
  const app = new Hono()
    .get("/plain", (c) => c.json({ token: tokenFromRequest(c) }))
    .get("/ws-like", (c) => c.json({ token: tokenFromRequest(c, { allowQuery: true }) }))
    .get("/https", (c) => c.json({ https: requestIsHttps(c) }))
    .get("/ip", (c) => c.json({ ip: clientIp(c, c.req.query("remote") ?? null) }));

  it("ignores ?token= unless the route opts in", async () => {
    expect(await (await app.request("/plain?token=abc")).json()).toEqual({ token: null });
    expect(await (await app.request("/ws-like?token=abc")).json()).toEqual({ token: "abc" });
    expect(await (await app.request("/plain?token=abc", { headers: { authorization: "Bearer hdr" } })).json()).toEqual({ token: "hdr" });
    expect(await (await app.request("/plain", { headers: { cookie: "orbis_session=ck" } })).json()).toEqual({ token: "ck" });
    // header wins over cookie, cookie over query
    expect(await (await app.request("/ws-like?token=q", { headers: { cookie: "orbis_session=ck" } })).json()).toEqual({ token: "ck" });
  });

  it("honours x-forwarded-proto for the Secure cookie flag", async () => {
    expect(await (await app.request("http://hub.local/https")).json()).toEqual({ https: false });
    expect(await (await app.request("https://hub.local/https")).json()).toEqual({ https: true });
    expect(await (await app.request("http://hub.local/https", { headers: { "x-forwarded-proto": "https" } })).json()).toEqual({ https: true });
    expect(await (await app.request("http://hub.local/https", { headers: { "x-forwarded-proto": "https, http" } })).json()).toEqual({ https: true });
    expect(await (await app.request("https://hub.local/https", { headers: { "x-forwarded-proto": "http" } })).json()).toEqual({ https: false });
  });

  it("trusts x-forwarded-for only behind a local proxy", async () => {
    expect(await (await app.request("/ip?remote=203.0.113.9", { headers: { "x-forwarded-for": "198.51.100.1" } })).json()).toEqual({ ip: "203.0.113.9" });
    expect(await (await app.request("/ip?remote=127.0.0.1", { headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" } })).json()).toEqual({ ip: "198.51.100.1" });
    expect(await (await app.request("/ip?remote=::1")).json()).toEqual({ ip: "::1" });
    expect(await (await app.request("/ip")).json()).toEqual({ ip: "unknown" });
  });
});

describe("dev cors origin check (#39)", () => {
  // mirrors the regex in index.ts: a literal 192.168.x.y host, not "192x168y1.evil.com"
  const lan = /^192\.168\.\d{1,3}\.\d{1,3}$/;
  it("only matches real lan addresses", () => {
    expect(lan.test("192.168.1.20")).toBe(true);
    expect(lan.test("192x168y1.evil.com")).toBe(false);
    expect(lan.test("192.168.1.20.evil.com")).toBe(false);
    expect(lan.test("1192.168.1.1")).toBe(false);
  });
});
