"use client";

import type { EinkDisplay } from "@orbis/sdk";
import { Button, Chip, Empty, Field, Icon, Input, Modal, Select, useStableId, useToast, Window } from "@orbis/ui";
import { useState, useSyncExternalStore } from "react";
import { useConfirm } from "@/components/Confirm";
import { Shell } from "@/components/Shell";
import { getHubUrl } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import { isAdminRole, useAuthStatus, useDashboards, useEinkDisplays, useEinkMutations } from "@/lib/queries";

/** presets for the boards the firmware supports; sizes are the panel's native landscape resolution */
const BOARDS: Array<{ id: string; label: string; width: number; height: number; grayscale: 1 | 2 | 4 | 8; touch: boolean }> = [
  { id: "inkplate6", label: "Inkplate 6 (800×600, 3-bit gray)", width: 800, height: 600, grayscale: 4, touch: false },
  { id: "inkplate6plus", label: "Inkplate 6PLUS (1024×758, touch)", width: 1024, height: 758, grayscale: 4, touch: true },
  { id: "inkplate10", label: "Inkplate 10 (1200×825)", width: 1200, height: 825, grayscale: 4, touch: false },
  { id: "inkplate6color", label: "Inkplate 6COLOR (600×448, b/w mode)", width: 600, height: 448, grayscale: 1, touch: false },
  { id: "lilygo-t5-47", label: "LilyGo T5 4.7\" (960×540, 16 gray)", width: 960, height: 540, grayscale: 4, touch: false },
  { id: "lilygo-t5-47-plus", label: "LilyGo T5 4.7\" Plus / S3 (960×540, touch)", width: 960, height: 540, grayscale: 4, touch: true },
  { id: "waveshare-75", label: "Waveshare 7.5\" b/w (800×480) + ESP32 driver board", width: 800, height: 480, grayscale: 1, touch: false },
  { id: "waveshare-42", label: "Waveshare 4.2\" b/w (400×300)", width: 400, height: 300, grayscale: 1, touch: false },
  { id: "waveshare-29", label: "Waveshare 2.9\" b/w (296×128)", width: 296, height: 128, grayscale: 1, touch: false },
  { id: "custom", label: "custom / other", width: 800, height: 480, grayscale: 1, touch: false },
];

/* "which minute is it" as an external store, so render stays pure and the preview urls / seen-chips refresh once a minute */
const minuteNow = () => Math.floor(Date.now() / 60_000);
function subscribeMinute(cb: () => void) {
  const id = setInterval(cb, 60_000);
  return () => clearInterval(id);
}
function useMinute() {
  return useSyncExternalStore(subscribeMinute, minuteNow, () => 0);
}

export default function EinkPage() {
  const t = useT();
  const confirm = useConfirm();
  const minute = useMinute();
  const status = useAuthStatus();
  const admin = isAdminRole(status.data?.user?.role);
  const displays = useEinkDisplays();
  const dashboards = useDashboards();
  const m = useEinkMutations();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [tokenFor, setTokenFor] = useState<EinkDisplay | null>(null);
  // the preview image url carries the moment it was opened, so it is fresh per open but stable while open
  const [preview, setPreview] = useState<{ d: EinkDisplay; at: number } | null>(null);
  const hub = getHubUrl() ?? "";

  return (
    <Shell
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="tv" size={16} style={{ color: "var(--accent)" }} /> {t("eink.title")}
        </span>
      }
      actions={admin ? <Button size="sm" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> {t("eink.display")}</Button> : null}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {displays.isPending ? null : (displays.data ?? []).length === 0 ? (
          <Empty icon="tv" title={t("eink.empty.title")}>
            <p style={{ marginBottom: 10 }}>{t("eink.empty.body")}</p>
            {admin ? <Button variant="primary" onClick={() => setCreating(true)}>{t("eink.addDisplay")}</Button> : null}
          </Empty>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
            {(displays.data ?? []).map((d) => (
              <Window
                key={d.id}
                title={d.name}
                right={
                  <Chip style={{ fontSize: 10 }} tone={d.lastSeen && minute * 60_000 - new Date(d.lastSeen).getTime() < d.refreshMinutes * 2 * 60_000 ? "ok" : undefined}>
                    {d.lastSeen ? t("eink.seen", { time: new Date(d.lastSeen).toLocaleTimeString() }) : t("eink.neverConnected")}
                  </Chip>
                }
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
                  <button type="button" onClick={() => setPreview({ d, at: Date.now() })} style={{ border: "1.5px solid var(--line)", background: "#fff", aspectRatio: `${d.rotate % 180 ? d.height : d.width} / ${d.rotate % 180 ? d.width : d.height}`, overflow: "hidden", cursor: "zoom-in" }} title={t("eink.preview")} aria-label={t("eink.previewOf", { name: d.name })}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- rendered by the hub, not a static asset */}
                    <img src={`${hub}/api/eink/displays/${d.id}/preview.png?t=${minute}`} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated", display: "block" }} />
                  </button>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    <Chip>{d.width}×{d.height}</Chip>
                    <Chip>{d.grayscale === 1 ? t("eink.bw") : t("eink.grays", { count: 1 << d.grayscale })}</Chip>
                    <Chip>{t("eink.every", { count: d.refreshMinutes })}</Chip>
                    {d.rotate ? <Chip>{d.rotate}°</Chip> : null}
                    {d.board ? <Chip>{d.board}</Chip> : null}
                    {d.battery !== null ? <Chip tone={d.battery < 20 ? "bad" : undefined}>🔋 {d.battery}%</Chip> : null}
                  </div>
                  <Field label={t("common.dashboard")}>
                    <Select value={d.dashboardId ?? ""} disabled={!admin} onChange={(e) => m.update.mutate({ id: d.id, dashboardId: e.target.value || null }, { onError: (err) => toast(err.message, "bad") })}>
                      <option value="">{t("eink.none")}</option>
                      {(dashboards.data ?? []).map((x) => (
                        <option key={x.id} value={x.id}>{x.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <Field label={t("eink.rotation")}>
                      <Select value={d.rotate} disabled={!admin} onChange={(e) => m.update.mutate({ id: d.id, rotate: Number(e.target.value) as 0 | 90 | 180 | 270 })}>
                        {[0, 90, 180, 270].map((r) => <option key={r} value={r}>{r}°</option>)}
                      </Select>
                    </Field>
                    <Field label={t("eink.refresh")}>
                      <Input type="number" min={1} max={1440} defaultValue={d.refreshMinutes} disabled={!admin} onBlur={(e) => Number(e.target.value) !== d.refreshMinutes && m.update.mutate({ id: d.id, refreshMinutes: Number(e.target.value) })} />
                    </Field>
                  </div>
                  <div className="soft" style={{ fontSize: 11 }}>
                    {t("eink.imageUrl")} <code style={{ overflowWrap: "anywhere" }}>{hub}/api/eink/{d.id}.bin</code>
                  </div>
                  {admin ? (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Button size="sm" onClick={() => setTokenFor(d)}><Icon name="key" size={12} /> {t("eink.tokenSetup")}</Button>
                      <a className="btn btn-sm" href={`${hub}/api/eink/displays/${d.id}/preview.png`} target="_blank" rel="noreferrer"><Icon name="image" size={12} /> {t("eink.openPng")}</a>
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={t("eink.remove", { name: d.name })}
                        title={t("eink.remove", { name: d.name })}
                        onClick={async () => {
                          if (await confirm({ title: t("eink.remove", { name: d.name }), body: t("eink.removeConfirm", { name: d.name }), confirmLabel: t("common.remove"), danger: true })) m.remove.mutate(d.id, { onError: (err) => toast(err.message, "bad") });
                        }}
                      >
                        <Icon name="trash" size={12} />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </Window>
            ))}
          </div>
        )}
        <Window title={t("eink.how.title")} dashed>
          <ol style={{ fontSize: 12, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4, margin: 0 }}>
            <li>{t("eink.how.1")}</li>
            <li>{t("eink.how.2.before")} <a href="https://orbis-hub.github.io/flash/" target="_blank" rel="noreferrer">{t("eink.how.2.link")}</a> {t("eink.how.2.after")}</li>
            <li>{t("eink.how.3.before")} <b>orbis-eink</b>{t("eink.how.3.middle")} <i>{t("eink.tokenSetup")}</i>{t("eink.how.3.after")}</li>
            <li>{t("eink.how.4.before")} <code>/api/eink/&lt;id&gt;.bin</code> {t("eink.how.4.after")}</li>
          </ol>
        </Window>
      </div>

      <CreateModal open={creating} onClose={() => setCreating(false)} onCreated={(d) => setTokenFor(d)} />
      <TokenModal display={tokenFor} onClose={() => setTokenFor(null)} />
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview ? `${preview.d.name} · ${preview.d.width}×${preview.d.height}` : ""} width={Math.min(1100, (preview?.d.width ?? 800) + 60)} closeLabel={t("common.close")}>
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- rendered by the hub, not a static asset
          <img src={`${hub}/api/eink/displays/${preview.d.id}/preview.png?t=${preview.at}`} alt={t("eink.previewOf", { name: preview.d.name })} style={{ width: "100%", imageRendering: "pixelated", border: "1.5px solid var(--line)", background: "#fff" }} />
        ) : null}
      </Modal>
    </Shell>
  );
}

function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (d: EinkDisplay) => void }) {
  const t = useT();
  const m = useEinkMutations();
  const dashboards = useDashboards();
  const toast = useToast();
  const [board, setBoard] = useState(BOARDS[0]!);
  const [name, setName] = useState(t("eink.defaultName"));
  const [w, setW] = useState(board.width);
  const [h, setH] = useState(board.height);
  const [dash, setDash] = useState("");
  const pickBoard = (id: string) => {
    const b = BOARDS.find((x) => x.id === id) ?? BOARDS[0]!;
    setBoard(b);
    setW(b.width);
    setH(b.height);
  };
  return (
    <Modal open={open} onClose={onClose} title={t("eink.new")} closeLabel={t("common.close")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.create.mutate(
            { name, width: w, height: h, grayscale: board.grayscale, dashboardId: dash || null, board: board.id === "custom" ? null : board.id, refreshMinutes: 10 },
            {
              onSuccess: (d) => {
                onClose();
                onCreated(d);
              },
              onError: (err) => toast(err.message, "bad"),
            },
          );
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <Field label={t("common.name")}><Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field>
        <Field label={t("eink.board")}>
          <Select value={board.id} onChange={(e) => pickBoard(e.target.value)}>
            {BOARDS.map((b) => <option key={b.id} value={b.id}>{b.id === "custom" ? t("eink.customBoard") : b.label}{b.touch ? ` · ${t("eink.touch")}` : ""}</option>)}
          </Select>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label={t("eink.width")}><Input type="number" value={w} onChange={(e) => setW(Number(e.target.value))} min={64} /></Field>
          <Field label={t("eink.height")}><Input type="number" value={h} onChange={(e) => setH(Number(e.target.value))} min={64} /></Field>
        </div>
        <Field label={t("common.dashboard")} hint={t("eink.dashboardHint")}>
          <Select value={dash} onChange={(e) => setDash(e.target.value)}>
            <option value="">{t("eink.chooseLater")}</option>
            {(dashboards.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
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

function TokenModal({ display, onClose }: { display: EinkDisplay | null; onClose: () => void }) {
  const t = useT();
  const m = useEinkMutations();
  const toast = useToast();
  const [rotated, setRotated] = useState<EinkDisplay | null>(null);
  const tokenId = useStableId("eink-token");
  const d = rotated && rotated.id === display?.id ? rotated : display;
  const hub = getHubUrl() ?? "";
  if (!d) return null;
  const token = d.token ?? t("eink.tokenHidden");
  return (
    <Modal open onClose={onClose} title={t("eink.setupTitle", { name: d.name })} closeLabel={t("common.close")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12 }}>
        <Field label={t("eink.hubUrl")} hint={t("eink.hubUrlHint")}>
          <Input readOnly value={hub} onFocus={(e) => e.target.select()} />
        </Field>
        <Field label={t("eink.displayId")}><Input readOnly value={d.id} onFocus={(e) => e.target.select()} /></Field>
        <Field label={t("eink.token")} hint={t("eink.tokenHint")} htmlFor={tokenId}>
          <div style={{ display: "flex", gap: 6 }}>
            <Input id={tokenId} readOnly value={token} onFocus={(e) => e.target.select()} />
            <Button size="sm" onClick={() => m.rotateToken.mutate(d.id, { onSuccess: (nd) => { setRotated(nd); toast(t("eink.newToken"), "ok"); } })}>{t("eink.rotate")}</Button>
          </div>
        </Field>
        <div className="win win-dashed win-flat" style={{ padding: "8px 10px" }}>
          <div className="pixel" style={{ marginBottom: 4 }}>{t("eink.testTitle")}</div>
          <code style={{ overflowWrap: "anywhere" }}>{`curl -H "authorization: Bearer ${d.token ?? "<token>"}" ${hub}/api/eink/${d.id}.png -o display.png`}</code>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{t("common.done")}</Button>
        </div>
      </div>
    </Modal>
  );
}
