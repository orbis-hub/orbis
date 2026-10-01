import { useState } from "react";
import { defineClient, useModuleApi, useModuleQuery, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Icon, Input, Window, cx } from "@orbis/ui";
import type { Feed, Item } from "./server";

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

function Row({ it, dense, showSource, onRead }: { it: Item; dense?: boolean; showSource?: boolean; onRead: (id: string) => void }) {
  return (
    <a href={it.url} target="_blank" rel="noreferrer" onClick={() => onRead(it.id)} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: dense ? "3px 0" : "6px 0", borderBottom: "1px dashed var(--line)", textDecoration: "none", color: "inherit", opacity: it.read ? 0.55 : 1 }}>
      <div style={{ width: 14, height: 14, flex: "none", marginTop: 2 }}>{it.favicon ? <img src={it.favicon} alt="" width={14} height={14} /> : <Icon name="radio" size={12} className="soft" />}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: dense ? 12 : 13, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: dense ? 1 : 2, WebkitBoxOrient: "vertical" }}>{it.title}</div>
        <div className="soft" style={{ fontSize: 10 }}>{showSource !== false ? `${it.feed_title} · ` : ""}{ago(it.published)}{!dense && it.summary ? ` · ${it.summary.slice(0, 120)}` : ""}</div>
      </div>
    </a>
  );
}

function HeadlinesWidget({ config }: WidgetProps<{ feedId?: string; count?: number; unreadOnly?: boolean; showSource?: boolean }>) {
  const api = useModuleApi();
  const q = useModuleQuery<Item[]>(`/items?limit=${config.count ?? 8}${config.feedId ? `&feed=${config.feedId}` : ""}${config.unreadOnly ? "&unread=1" : ""}`, { refetchOn: ["changed"] });
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  if (!q.data?.length) return <Empty icon="radio" title="nothing here">add feeds on the feeds page.</Empty>;
  return (
    <div className="scroll-y" style={{ height: "100%" }}>
      {q.data.map((it) => <Row key={it.id} it={it} dense showSource={config.showSource} onRead={(id) => void api("/read", { method: "POST", json: { ids: [id] } })} />)}
    </div>
  );
}

function FeedsPage(_p: PageProps) {
  const api = useModuleApi();
  const feeds = useModuleQuery<Array<Feed & { unread: number }>>("/feeds", { refetchOn: ["changed"] });
  const [sel, setSel] = useState<string | null>(null);
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
        <Window title="feeds" tight>
          <div style={{ display: "flex", flexDirection: "column", padding: 6 }}>
            <button type="button" className="nav-item" aria-current={sel === null ? "page" : undefined} onClick={() => setSel(null)} style={{ justifyContent: "space-between" }}>
              <span>all</span><Chip style={{ fontSize: 10 }}>{(feeds.data ?? []).reduce((a, f) => a + f.unread, 0)}</Chip>
            </button>
            {(feeds.data ?? []).map((f) => (
              <button key={f.id} type="button" className={cx("nav-item")} aria-current={sel === f.id ? "page" : undefined} onClick={() => setSel(f.id)} style={{ justifyContent: "space-between" }} title={f.error ?? f.url}>
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                  {f.favicon ? <img src={f.favicon} alt="" width={12} height={12} /> : <Icon name={f.error ? "warning-diamond" : "radio"} size={12} style={{ color: f.error ? "var(--dnd)" : undefined }} />}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.title}</span>
                </span>
                {f.unread ? <Chip style={{ fontSize: 10 }}>{f.unread}</Chip> : null}
              </button>
            ))}
          </div>
        </Window>
        <Window title="add feed" dashed>
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
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="feed or site url" required inputMode="url" />
            {err ? <span style={{ color: "var(--dnd)", fontSize: 11 }}>{err}</span> : null}
            <div style={{ display: "flex", gap: 6 }}>
              <Button type="submit" size="sm" loading={busy}>add</Button>
              {sel ? <Button size="sm" variant="danger" onClick={() => confirm("remove this feed?") && api(`/feeds/${sel}`, { method: "DELETE" }).then(() => { setSel(null); feeds.refetch(); })}>remove selected</Button> : null}
            </div>
          </form>
        </Window>
      </div>
      <Window
        title={sel ? feeds.data?.find((f) => f.id === sel)?.title ?? "feed" : "all feeds"}
        right={
          <>
            <label className="check" style={{ fontSize: 11 }}><input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} /><i aria-hidden /><span>unread only</span></label>
            <Button size="sm" variant="ghost" onClick={() => api("/read", { method: "POST", json: { all: true, feed: sel ?? undefined } }).then(() => items.refetch())}>mark all read</Button>
            <Button icon size="sm" variant="ghost" onClick={() => api("/refresh", { method: "POST" }).then(() => items.refetch())} aria-label="refresh"><Icon name="reload" size={12} /></Button>
          </>
        }
      >
        {items.data?.length === 0 ? <Empty icon="radio" title={unread ? "all read" : "nothing"} /> : null}
        {(items.data ?? []).map((it) => <Row key={it.id} it={it} onRead={(id) => read([id])} />)}
      </Window>
    </div>
  );
}

export default defineClient({ widgets: { headlines: HeadlinesWidget }, pages: { feeds: FeedsPage } });
