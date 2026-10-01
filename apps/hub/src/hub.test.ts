import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, hashPassword, verifyPassword, type AuthUser } from "./auth";
import { closeDb, openDb } from "./db";
import { readManifest } from "./modules/installer";
import * as dash from "./services/dashboards";
import { createUserAccount, deleteUser, updateUser } from "./services/users";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "orbis-test-"));
  openDb(join(dir, "test.sqlite"));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

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
  let member: AuthUser;
  let other: AuthUser;

  it("creates the owner and further accounts", () => {
    const o = createUser("owner", "ownerpass", "owner");
    owner = { id: o.id, name: o.name, role: o.role };
    const a = createUserAccount("admin", "adminpass", "admin");
    admin = { id: a.id, name: a.name, role: a.role };
    const m = createUserAccount("member", "memberpass", "member");
    member = { id: m.id, name: m.name, role: m.role };
    const x = createUserAccount("other", "otherpass");
    other = { id: x.id, name: x.name, role: x.role };
    expect(() => createUserAccount("member", "dup", "member")).toThrow(/taken/);
    // nobody can become a second owner
    expect(createUserAccount("wannabe", "pass123", "owner").role).toBe("admin");
  });

  it("protects the owner and limits admins", () => {
    expect(() => updateUser(owner.id, { role: "member" }, owner)).toThrow(/owner/);
    expect(() => updateUser(owner.id, { disabled: true }, admin)).toThrow();
    expect(() => deleteUser(owner.id, owner)).toThrow(/owner/);
    expect(() => deleteUser(admin.id, admin)).toThrow(/yourself/);
    expect(updateUser(member.id, { disabled: true }, admin).disabled).toBe(true);
    expect(updateUser(member.id, { disabled: false }, admin).disabled).toBe(false);
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

  it("hands shared dashboards of a deleted user to the owner and drops private ones", () => {
    const keep = dash.createDashboard("Public by member", "sun", member, true);
    const drop = dash.createDashboard("Private by member", "moon", member, false);
    deleteUser(member.id, owner);
    expect(dash.getDashboard(keep.id)?.ownerId).toBe(owner.id);
    expect(dash.getDashboard(drop.id)).toBeNull();
  });
});
