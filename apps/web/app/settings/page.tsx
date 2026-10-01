"use client";

import { Button, Chip, Field, Icon, Input, Select, useToast, Window } from "@orbis/ui";
import { useEffect, useState } from "react";
import { Shell, ThemeToggle } from "@/components/Shell";
import { getHubUrl, setHubUrl } from "@/lib/hub";
import { useAuthStatus, usePatchSettings, useSettings, type HubSettings } from "@/lib/queries";

export default function SettingsPage() {
  const settings = useSettings();
  const status = useAuthStatus();
  const patch = usePatchSettings();
  const toast = useToast();
  const [form, setForm] = useState<Partial<HubSettings>>({});
  const [registries, setRegistries] = useState("");
  const [hub, setHub] = useState("");
  useEffect(() => {
    if (settings.data) {
      setForm(settings.data);
      setRegistries(settings.data.registries.join("\n"));
    }
  }, [settings.data]);
  useEffect(() => setHub(getHubUrl() ?? ""), []);

  const s = { ...settings.data, ...form } as HubSettings;
  const save = () =>
    patch.mutate(
      { ...form, registries: registries.split(/\s+/).map((x) => x.trim()).filter(Boolean) },
      { onSuccess: () => toast("saved", "ok"), onError: (e) => toast(e.message, "bad") },
    );

  return (
    <Shell
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="sliders" size={16} style={{ color: "var(--accent)" }} /> settings
        </span>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, alignItems: "start" }}>
        <Window title="hub">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="hub name">
              <Input value={s.hubName ?? ""} onChange={(e) => setForm({ ...form, hubName: e.target.value })} />
            </Field>
            <Field label="locale" hint="date and number formatting, e.g. de-DE or en-GB">
              <Input value={s.locale ?? ""} onChange={(e) => setForm({ ...form, locale: e.target.value })} />
            </Field>
            <Field label="timezone">
              <Input value={s.timezone ?? ""} onChange={(e) => setForm({ ...form, timezone: e.target.value })} list="tz" />
              <datalist id="tz">
                {["Europe/Berlin", "Europe/London", "Europe/Vienna", "Europe/Zurich", "UTC", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"].map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Field>
            <Field label="units">
              <Select value={s.units ?? "metric"} onChange={(e) => setForm({ ...form, units: e.target.value as HubSettings["units"] })}>
                <option value="metric">metric (°C, km/h)</option>
                <option value="imperial">imperial (°F, mph)</option>
              </Select>
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button variant="primary" onClick={save} loading={patch.isPending}>
                save
              </Button>
            </div>
          </div>
        </Window>

        <Window title="location" dashed>
          <p className="soft" style={{ fontSize: 12, marginBottom: 10 }}>
            default location for weather and other location-aware modules.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="name">
              <Input value={s.location?.name ?? ""} onChange={(e) => setForm({ ...form, location: { lat: s.location?.lat ?? 0, lon: s.location?.lon ?? 0, name: e.target.value } })} placeholder="Würzburg" />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Field label="latitude">
                <Input type="number" step="any" value={s.location?.lat ?? ""} onChange={(e) => setForm({ ...form, location: { lat: Number(e.target.value), lon: s.location?.lon ?? 0, name: s.location?.name ?? "" } })} />
              </Field>
              <Field label="longitude">
                <Input type="number" step="any" value={s.location?.lon ?? ""} onChange={(e) => setForm({ ...form, location: { lat: s.location?.lat ?? 0, lon: Number(e.target.value), name: s.location?.name ?? "" } })} />
              </Field>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <Button
                size="sm"
                onClick={() =>
                  navigator.geolocation?.getCurrentPosition(
                    (p) => setForm({ ...form, location: { lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4), name: s.location?.name ?? "here" } }),
                    () => toast("location unavailable", "bad"),
                  )
                }
              >
                <Icon name="map-pin" size={12} /> use my position
              </Button>
              <Button variant="primary" onClick={save} loading={patch.isPending}>
                save
              </Button>
            </div>
          </div>
        </Window>

        <Window title="appearance">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 12 }}>theme (this device)</span>
            <ThemeToggle />
          </div>
        </Window>

        <Window title="module registries">
          <p className="soft" style={{ fontSize: 12, marginBottom: 10 }}>
            one url per line. the official registry is always included.
          </p>
          <textarea className="input" value={registries} onChange={(e) => setRegistries(e.target.value)} rows={3} placeholder="https://raw.githubusercontent.com/you/orbis-registry/main/index.json" />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <Button variant="primary" onClick={save} loading={patch.isPending}>
              save
            </Button>
          </div>
        </Window>

        <Window title="this device">
          <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Chip>hub v{status.data?.hubVersion ?? "?"}</Chip>
              <Chip>user {status.data?.user?.name}</Chip>
            </div>
            <Field label="hub url" hint="change only if your hub moved; you'll need to sign in again">
              <div style={{ display: "flex", gap: 6 }}>
                <Input value={hub} onChange={(e) => setHub(e.target.value)} />
                <Button
                  size="sm"
                  onClick={() => {
                    setHubUrl(hub || null);
                    window.location.href = "/login/";
                  }}
                >
                  apply
                </Button>
              </div>
            </Field>
          </div>
        </Window>
      </div>
    </Shell>
  );
}
