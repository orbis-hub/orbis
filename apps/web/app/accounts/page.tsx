"use client";

import { Button, Chip, Empty, Field, Icon, Input, Menu, Modal, Select, Switch, useToast, Window } from "@orbis/ui";
import { useState, type FormEvent } from "react";
import { Shell } from "@/components/Shell";
import { setToken } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import { isAdminRole, useAuthStatus, useUserMutations, useUsers, type PublicUser, type Role } from "@/lib/queries";

export default function AccountsPage() {
  const t = useT();
  const status = useAuthStatus();
  const me = status.data?.user;
  const admin = isAdminRole(me?.role);
  return (
    <Shell
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="users" size={16} style={{ color: "var(--accent)" }} /> {t("accounts.title")}
        </span>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: admin ? "minmax(0, 2fr) minmax(280px, 1fr)" : "minmax(0, 1fr)", gap: 14, alignItems: "start" }} className="accounts-grid">
        <style>{`@media (max-width: 900px) { .accounts-grid { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
        {admin ? <UserManager meId={me?.id ?? ""} meRole={(me?.role ?? "member") as Role} /> : null}
        <Profile />
      </div>
    </Shell>
  );
}

/* ---------- own profile ---------- */

function Profile() {
  const t = useT();
  const status = useAuthStatus();
  const m = useUserMutations();
  const toast = useToast();
  const me = status.data?.user;
  const [name, setName] = useState<string | null>(null);
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");

  async function changePw(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return toast(t("accounts.pwMismatch"), "bad");
    m.changePassword.mutate(
      { current: cur, password: pw },
      {
        onSuccess: () => {
          toast(t("accounts.pwChanged"), "ok");
          setToken(null);
          setTimeout(() => (window.location.href = "/login/"), 800);
        },
        onError: (err) => toast(err.message, "bad"),
      },
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Window title={t("accounts.you")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Icon name="avatar-circle" size={28} style={{ color: "var(--accent)" }} />
            <div>
              <div className="pixel" style={{ fontSize: 15 }}>{me?.name}</div>
              <RoleChip role={me?.role as Role} />
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name && name !== me?.name) m.updateMe.mutate({ name }, { onSuccess: () => toast(t("accounts.nameChanged"), "ok"), onError: (err) => toast(err.message, "bad") });
            }}
            style={{ display: "flex", gap: 6, alignItems: "flex-end" }}
          >
            <Field label={t("accounts.displayName")} className="flex-1" htmlFor="me-name">
              <Input id="me-name" value={name ?? me?.name ?? ""} onChange={(e) => setName(e.target.value)} maxLength={64} />
            </Field>
            <Button type="submit" size="sm" loading={m.updateMe.isPending} disabled={!name || name === me?.name}>
              {t("common.save")}
            </Button>
          </form>
        </div>
      </Window>
      <Window title={t("accounts.changePassword")}>
        <form onSubmit={changePw} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label={t("accounts.currentPassword")}>
            <Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
          </Field>
          <Field label={t("accounts.newPassword")} hint={t("accounts.newPasswordHint")}>
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required minLength={6} />
          </Field>
          <Field label={t("accounts.repeatPassword")}>
            <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required minLength={6} />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button type="submit" variant="primary" loading={m.changePassword.isPending}>
              {t("accounts.change")}
            </Button>
          </div>
        </form>
      </Window>
    </div>
  );
}

/* ---------- admin: manage users ---------- */

function RoleChip({ role }: { role: Role | undefined }) {
  const t = useT();
  return <Chip tone={role === "owner" ? "accent" : role === "admin" ? "ok" : undefined} style={{ fontSize: 10 }}>{role ? t(`accounts.role.${role}`) : "?"}</Chip>;
}

function UserManager({ meId, meRole }: { meId: string; meRole: Role }) {
  const t = useT();
  const users = useUsers();
  const m = useUserMutations();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<PublicUser | null>(null);
  const isOwner = meRole === "owner";
  const err = (e: Error) => toast(e.message, "bad");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Window
        title={<span>{t("accounts.users")} <Chip style={{ fontSize: 10 }}>{users.data?.length ?? 0}</Chip></span>}
        right={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Icon name="user-plus" size={12} /> {t("accounts.newUser")}
          </Button>
        }
        tight
      >
        {users.isPending ? null : !users.data?.length ? (
          <Empty icon="users" title={t("accounts.noUsers")} />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr className="pixel" style={{ fontSize: 11, color: "var(--ink-soft)", textAlign: "left" }}>
                <th style={th}>{t("accounts.col.user")}</th>
                <th style={th}>{t("accounts.col.role")}</th>
                <th style={th}>{t("accounts.col.active")}</th>
                <th style={th}>{t("accounts.col.sessions")}</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => {
                const isMe = u.id === meId;
                const locked = u.role === "owner" || (u.role === "admin" && !isOwner && !isMe);
                return (
                  <tr key={u.id} style={{ opacity: u.disabled ? 0.55 : 1 }}>
                    <td style={td}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Icon name="avatar-circle" size={18} style={{ color: u.role === "owner" ? "var(--accent)" : "var(--ink-soft)" }} />
                        <div>
                          <div>{u.name}{isMe ? <span className="soft"> {t("common.you")}</span> : null}</div>
                          <div className="soft" style={{ fontSize: 10 }}>{t("accounts.since", { date: new Date(u.createdAt).toLocaleDateString() })}</div>
                        </div>
                      </div>
                    </td>
                    <td style={td}>
                      {u.role === "owner" ? (
                        <RoleChip role="owner" />
                      ) : (
                        <Select value={u.role} disabled={locked || (isMe && !isOwner)} onChange={(e) => m.update.mutate({ id: u.id, role: e.target.value as Role }, { onError: err })} style={{ padding: "2px 24px 2px 6px", fontSize: 11, minWidth: 100 }}>
                          <option value="member">{t("accounts.role.member")}</option>
                          <option value="admin" disabled={!isOwner}>{t("accounts.role.admin")}</option>
                        </Select>
                      )}
                    </td>
                    <td style={td}>
                      <Switch checked={!u.disabled} disabled={locked || isMe} onChange={(e) => m.update.mutate({ id: u.id, disabled: !e.target.checked }, { onError: err })} aria-label={t("accounts.col.active")} />
                    </td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{u.sessions}</td>
                    <td style={{ ...td, width: 30 }}>
                      <Menu
                        trigger={<Button icon size="sm" variant="ghost" aria-label={t("accounts.userMenu")}><Icon name="more-vertical" size={12} /></Button>}
                        items={[
                          { label: t("common.rename"), icon: "edit", disabled: locked && !isMe, onSelect: () => { const name = prompt(t("accounts.newNamePrompt"), u.name); if (name && name !== u.name) m.update.mutate({ id: u.id, name }, { onError: err }); } },
                          { label: t("accounts.resetPassword"), icon: "key", disabled: (u.role === "owner" && !isOwner) || (u.role === "admin" && !isOwner && !isMe), onSelect: () => setResetFor(u) },
                          { label: t("accounts.signOutEverywhere"), icon: "power", disabled: u.sessions === 0, onSelect: () => m.logoutAll.mutate(u.id, { onSuccess: () => toast(t("accounts.signedOut", { name: u.name }), "ok"), onError: err }) },
                          { sep: true, label: "" },
                          { label: t("accounts.deleteUser"), icon: "trash", danger: true, disabled: u.role === "owner" || isMe || locked, onSelect: () => { if (confirm(t("accounts.deleteConfirm", { name: u.name }))) m.remove.mutate(u.id, { onError: err }); } },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Window>
      <div className="soft" style={{ fontSize: 11, lineHeight: 1.7 }}>
        <b className="pixel">{t("accounts.roles.title")}</b> · <b>{t("accounts.role.owner")}</b>: {t("accounts.roles.owner")} · <b>{t("accounts.role.admin")}</b>: {t("accounts.roles.admin")} ·{" "}
        <b>{t("accounts.role.member")}</b>: {t("accounts.roles.member")}
      </div>

      <CreateUserModal open={creating} onClose={() => setCreating(false)} isOwner={isOwner} />
      <ResetPasswordModal user={resetFor} onClose={() => setResetFor(null)} />
    </div>
  );
}

const th: React.CSSProperties = { padding: "6px 10px", borderBottom: "1.5px solid var(--line)", background: "var(--paper-2)", fontWeight: 400 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: "1px dashed var(--line)", verticalAlign: "middle" };

function CreateUserModal({ open, onClose, isOwner }: { open: boolean; onClose: () => void; isOwner: boolean }) {
  const t = useT();
  const m = useUserMutations();
  const toast = useToast();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  return (
    <Modal open={open} onClose={onClose} title={t("accounts.newUser")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.create.mutate(
            { name: name.trim(), password, role },
            {
              onSuccess: (u) => {
                toast(t("accounts.created", { name: u.name }), "ok");
                setName("");
                setPassword("");
                setRole("member");
                onClose();
              },
              onError: (err) => toast(err.message, "bad"),
            },
          );
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <Field label={t("common.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} autoFocus autoComplete="off" />
        </Field>
        <Field label={t("accounts.initialPassword")} hint={t("accounts.initialPasswordHint")}>
          <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete="off" />
        </Field>
        <Field label={t("accounts.col.role")}>
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">{t("accounts.role.member")}</option>
            <option value="admin" disabled={!isOwner}>{t("accounts.role.admin")}{!isOwner ? ` ${t("accounts.ownerOnly")}` : ""}</option>
          </Select>
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={m.create.isPending}>{t("common.create")}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: PublicUser | null; onClose: () => void }) {
  const t = useT();
  const m = useUserMutations();
  const toast = useToast();
  const [password, setPassword] = useState("");
  if (!user) return null;
  return (
    <Modal open onClose={onClose} title={t("accounts.resetTitle", { name: user.name })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.resetPassword.mutate({ id: user.id, password }, { onSuccess: () => { toast(t("accounts.resetDone"), "ok"); setPassword(""); onClose(); }, onError: (err) => toast(err.message, "bad") });
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <Field label={t("accounts.newPassword")} hint={t("accounts.min6")}>
          <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoFocus autoComplete="off" />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={m.resetPassword.isPending}>{t("accounts.reset")}</Button>
        </div>
      </form>
    </Modal>
  );
}
