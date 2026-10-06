import { useEffect, useMemo, useState } from "react";
import { defineClient, useModule, useModuleApi, useModuleQuery, useT, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Checkbox, Chip, Empty, Field, Icon, Input, Modal, Select, Spinner, Window, cx } from "@orbis/ui";
import type { Translator } from "@orbis/sdk/client";
import { BIN_STYLE } from "./bins";
import { BIN_TYPES, type Bin, type BinType, type GeoResult, type ManualRule, type Overview, type PickupView, type SourceKind, type SourceView } from "./types";

type City = { id: string; name: string; hasStreets: boolean; areaId: string | null };
type Street = { id: string; name: string; areaId: string };

const noon = (iso: string) => new Date(iso + "T12:00:00");
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const whenLabel = (t: Translator, locale: string, p: { daysUntil: number; date: string }) => (p.daysUntil === 0 ? t("when.today") : p.daysUntil === 1 ? t("when.tomorrow") : p.daysUntil < 7 ? t("when.inDays", { count: p.daysUntil }) : noon(p.date).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "numeric" }));
const dateLabel = (locale: string, iso: string, long = false) => noon(iso).toLocaleDateString(locale, long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric", month: "short" });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function useOverview(intervalMs?: number) {
  return useModuleQuery<Overview>("/overview", { refetchOn: ["changed"], intervalMs });
}

function BinIcon({ bin, size = 14 }: { bin: { color: string; icon: string }; size?: number }) {
  return <Icon name={bin.icon} size={size} style={{ flex: "none", color: bin.color }} />;
}

/* ================= widgets ================= */

function NextWidget({ config }: WidgetProps<{ count?: number }>) {
  const t = useT();
  const { locale } = useModule();
  const api = useModuleApi();
  const q = useOverview(30 * 60_000);
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>;
  const ov = q.data;
  const list = (ov?.upcoming ?? []).slice(0, config.count ?? 4);
  if (!ov?.sources.length) return <Empty icon="trash" title={t("widget.next.empty")}>{t("widget.next.emptyHint")}</Empty>;
  if (!list.length) return <Empty icon="trash" title={t("widget.next.nothing")} />;
  const nextDate = list[0]!.date;
  const toggle = (p: PickupView) => api("/putout", { method: "POST", json: { binId: p.binId, date: p.date, value: !p.putOut } }).then(() => q.refetch());
  return (
    <div className="scroll-y" style={{ height: "100%" }}>
      {list.map((p) => {
        const soon = p.daysUntil <= 1;
        return (
          <div key={`${p.binId}:${p.date}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px dashed var(--line)", color: soon ? "var(--accent)" : undefined, opacity: p.putOut ? 0.55 : 1 }}>
            <BinIcon bin={p.bin} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: soon ? 600 : undefined, textDecoration: p.putOut ? "line-through" : undefined }}>{p.bin.name}</div>
              <div className="soft" style={{ fontSize: 10 }}>{whenLabel(t, locale, p)} · {dateLabel(locale, p.date)}</div>
            </div>
            {p.date === nextDate ? (
              <label className="check" title={p.putOut ? t("widget.next.isOut") : t("widget.next.putOut")} style={{ fontSize: 10 }}>
                <input type="checkbox" checked={p.putOut} onChange={() => void toggle(p)} />
                <i aria-hidden />
              </label>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function WeekWidget(_p: WidgetProps) {
  const t = useT();
  const { locale } = useModule();
  const q = useOverview(30 * 60_000);
  const today = q.data?.today ?? todayIso();
  const days = useMemo(() => {
    const out: string[] = [];
    const d = noon(today);
    for (let i = 0; i < 7; i++) {
      const x = new Date(d);
      x.setDate(d.getDate() + i);
      out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`);
    }
    return out;
  }, [today]);
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>;
  if (!q.data?.sources.length) return <Empty icon="trash" title={t("widget.next.empty")}>{t("widget.next.emptyHint")}</Empty>;
  const by = new Map<string, PickupView[]>();
  for (const p of q.data.upcoming) by.set(p.date, [...(by.get(p.date) ?? []), p]);
  return (
    <div style={{ display: "flex", gap: 4, height: "100%" }}>
      {days.map((iso, i) => {
        const list = by.get(iso) ?? [];
        return (
          <div key={iso} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "4px 2px", border: `1px ${i === 0 ? "solid" : "dashed"} var(--line)`, background: list.length ? "var(--paper-2)" : undefined }}>
            <span className={cx("pixel", i !== 0 && "soft")} style={{ fontSize: 10 }}>{noon(iso).toLocaleDateString(locale, { weekday: "short" })}</span>
            <span style={{ fontSize: 13, fontWeight: list.length ? 600 : undefined }}>{Number(iso.slice(8, 10))}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3, justifyContent: "center" }}>
              {list.map((p) => (
                <span key={p.binId} title={p.bin.name} style={{ width: 10, height: 10, borderRadius: 2, background: p.bin.color, opacity: p.putOut ? 0.4 : 1 }} />
              ))}
              {!list.length ? <span className="soft" style={{ fontSize: 9 }}>–</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ================= page ================= */

function WastePage(_p: PageProps) {
  const t = useT();
  const { locale } = useModule();
  const api = useModuleApi();
  const q = useOverview();
  const [setup, setSetup] = useState(false);
  const [editBin, setEditBin] = useState<{ bin?: Bin; sourceId?: string } | null>(null);
  const ov = q.data;
  const sourceById = useMemo(() => new Map((ov?.sources ?? []).map((s) => [s.id, s] as const)), [ov]);
  const groups = useMemo(() => {
    const m = new Map<string, PickupView[]>();
    for (const p of ov?.upcoming ?? []) m.set(p.date, [...(m.get(p.date) ?? []), p]);
    return [...m.entries()];
  }, [ov]);
  const nextDate = groups[0]?.[0];
  const toggle = (p: PickupView) => api("/putout", { method: "POST", json: { binId: p.binId, date: p.date, value: !p.putOut } }).then(() => q.refetch());

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button onClick={() => setSetup(true)} variant={ov && !ov.sources.length ? "primary" : "default"}><Icon name="plus" size={12} /> {t("page.sources.add")}</Button>
        <span className="soft" style={{ fontSize: 11 }}>{t("page.hint")}</span>
      </div>

      {ov && !ov.sources.length ? <Empty icon="trash" title={t("page.sources.empty")}>{t("page.sources.emptyHint")}</Empty> : null}

      {ov?.sources.length ? (
        <Window title={t("page.section.upcoming", { days: ov.lookaheadDays })} tight>
          {!groups.length ? <div className="soft" style={{ padding: 12, fontSize: 12 }}>{t("page.upcoming.empty")}</div> : null}
          {groups.map(([date, list]) => (
            <div key={date} style={{ padding: "8px 12px", borderBottom: "1px dashed var(--line)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 4 }}>
                <span style={{ fontSize: 13, color: list[0]!.daysUntil <= 1 ? "var(--accent)" : undefined }}>{dateLabel(locale, date, true)}</span>
                <span className="soft pixel" style={{ fontSize: 10 }}>{whenLabel(t, locale, list[0]!)}</span>
              </div>
              {list.map((p) => (
                <div key={p.binId} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, padding: "2px 0", opacity: p.putOut ? 0.55 : 1 }}>
                  <BinIcon bin={p.bin} size={16} />
                  <span style={{ flex: 1, textDecoration: p.putOut ? "line-through" : undefined }}>{p.bin.name}</span>
                  {date === nextDate ? <Checkbox label={p.putOut ? t("page.upcoming.isOut") : t("page.upcoming.putOut")} checked={p.putOut} onChange={() => void toggle(p)} style={{ fontSize: 11 }} /> : null}
                </div>
              ))}
            </div>
          ))}
        </Window>
      ) : null}

      {ov?.sources.length ? (
        <Window title={t("page.section.bins")} tight>
          {!ov.bins.length ? <div className="soft" style={{ padding: 12, fontSize: 12 }}>{t("page.bins.empty")}</div> : null}
          {ov.bins.map((b) => {
            const src = sourceById.get(b.source_id);
            return (
              <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px dashed var(--line)", fontSize: 12, opacity: b.enabled ? 1 : 0.5 }}>
                <span style={{ width: 14, height: 14, borderRadius: 3, background: b.color, flex: "none" }} />
                <BinIcon bin={b} size={16} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 13 }}>{b.name}</span>
                    <Chip style={{ fontSize: 10 }}>{t(`bin.${b.type}`)}</Chip>
                    {!b.enabled ? <Chip style={{ fontSize: 10 }}>{t("page.bins.disabled")}</Chip> : null}
                  </div>
                  <div className="soft" style={{ fontSize: 11 }}>{src?.name ?? "?"}{src?.kind === "manual" ? ` · ${ruleLabel(t, locale, b.rule)}` : b.key ? ` · ${b.key}` : ""}</div>
                </div>
                <Button icon size="sm" variant="ghost" onClick={() => api(`/bins/${b.id}`, { method: "PATCH", json: { enabled: !b.enabled } }).then(() => q.refetch())} aria-label={b.enabled ? "disable" : "enable"} title={b.enabled ? t("page.bins.disable") : t("page.bins.enable")}><Icon name={b.enabled ? "eye" : "eye-off"} size={12} /></Button>
                <Button icon size="sm" variant="ghost" onClick={() => setEditBin({ bin: b })} aria-label="edit"><Icon name="sliders" size={12} /></Button>
                <Button icon size="sm" variant="ghost" onClick={() => confirm(t("page.bins.confirmDelete", { name: b.name })) && api(`/bins/${b.id}`, { method: "DELETE" }).then(() => q.refetch())} aria-label="remove"><Icon name="trash" size={12} /></Button>
              </div>
            );
          })}
        </Window>
      ) : null}

      {ov?.sources.length ? (
        <Window title={t("page.section.sources")} tight>
          {ov.sources.map((s) => (
            <SourceRow key={s.id} s={s} onChanged={() => q.refetch()} onAddBin={() => setEditBin({ sourceId: s.id })} />
          ))}
        </Window>
      ) : null}

      {setup ? <SetupModal onClose={() => setSetup(false)} onDone={(manualSourceId) => { setSetup(false); void q.refetch(); if (manualSourceId) setEditBin({ sourceId: manualSourceId }); }} /> : null}
      {editBin ? <BinModal bin={editBin.bin} sourceId={editBin.sourceId ?? editBin.bin?.source_id ?? ""} manual={sourceById.get(editBin.sourceId ?? editBin.bin?.source_id ?? "")?.kind === "manual"} onClose={() => setEditBin(null)} onSaved={() => { setEditBin(null); void q.refetch(); }} /> : null}
    </div>
  );
}

function ruleLabel(t: Translator, locale: string, json: string | null): string {
  if (!json) return "";
  try {
    const r = JSON.parse(json) as ManualRule;
    if (r.mode === "dates") return t("bin.rule.datesCount", { count: r.dates.length });
    const wd = new Date(2024, 0, 7 + r.weekday).toLocaleDateString(locale, { weekday: "long" });
    return t("bin.rule.summary", { count: r.interval, weekday: wd });
  } catch {
    return "";
  }
}

function SourceRow({ s, onChanged, onAddBin }: { s: SourceView; onChanged: () => void; onAddBin: () => void }) {
  const t = useT();
  const { locale } = useModule();
  const api = useModuleApi();
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      await api(`/sources/${s.id}/refresh`, { method: "POST" });
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const shift = s.kind === "manual" ? !!(s.config as { shiftOnHolidays?: boolean }).shiftOnHolidays : false;
  return (
    <div style={{ padding: "8px 12px", borderBottom: "1px dashed var(--line)", fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name={s.kind === "jumomind" ? "map-pin" : s.kind === "ics" ? "link" : "sliders"} size={16} style={{ flex: "none", color: s.error ? "var(--bad, #d6372f)" : "var(--ink-soft)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 13 }}>{s.name}</span>
            <Chip style={{ fontSize: 10 }}>{t(`page.sources.kind.${s.kind}`)}</Chip>
            {s.error ? <Chip tone="bad" style={{ fontSize: 10 }}>{t("page.sources.error")}</Chip> : null}
          </div>
          <div className="soft" style={{ fontSize: 11 }}>
            {t("page.sources.counts", { bins: s.binCount, pickups: s.pickupCount })}
            {s.kind !== "manual" ? ` · ${t("page.sources.lastFetched", { time: s.last_fetched ? new Date(s.last_fetched).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : t("page.sources.never") })}` : null}
            {s.kind === "ics" ? ` · ${(s.config as { url?: string }).url ?? ""}` : null}
          </div>
          {s.error ? <div style={{ fontSize: 11, color: "var(--bad, #d6372f)" }}>{s.error}</div> : null}
        </div>
        {s.kind === "manual" ? <Button size="sm" onClick={onAddBin}><Icon name="plus" size={12} /> {t("page.bins.add")}</Button> : null}
        {s.kind !== "manual" ? <Button icon size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy} aria-label="refresh" title={t("common.refresh")}>{busy ? <Spinner /> : <Icon name="reload" size={12} />}</Button> : null}
        <Button icon size="sm" variant="ghost" onClick={() => confirm(t("page.sources.confirmDelete", { name: s.name })) && api(`/sources/${s.id}`, { method: "DELETE" }).then(onChanged)} aria-label="remove"><Icon name="trash" size={12} /></Button>
      </div>
      {s.kind === "manual" ? (
        <div style={{ marginTop: 6, paddingLeft: 26 }}>
          <Checkbox label={t("page.sources.shiftHolidays")} checked={shift} onChange={(e) => api(`/sources/${s.id}`, { method: "PATCH", json: { config: { shiftOnHolidays: e.target.checked } } }).then(onChanged)} style={{ fontSize: 11 }} />
        </div>
      ) : null}
    </div>
  );
}

/* ================= setup ================= */

type Step = "choose" | "auto" | "ics" | "manual";

function SetupModal({ onClose, onDone }: { onClose: () => void; onDone: (manualSourceId?: string) => void }) {
  const t = useT();
  const [step, setStep] = useState<Step>("choose");
  const titles: Record<Step, string> = { choose: t("setup.title"), auto: t("setup.option.auto.title"), ics: t("setup.option.ics.title"), manual: t("setup.option.manual.title") };
  return (
    <Modal open onClose={onClose} title={titles[step]} width={520} right={step !== "choose" ? <Button size="sm" variant="ghost" onClick={() => setStep("choose")}><Icon name="arrow-left" size={12} /> {t("common.back")}</Button> : undefined}>
      {step === "choose" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p className="soft" style={{ fontSize: 12, margin: 0 }}>{t("setup.intro")}</p>
          {(["auto", "ics", "manual"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setStep(k)} style={{ display: "flex", gap: 12, alignItems: "center", textAlign: "left", padding: "10px 12px", border: "1px solid var(--line)", background: "var(--paper-2)", cursor: "pointer", color: "inherit", font: "inherit" }}>
              <Icon name={k === "auto" ? "map-pin" : k === "ics" ? "link" : "sliders"} size={20} style={{ flex: "none", color: "var(--accent)" }} />
              <span style={{ flex: 1 }}>
                <span style={{ display: "block", fontSize: 13 }}>{t(`setup.option.${k}.title`)}</span>
                <span className="soft" style={{ display: "block", fontSize: 11 }}>{t(`setup.option.${k}.text`)}</span>
              </span>
              <Icon name="chevron-right" size={14} />
            </button>
          ))}
        </div>
      ) : null}
      {step === "auto" ? <AutoSetup onDone={() => onDone()} onFallback={(s) => setStep(s)} /> : null}
      {step === "ics" ? <IcsSetup onDone={() => onDone()} /> : null}
      {step === "manual" ? <ManualSetup onDone={(id) => onDone(id)} /> : null}
    </Modal>
  );
}

function AutoSetup({ onDone, onFallback }: { onDone: () => void; onFallback: (s: Step) => void }) {
  const t = useT();
  const api = useModuleApi();
  const [locating, setLocating] = useState(false);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [cityQ, setCityQ] = useState("");
  const [city, setCity] = useState<City | null>(null);
  const [cities, setCities] = useState<City[]>([]);
  const [searchingCity, setSearchingCity] = useState(false);
  const [streetQ, setStreetQ] = useState("");
  const [house, setHouse] = useState("");
  const [street, setStreet] = useState<Street | null>(null);
  const [streets, setStreets] = useState<Street[]>([]);
  const [searchingStreet, setSearchingStreet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; bins: number; pickups: number; error?: string } | null>(null);
  const dCity = useDebounced(cityQ);
  const dStreet = useDebounced(streetQ);
  const dHouse = useDebounced(house);

  useEffect(() => {
    if (city && city.name === cityQ) return;
    setCity(null);
    if (dCity.trim().length < 2) return setCities([]);
    let alive = true;
    setSearchingCity(true);
    api<City[]>(`/providers/jumomind/cities?q=${encodeURIComponent(dCity.trim())}`)
      .then((list) => {
        if (!alive) return;
        setCities(list);
      })
      .catch((e) => alive && setGeoMsg(errMsg(e)))
      .finally(() => alive && setSearchingCity(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dCity]);

  useEffect(() => {
    if (!city?.hasStreets) return setStreets([]);
    if (street && street.name === streetQ) return;
    setStreet(null);
    let alive = true;
    setSearchingStreet(true);
    api<Street[]>(`/providers/jumomind/streets?cityId=${encodeURIComponent(city.id)}&q=${encodeURIComponent(dStreet.trim())}&house=${encodeURIComponent(dHouse.trim())}`)
      .then((list) => alive && setStreets(list))
      .catch((e) => alive && setGeoMsg(errMsg(e)))
      .finally(() => alive && setSearchingStreet(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city?.id, dStreet, dHouse]);

  const locate = () => {
    if (!("geolocation" in navigator)) return setGeoMsg(t("setup.auto.noGeo"));
    setLocating(true);
    setGeoMsg(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const g = await api<GeoResult>(`/geo/reverse?lat=${pos.coords.latitude.toFixed(6)}&lon=${pos.coords.longitude.toFixed(6)}`);
          if (!g) setGeoMsg(t("setup.auto.locateFailed"));
          else {
            setCityQ(g.city);
            setStreetQ(g.street);
            setHouse(g.houseNumber);
            setGeoMsg(g.display);
          }
        } catch (e) {
          setGeoMsg(errMsg(e));
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setGeoMsg(t("setup.auto.locateFailed"));
      },
      { timeout: 15_000, maximumAge: 600_000 },
    );
  };

  const ready = !!city && (!city.hasStreets || !!street);
  const save = async () => {
    if (!city) return;
    setSaving(true);
    setResult(null);
    try {
      const r = await api<{ source: SourceView; bins: Bin[] }>("/sources", { method: "POST", json: { kind: "jumomind", config: { provider: "jumomind", cityId: city.id, cityName: city.name, areaId: street ? street.areaId : city.areaId, streetId: street?.id, streetName: street?.name } } });
      setResult({ ok: !r.source.error, bins: r.bins.length, pickups: r.source.pickupCount, error: r.source.error ?? undefined });
      if (!r.source.error) setTimeout(onDone, 900);
    } catch (e) {
      setResult({ ok: false, bins: 0, pickups: 0, error: errMsg(e) });
    } finally {
      setSaving(false);
    }
  };

  const noCity = dCity.trim().length >= 2 && !searchingCity && !cities.length && !city;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button onClick={locate} disabled={locating}>{locating ? <Spinner /> : <Icon name="map-pin" size={12} />} {locating ? t("setup.auto.locating") : t("setup.auto.locate")}</Button>
        <span className="soft" style={{ fontSize: 11 }}>{geoMsg ?? t("setup.auto.locateHint")}</span>
      </div>
      <Field label={t("setup.auto.city")} hint={t("setup.auto.provider")}>
        <Input value={cityQ} onChange={(e) => setCityQ(e.target.value)} placeholder={t("setup.auto.cityPlaceholder")} autoFocus />
        {searchingCity ? <div className="soft" style={{ fontSize: 11, marginTop: 4 }}>{t("setup.auto.searching")}</div> : null}
        {!city && cities.length ? (
          <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--line)", marginTop: 4, maxHeight: 160, overflowY: "auto" }}>
            {cities.map((c) => (
              <button key={c.id} type="button" onClick={() => { setCity(c); setCityQ(c.name); setCities([]); }} style={{ textAlign: "left", padding: "6px 8px", border: 0, borderBottom: "1px dashed var(--line)", background: "transparent", color: "inherit", font: "inherit", fontSize: 12, cursor: "pointer" }}>
                {c.name}
              </button>
            ))}
          </div>
        ) : null}
        {noCity ? (
          <div style={{ fontSize: 11, marginTop: 6 }}>
            <div>{t("setup.auto.noCity")}</div>
            <div className="soft">{t("setup.auto.noCityHint")} <a href="#" onClick={(e) => { e.preventDefault(); onFallback("ics"); }}>{t("setup.option.ics.title")}</a> · <a href="#" onClick={(e) => { e.preventDefault(); onFallback("manual"); }}>{t("setup.option.manual.title")}</a></div>
          </div>
        ) : null}
      </Field>
      {city?.hasStreets ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 8 }}>
          <Field label={t("setup.auto.street")}>
            <Input value={streetQ} onChange={(e) => setStreetQ(e.target.value)} placeholder={t("setup.auto.streetPlaceholder")} />
          </Field>
          <Field label={t("setup.auto.house")}>
            <Input value={house} onChange={(e) => setHouse(e.target.value)} placeholder="12" />
          </Field>
          <div style={{ gridColumn: "1 / -1" }}>
            {searchingStreet ? <div className="soft" style={{ fontSize: 11 }}>{t("setup.auto.searching")}</div> : null}
            {!street && streets.length ? (
              <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--line)", maxHeight: 160, overflowY: "auto" }}>
                {streets.map((s) => (
                  <button key={s.id} type="button" onClick={() => { setStreet(s); setStreetQ(s.name); setStreets([]); }} style={{ textAlign: "left", padding: "6px 8px", border: 0, borderBottom: "1px dashed var(--line)", background: "transparent", color: "inherit", font: "inherit", fontSize: 12, cursor: "pointer" }}>
                    {s.name}
                  </button>
                ))}
              </div>
            ) : null}
            {!street && !searchingStreet && !streets.length && dStreet.trim() ? <div className="soft" style={{ fontSize: 11 }}>{t("setup.auto.noStreet")}</div> : null}
          </div>
        </div>
      ) : null}
      {result ? (
        <div style={{ fontSize: 12, color: result.ok ? "var(--ok, #3aa655)" : "var(--bad, #d6372f)" }}>
          {result.ok ? t("setup.auto.found", { bins: result.bins, pickups: result.pickups }) : `${t("setup.auto.failed")} ${result.error ?? ""}`}
        </div>
      ) : null}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button variant="primary" disabled={!ready || saving} onClick={() => void save()}>{saving ? <Spinner /> : <Icon name="check" size={12} />} {t("setup.auto.use")}</Button>
      </div>
    </div>
  );
}

function IcsSetup({ onDone }: { onDone: () => void }) {
  const t = useT();
  const api = useModuleApi();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ source: SourceView }>("/sources", { method: "POST", json: { kind: "ics", name: name || undefined, config: { url } } });
      if (r.source.error) setError(r.source.error);
      else onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={(e) => void save(e)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label={t("setup.ics.url")} hint={t("setup.ics.hint")}>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/abfuhrkalender.ics" required autoFocus />
      </Field>
      <Field label={t("setup.ics.name")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {error ? <div style={{ fontSize: 12, color: "var(--bad, #d6372f)" }}>{error}</div> : null}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button type="submit" variant="primary" disabled={saving}>{saving ? <Spinner /> : <Icon name="check" size={12} />} {t("setup.ics.use")}</Button>
      </div>
    </form>
  );
}

function ManualSetup({ onDone }: { onDone: (sourceId: string) => void }) {
  const t = useT();
  const api = useModuleApi();
  const [name, setName] = useState("");
  const [shift, setShift] = useState(true);
  const [saving, setSaving] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await api<{ source: SourceView }>("/sources", { method: "POST", json: { kind: "manual", name: name || undefined, config: { shiftOnHolidays: shift } } });
      onDone(r.source.id);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={(e) => void save(e)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p className="soft" style={{ fontSize: 12, margin: 0 }}>{t("setup.manual.hint")}</p>
      <Field label={t("setup.manual.name")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("source.manualName")} autoFocus />
      </Field>
      <Checkbox label={t("page.sources.shiftHolidays")} checked={shift} onChange={(e) => setShift(e.target.checked)} style={{ fontSize: 12 }} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button type="submit" variant="primary" disabled={saving}><Icon name="check" size={12} /> {t("setup.manual.create")}</Button>
      </div>
    </form>
  );
}

/* ================= bin editor ================= */

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

function BinModal({ bin, sourceId, manual, onClose, onSaved }: { bin?: Bin; sourceId: string; manual: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { locale } = useModule();
  const api = useModuleApi();
  const [name, setName] = useState(bin?.name ?? "");
  const [type, setType] = useState<BinType>(bin?.type ?? "residual");
  const [color, setColor] = useState(bin?.color ?? BIN_STYLE.residual.color);
  const [rule, setRule] = useState<ManualRule>(() => {
    try {
      if (bin?.rule) return JSON.parse(bin.rule) as ManualRule;
    } catch {
      /* ignore */
    }
    return { mode: "weekly", interval: 2, weekday: 1, start: todayIso() };
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pickType = (ty: BinType) => {
    setType(ty);
    if (!bin || color === BIN_STYLE[bin.type].color) setColor(BIN_STYLE[ty].color);
    if (!name || (bin && name === bin.name && bin.key === null && BIN_TYPES.some((x) => t(`bin.${x}`) === name))) setName(t(`bin.${ty}`));
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: name.trim() || t(`bin.${type}`), type, color };
      if (manual) body.rule = rule;
      if (bin) await api(`/bins/${bin.id}`, { method: "PATCH", json: body });
      else await api("/bins", { method: "POST", json: { ...body, source_id: sourceId } });
      onSaved();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };
  const weekdayName = (d: number) => new Date(2024, 0, 7 + d).toLocaleDateString(locale, { weekday: "long" });
  return (
    <Modal open onClose={onClose} title={bin ? t("bin.edit.title") : t("bin.new.title")}>
      <form onSubmit={(e) => void save(e)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label={t("bin.field.type")}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {BIN_TYPES.map((ty) => (
              <button key={ty} type="button" onClick={() => pickType(ty)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", fontSize: 11, border: `1px solid ${ty === type ? "var(--ink)" : "var(--line)"}`, background: ty === type ? "var(--paper-2)" : "transparent", color: "inherit", font: "inherit", cursor: "pointer" }}>
                <Icon name={BIN_STYLE[ty].icon} size={12} style={{ color: BIN_STYLE[ty].color }} /> {t(`bin.${ty}`)}
              </button>
            ))}
          </div>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 60px", gap: 8 }}>
          <Field label={t("bin.field.name")}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t(`bin.${type}`)} /></Field>
          <Field label={t("bin.field.color")}><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: "100%", height: 30, padding: 0, border: "1px solid var(--line)", background: "transparent" }} /></Field>
        </div>
        {manual ? (
          <Field label={t("bin.field.rule")}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Select value={rule.mode} onChange={(e) => setRule(e.target.value === "dates" ? { mode: "dates", dates: [] } : { mode: "weekly", interval: 2, weekday: 1, start: todayIso() })}>
                <option value="weekly">{t("bin.rule.weekly")}</option>
                <option value="dates">{t("bin.rule.dates")}</option>
              </Select>
              {rule.mode === "weekly" ? (
                <div style={{ display: "grid", gridTemplateColumns: "auto 70px auto 1fr", gap: 8, alignItems: "center", fontSize: 12 }}>
                  <span>{t("bin.rule.every")}</span>
                  <Input type="number" min={1} max={52} value={rule.interval} onChange={(e) => setRule({ ...rule, interval: Math.max(1, Number(e.target.value) || 1) })} />
                  <span>{t("bin.rule.weeksOn", { count: rule.interval })}</span>
                  <Select value={rule.weekday} onChange={(e) => setRule({ ...rule, weekday: Number(e.target.value) })}>
                    {WEEKDAYS.map((d) => <option key={d} value={d}>{weekdayName(d)}</option>)}
                  </Select>
                  <span style={{ gridColumn: "1 / 3" }}>{t("bin.rule.from")}</span>
                  <Input type="date" value={rule.start} onChange={(e) => setRule({ ...rule, start: e.target.value })} style={{ gridColumn: "3 / -1" }} required />
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {rule.dates.map((d, i) => (
                    <div key={i} style={{ display: "flex", gap: 6 }}>
                      <Input type="date" value={d} onChange={(e) => setRule({ mode: "dates", dates: rule.dates.map((x, j) => (j === i ? e.target.value : x)) })} required />
                      <Button icon size="sm" variant="ghost" onClick={() => setRule({ mode: "dates", dates: rule.dates.filter((_, j) => j !== i) })} aria-label="remove"><Icon name="close" size={12} /></Button>
                    </div>
                  ))}
                  <div><Button size="sm" onClick={() => setRule({ mode: "dates", dates: [...rule.dates, todayIso()] })}><Icon name="plus" size={12} /> {t("bin.rule.addDate")}</Button></div>
                  <span className="soft" style={{ fontSize: 11 }}>{t("bin.rule.datesHint")}</span>
                </div>
              )}
            </div>
          </Field>
        ) : null}
        {error ? <div style={{ fontSize: 12, color: "var(--bad, #d6372f)" }}>{error}</div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={saving}>{t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}

export type { SourceKind };
export default defineClient({ widgets: { next: NextWidget, week: WeekWidget }, pages: { waste: WastePage } });
