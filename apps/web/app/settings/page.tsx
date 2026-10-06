"use client";

import { Button, Chip, Field, Icon, Input, Select, Textarea, useStableId, useToast, Window } from "@orbis/ui";
import { useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { Shell, ThemeToggle } from "@/components/Shell";
import { getHubUrl, setHubUrl } from "@/lib/hub";
import { LANGUAGES, useT } from "@/lib/i18n";
import { isAdminRole, useAuthStatus, useModules, useNotificationMutations, usePatchSettings, useSettings, type HubSettings } from "@/lib/queries";
import { getToken } from "@/lib/hub";

export default function SettingsPage() {
  const settings = useSettings();
  const status = useAuthStatus();
  const patch = usePatchSettings();
  const toast = useToast();
  // local edits are a patch on top of the loaded settings; nothing is copied into state when the data arrives
  const [form, setForm] = useState<Partial<HubSettings>>({});
  const [registriesEdit, setRegistriesEdit] = useState<string | null>(null);
  const [hub, setHub] = useState(() => (typeof window === "undefined" ? "" : (getHubUrl() ?? "")));
  const t = useT();
  const registriesId = useStableId("registries");
  const tzId = useStableId("tz");
  const hubId = useStableId("hub-url");

  const admin = isAdminRole(status.data?.user?.role);
  const s = { ...settings.data, ...form } as HubSettings;
  // members receive `registries: []` (or nothing at all from older hubs); only admins see and edit the list
  const registries = registriesEdit ?? settings.data?.registries?.join("\n") ?? "";
  const save = () =>
    patch.mutate(
      { ...form, ...(registriesEdit !== null ? { registries: registriesEdit.split(/\s+/).map((x) => x.trim()).filter(Boolean) } : {}) },
      {
        onSuccess: () => {
          toast(t("settings.saved"), "ok");
          setForm({});
          setRegistriesEdit(null);
        },
        onError: (e) => toast(e.message, "bad"),
      },
    );

  return (
    <Shell
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="sliders" size={16} style={{ color: "var(--accent-ink)" }} /> {t("settings.title")}
        </span>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, alignItems: "start" }}>
        {/* PATCH /api/settings is admin-only: members get the values read-only, no save button, one hint line */}
        <Window title={t("settings.hub.title")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {!admin ? <p className="soft" style={{ fontSize: "var(--fs-meta)" }}>{t("settings.readOnly")}</p> : null}
            <Field label={t("settings.hub.name")}>
              <Input value={s.hubName ?? ""} onChange={(e) => setForm({ ...form, hubName: e.target.value })} disabled={!admin} />
            </Field>
            <Field label={t("settings.hub.language")} hint={t("settings.hub.languageHint")}>
              <Select value={s.language ?? "en"} onChange={(e) => setForm({ ...form, language: e.target.value })} disabled={!admin}>
                {LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.flag} {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("settings.hub.locale")} hint={t("settings.hub.localeHint")}>
              <Input value={s.locale ?? ""} onChange={(e) => setForm({ ...form, locale: e.target.value })} disabled={!admin} />
            </Field>
            <Field label={t("settings.hub.timezone")} htmlFor={tzId}>
              <Input id={tzId} value={s.timezone ?? ""} onChange={(e) => setForm({ ...form, timezone: e.target.value })} list="tz" disabled={!admin} />
              <datalist id="tz">
                {["Europe/Berlin", "Europe/London", "Europe/Vienna", "Europe/Zurich", "UTC", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"].map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Field>
            <Field label={t("settings.hub.units")}>
              <Select value={s.units ?? "metric"} onChange={(e) => setForm({ ...form, units: e.target.value as HubSettings["units"] })} disabled={!admin}>
                <option value="metric">{t("settings.hub.units.metric")}</option>
                <option value="imperial">{t("settings.hub.units.imperial")}</option>
              </Select>
            </Field>
            {admin ? (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button variant="primary" onClick={save} loading={patch.isPending}>
                  {t("settings.save")}
                </Button>
              </div>
            ) : null}
          </div>
        </Window>

        <Window title={t("settings.location.title")} dashed>
          <p className="soft" style={{ fontSize: 12, marginBottom: 10 }}>
            {t("settings.location.intro")}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {!admin ? <p className="soft" style={{ fontSize: "var(--fs-meta)" }}>{t("settings.readOnly")}</p> : null}
            <Field label={t("settings.location.name")}>
              <Input value={s.location?.name ?? ""} onChange={(e) => setForm({ ...form, location: { lat: s.location?.lat ?? 0, lon: s.location?.lon ?? 0, name: e.target.value } })} placeholder="Würzburg" disabled={!admin} />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Field label={t("settings.location.lat")}>
                <Input type="number" step="any" value={s.location?.lat ?? ""} onChange={(e) => setForm({ ...form, location: { lat: Number(e.target.value), lon: s.location?.lon ?? 0, name: s.location?.name ?? "" } })} disabled={!admin} />
              </Field>
              <Field label={t("settings.location.lon")}>
                <Input type="number" step="any" value={s.location?.lon ?? ""} onChange={(e) => setForm({ ...form, location: { lat: s.location?.lat ?? 0, lon: Number(e.target.value), name: s.location?.name ?? "" } })} disabled={!admin} />
              </Field>
            </div>
            {admin ? (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <Button
                  size="sm"
                  onClick={() =>
                    navigator.geolocation?.getCurrentPosition(
                      (p) => setForm({ ...form, location: { lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4), name: s.location?.name ?? t("settings.location.here") } }),
                      () => toast(t("settings.location.unavailable"), "bad"),
                    )
                  }
                >
                  <Icon name="map-pin" size={12} /> {t("settings.location.useMine")}
                </Button>
                <Button variant="primary" onClick={save} loading={patch.isPending}>
                  {t("settings.save")}
                </Button>
              </div>
            ) : null}
          </div>
        </Window>

        <Window title={t("settings.appearance.title")}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 12 }}>{t("settings.appearance.theme")}</span>
            <ThemeToggle />
          </div>
        </Window>

        {admin ? (
          <Window title={t("settings.registries.title")}>
            <p className="soft" style={{ fontSize: 12, marginBottom: 10 }}>
              {t("settings.registries.intro")}
            </p>
            <Field label={t("settings.registries.label")} htmlFor={registriesId}>
              <Textarea id={registriesId} value={registries} onChange={(e) => setRegistriesEdit(e.target.value)} rows={3} placeholder="https://raw.githubusercontent.com/you/orbis-registry/main/index.json" />
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <Button variant="primary" onClick={save} loading={patch.isPending}>
                {t("settings.save")}
              </Button>
            </div>
          </Window>
        ) : null}

        {admin ? <NotifyWindow /> : null}
        {admin ? <BackupWindow /> : null}

        <Window title={t("settings.device.title")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Chip>{t("settings.device.hub", { version: status.data?.hubVersion ?? "?" })}</Chip>
              <Chip>{t("settings.device.user", { name: status.data?.user?.name ?? "" })}</Chip>
            </div>
            <Field label={t("settings.device.hubUrl")} hint={t("settings.device.hubUrlHint")} htmlFor={hubId}>
              <div style={{ display: "flex", gap: 6 }}>
                <Input id={hubId} value={hub} onChange={(e) => setHub(e.target.value)} inputMode="url" />
                <Button
                  size="sm"
                  onClick={() => {
                    setHubUrl(hub || null);
                    // full reload on purpose: a different hub means fresh module bundles, caches and websocket
                    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                    window.location.href = "/login/";
                  }}
                >
                  {t("settings.device.apply")}
                </Button>
              </div>
            </Field>
          </div>
        </Window>
      </div>
    </Shell>
  );
}

function BackupWindow() {
  const toast = useToast();
  const t = useT();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const hub = getHubUrl() ?? "";
  async function download() {
    setBusy(true);
    try {
      const res = await fetch(`${hub}/api/backup`, { headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {}, credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const name = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "orbis-backup.tgz";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      toast(t("settings.backup.failed", { error: (err as Error).message }), "bad");
    } finally {
      setBusy(false);
    }
  }
  async function restore(file: File) {
    if (!(await confirm({ title: t("settings.backup.restore"), body: t("settings.backup.confirm", { name: file.name }), confirmLabel: t("settings.backup.restore"), danger: true }))) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${hub}/api/backup/restore`, { method: "POST", body: fd, headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {}, credentials: "include" });
      const j = (await res.json()) as { ok?: boolean; error?: string; note?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      toast(t("settings.backup.restored", { note: j.note ?? "" }), "ok");
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      toast(t("settings.backup.restoreFailed", { error: (err as Error).message }), "bad");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Window title={t("settings.backup.title")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
        <p className="soft">{t("settings.backup.intro")}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Button variant="primary" loading={busy} onClick={download}>
            <Icon name="download" size={12} /> {t("settings.backup.download")}
          </Button>
          <label className="btn" style={{ cursor: "pointer" }}>
            <Icon name="upload" size={12} /> {t("settings.backup.restore")}
            <input type="file" accept=".tgz,.tar.gz,application/gzip" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void restore(f); }} disabled={busy} />
          </label>
        </div>
        <p className="soft" style={{ fontSize: "var(--fs-meta)" }}>
          {t("settings.backup.note", { folder: "before-restore-<timestamp>/" })} <code>{`curl -H "authorization: Bearer …" ${hub}/api/backup -o backup.tgz`}</code>
        </p>
      </div>
    </Window>
  );
}

function NotifyWindow() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const modules = useModules();
  const nm = useNotificationMutations();
  const toast = useToast();
  const t = useT();
  // edits start as null = "show what the hub has"; the first keystroke forks a local copy
  const [chEdit, setCh] = useState<NonNullable<HubSettings["notifyChannels"]> | null>(null);
  const [mutedEdit, setMuted] = useState<string[] | null>(null);
  const ch = chEdit ?? settings.data?.notifyChannels ?? {};
  const muted = mutedEdit ?? settings.data?.mutedModules ?? [];
  const save = () =>
    patch.mutate(
      { notifyChannels: ch, mutedModules: muted },
      {
        onSuccess: () => {
          toast(t("settings.saved"), "ok");
          setCh(null);
          setMuted(null);
        },
        onError: (e) => toast(e.message, "bad"),
      },
    );
  const ntfy = ch.ntfy ?? { topic: "" };
  const tg = ch.telegram ?? { botToken: "", chatId: "" };
  return (
    <Window title={t("settings.notify.title")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12 }}>
        <p className="soft">{t("settings.notify.intro")}</p>
        <div className="pixel" style={{ fontSize: 12 }}>ntfy <span className="soft" style={{ fontFamily: "var(--font-mono)" }}>{t("settings.notify.ntfyHint")}</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8 }}>
          <Field label={t("settings.notify.topic")}><Input value={ntfy.topic} onChange={(e) => setCh({ ...ch, ntfy: e.target.value ? { ...ntfy, topic: e.target.value } : undefined })} placeholder={t("settings.notify.topicPlaceholder")} /></Field>
          <Field label={t("settings.notify.minLevel")}>
            <Select value={ntfy.minLevel ?? "info"} onChange={(e) => setCh({ ...ch, ntfy: { ...ntfy, minLevel: e.target.value as "info" } })} disabled={!ntfy.topic}>
              <option value="info">{t("settings.notify.level.info")}</option><option value="warning">{t("settings.notify.level.warning")}</option><option value="urgent">{t("settings.notify.level.urgent")}</option>
            </Select>
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8 }}>
          <Field label={t("settings.notify.server")}><Input value={ntfy.server ?? ""} onChange={(e) => setCh({ ...ch, ntfy: { ...ntfy, server: e.target.value || undefined } })} placeholder="https://ntfy.sh" disabled={!ntfy.topic} /></Field>
          <Field label={t("settings.notify.token")}><Input type="password" value={ntfy.token ?? ""} onChange={(e) => setCh({ ...ch, ntfy: { ...ntfy, token: e.target.value || undefined } })} disabled={!ntfy.topic} autoComplete="off" /></Field>
        </div>
        <div className="pixel" style={{ fontSize: 12 }}>telegram <span className="soft" style={{ fontFamily: "var(--font-mono)" }}>{t("settings.notify.telegramHint")}</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
          <Field label={t("settings.notify.botToken")}><Input type="password" value={tg.botToken} onChange={(e) => setCh({ ...ch, telegram: e.target.value ? { ...tg, botToken: e.target.value } : undefined })} autoComplete="off" /></Field>
          <Field label={t("settings.notify.chatId")}><Input value={tg.chatId} onChange={(e) => setCh({ ...ch, telegram: { ...tg, chatId: e.target.value } })} disabled={!tg.botToken} /></Field>
          <Field label={t("settings.notify.minLevel")}>
            <Select value={tg.minLevel ?? "info"} onChange={(e) => setCh({ ...ch, telegram: { ...tg, minLevel: e.target.value as "info" } })} disabled={!tg.botToken}>
              <option value="info">{t("settings.notify.level.info")}</option><option value="warning">{t("settings.notify.level.warning")}</option><option value="urgent">{t("settings.notify.level.urgent")}</option>
            </Select>
          </Field>
        </div>
        <Field label={t("settings.notify.muted")} hint={t("settings.notify.mutedHint")}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(modules.data ?? []).map((mod) => (
              <label key={mod.id} className="check" style={{ fontSize: 12 }}>
                <input type="checkbox" checked={muted.includes(mod.id)} onChange={(e) => setMuted(e.target.checked ? [...muted, mod.id] : muted.filter((x) => x !== mod.id))} />
                <i aria-hidden />
                <span>{mod.manifest.name}</span>
              </label>
            ))}
          </div>
        </Field>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <Button size="sm" onClick={() => nm.test.mutate(undefined, { onSuccess: () => toast(t("settings.notify.testSent"), "ok"), onError: (e) => toast(e.message, "bad") })} loading={nm.test.isPending}>
            <Icon name="bell-ring" size={12} /> {t("settings.notify.test")}
          </Button>
          <Button variant="primary" onClick={save} loading={patch.isPending}>{t("settings.save")}</Button>
        </div>
        <p className="soft" style={{ fontSize: "var(--fs-meta)" }}>{t("settings.notify.webpush")}</p>
      </div>
    </Window>
  );
}
