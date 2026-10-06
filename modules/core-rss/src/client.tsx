import { useState } from "react";
import { defineClient, useModule, useModuleApi, useModuleQuery, useT, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import type { Translator } from "@orbis/sdk/client";
import { Button, Chip, Empty, Icon, Input, Window, cx } from "@orbis/ui";
import type { Feed, Item } from "./server";

const ago = (iso: string, t: Translator) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 60 ? t("ago.minutes", { count: m }) : m < 1440 ? t("ago.hours", { count: Math.round(m / 60) }) : t("ago.days", { count: Math.round(m / 1440) });
};

function Row({ it, dense, lines = 2, showSource, onRead }: { it: Item; dense?: boolean; lines?: 1 | 2; showSource?: boolean; onRead: (id: string) => void }) {
  const t = useT();
  const meta = `${showSource !== false ? `${it.feed_title} · ` : ""}${ago(it.published, t)}${!dense && it.summary ? ` · ${it.summary.slice(0, 120)}` : ""}`;
  return (
    <a href={it.url} target="_blank" rel="noreferrer" onClick={() => onRead(it.id)} title={it.title} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: dense ? "3px 0" : "6px 0", borderBottom: "1px dashed var(--line)", textDecoration: "none", color: "inherit", opacity: it.read ? 0.55 : 1, minWidth: 0 }}>
      <div style={{ width: 14, height: 14, flex: "none", marginTop: 2 }}>{it.favicon ? <img src={it.favicon} alt="" width={14} height={14} /> : <Icon name="radio" size={12} className="soft" />}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* headline clamps to `lines` with an ellipsis (-webkit-box) instead of wrapping on */}
        <div style={{ fontSize: dense ? 12 : 13, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflowWrap: "anywhere" }}>{it.title}</div>
        <div className="soft" style={{ fontSize: "var(--fs-meta)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: dense ? "nowrap" : undefined }} title={dense ? meta : undefined}>{meta}</div>
      </div>
    </a>
  );
}

function HeadlinesWidget({ config, size }: WidgetProps<{ feedId?: string; count?: number; unreadOnly?: boolean; showSource?: boolean }>) {
  const api = useModuleApi();
  const t = useT();
  const q = useModuleQuery<Item[]>(`/items?limit=${config.count ?? 8}${config.feedId ? `&feed=${config.feedId}` : ""}${config.unreadOnly ? "&unread=1" : ""}`, { refetchOn: ["changed"] });
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>;
  if (!q.data?.length) return <Empty icon="radio" title={t("widget.empty.title")}>{t("widget.empty.body")}</Empty>;
  // two-line headlines, except in a 2-row widget where a single row (≈50px) would show just one item
  const lines = size.height > 0 && size.height < 100 ? 1 : 2;
  return (
    <div className="scroll-y" style={{ height: "100%", overflowX: "hidden", minWidth: 0 }}>
      {q.data.map((it) => <Row key={it.id} it={it} dense lines={lines} showSource={config.showSource} onRead={(id) => void api("/read", { method: "POST", json: { ids: [id] } })} />)}
    </div>
  );
}

function FeedsPage(_p: PageProps) {
  const api = useModuleApi();
  const t = useT();
  const feeds = useModuleQuery<Array<Feed & { unread: number }>>("/feeds", { refetchOn: ["changed"] });
  const { locale } = useModule();
  const [sel, setSel] = useState<string | null>(null);
  const selFeed = sel ? feeds.data?.find((f) => f.id === sel) : undefined;
  const [unread, setUnread] = useState(true);
  const items = useModuleQuery<Item[]>(`/items?limit=100${sel ? `&feed=${sel}` : ""}${unread ? "&unread=1" : ""}`, { refetchOn: ["changed"] });
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const read = (ids: string[]) => void api("/read", { method: "POST", json: { ids } }).then(() => items.refetch());
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 240px) minmax(0, 1fr)", gap: 14, alignItems: "start" }} className="feeds-page">
      <style>{`@media (max-width: 760px) { .feeds-page { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Window title={t("page.feeds")} tight>
          <div style={{ display: "flex", flexDirection: "column", padding: 6 }}>
            <button type="button" className="nav-item" aria-current={sel === null ? "page" : undefined} onClick={() => setSel(null)} style={{ justifyContent: "space-between" }}>
              <span>{t("page.all")}</span><Chip style={{ fontSize: "var(--fs-min)" }}>{(feeds.data ?? []).reduce((a, f) => a + f.unread, 0)}</Chip>
            </button>
            {(feeds.data ?? []).map((f) => (
              <button key={f.id} type="button" className={cx("nav-item")} aria-current={sel === f.id ? "page" : undefined} onClick={() => setSel(f.id)} style={{ justifyContent: "space-between" }} title={f.error ? `${f.url}\n${t("page.last_error", { time: new Date(f.last_error_at ?? f.last_fetched ?? Date.now()).toLocaleString(locale), error: f.error })}` : `${f.url}\n${t("page.last_ok", { time: f.last_ok ? new Date(f.last_ok).toLocaleString(locale) : t("page.never") })}`}>
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                  {f.favicon ? <img src={f.favicon} alt="" width={12} height={12} /> : <Icon name={f.error ? "warning-diamond" : "radio"} size={12} style={{ color: f.error ? "var(--dnd)" : undefined }} />}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.title}</span>
                </span>
                {f.unread ? <Chip style={{ fontSize: "var(--fs-min)" }}>{f.unread}</Chip> : null}
              </button>
            ))}
          </div>
        </Window>
        <Window title={t("page.add_feed")} dashed>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                const f = await api<Feed>("/feeds", { method: "POST", json: { url } });
                if (f.error) setErr(f.error);
                else setUrl("");
                feeds.refetch();
              } catch (ex) {
                setErr((ex as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("page.url_placeholder")} required inputMode="url" />
            {err ? <span style={{ color: "var(--dnd)", fontSize: "var(--fs-meta)" }}>{err}</span> : null}
            <div style={{ display: "flex", gap: 6 }}>
              <Button type="submit" size="sm" loading={busy}>{t("common.add")}</Button>
              {sel ? <Button size="sm" variant="danger" onClick={() => confirm(t("page.remove_confirm")) && api(`/feeds/${sel}`, { method: "DELETE" }).then(() => { setSel(null); feeds.refetch(); })}>{t("page.remove_selected")}</Button> : null}
            </div>
          </form>
        </Window>
      </div>
      <Window
        title={sel ? feeds.data?.find((f) => f.id === sel)?.title ?? t("page.feed") : t("page.all_feeds")}
        right={
          <>
            <label className="check" style={{ fontSize: "var(--fs-meta)" }}><input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} /><i aria-hidden /><span>{t("page.unread_only")}</span></label>
            <Button size="sm" variant="ghost" onClick={() => api("/read", { method: "POST", json: { all: true, feed: sel ?? undefined } }).then(() => items.refetch())}>{t("page.mark_all_read")}</Button>
            <Button icon size="sm" variant="ghost" onClick={() => api("/refresh", { method: "POST" }).then(() => items.refetch())} aria-label={t("common.refresh")}><Icon name="reload" size={12} /></Button>
          </>
        }
      >
        {selFeed ? (
          <div className="soft" style={{ fontSize: "var(--fs-meta)", display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6, color: selFeed.error ? "var(--dnd)" : undefined }}>
            <span>{t("page.last_ok", { time: selFeed.last_ok ? new Date(selFeed.last_ok).toLocaleString(locale) : t("page.never") })}</span>
            {selFeed.error ? <span>· {t("page.last_error", { time: new Date(selFeed.last_error_at ?? selFeed.last_fetched ?? Date.now()).toLocaleString(locale), error: selFeed.error })}</span> : null}
          </div>
        ) : null}
        {items.data?.length === 0 ? <Empty icon="radio" title={unread ? t("page.all_read") : t("page.nothing")} /> : null}
        {(items.data ?? []).map((it) => <Row key={it.id} it={it} onRead={(id) => read([id])} />)}
      </Window>
    </div>
  );
}

export default defineClient({ widgets: { headlines: HeadlinesWidget }, pages: { feeds: FeedsPage } });
