import { useEffect, useRef, useState } from "react";
import { defineClient, useModuleApi, useModuleQuery, useT, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import type { Translator } from "@orbis/sdk/client";
import { Button, Empty, Icon, Input, Modal, Window, cx } from "@orbis/ui";
import { AISLE_TEMPLATES, aisleTemplate, compareAisles, variants } from "./aisles";
import type { AislesResponse, ShopItem } from "./server";

function useItems(list: string, done = false) {
  return useModuleQuery<ShopItem[]>(`/items?list=${encodeURIComponent(list)}${done ? "&done=1" : ""}`, { refetchOn: ["changed"] });
}
function useAisles(list: string) {
  return useModuleQuery<AislesResponse>(`/aisles?list=${encodeURIComponent(list)}`, { refetchOn: ["changed"] });
}

/** template ids show their translated name, free-form aisles as typed */
function aisleLabel(aisle: string, t: Translator): string {
  return aisleTemplate(aisle) ? t(`aisle.${aisle}`) : aisle;
}

function AisleTag({ aisle, size = 10 }: { aisle: string; size?: number }) {
  const t = useT();
  const tpl = aisleTemplate(aisle);
  return (
    <span className="soft" style={{ fontSize: size, display: "inline-flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}>
      {tpl ? <Icon name={tpl.icon} size={size} /> : <Icon name="label" size={size} />}
      {aisleLabel(aisle, t)}
    </span>
  );
}

/** quick add with suggestions from what you bought before; `@` opens the aisle templates */
function QuickAdd({ list, onAdded, big }: { list: string; onAdded: () => void; big?: boolean }) {
  const api = useModuleApi();
  const t = useT();
  const [text, setText] = useState("");
  const [sugg, setSugg] = useState<Array<{ name: string; aisle: string | null; times: number }>>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const aisles = useAisles(list);
  // "2 apples @fr" → at-mode with partial "fr"
  const at = text.match(/(?:^|\s)@(\S*)$/);
  const partial = at ? at[1]! : null;
  useEffect(() => {
    clearTimeout(timer.current);
    const q = text.trim().replace(/^\d+\S*\s+/, "").replace(/\s@\S*$/, "");
    if (q.length < 1 || partial !== null) {
      setSugg([]);
      return;
    }
    timer.current = setTimeout(() => void api<typeof sugg>(`/suggest?list=${encodeURIComponent(list)}&q=${encodeURIComponent(q)}`).then(setSugg).catch(() => undefined), 200);
  }, [text, list, api, partial]);
  const add = async (txt: string) => {
    if (!txt.trim()) return;
    await api("/items", { method: "POST", json: { text: txt, list } });
    setText("");
    setSugg([]);
    onAdded();
  };
  const options = partial === null ? [] : (() => {
    const all = [
      ...AISLE_TEMPLATES.map((a) => ({ key: a.id, icon: a.icon, label: t(`aisle.${a.id}`) })),
      ...(aisles.data?.used ?? []).map((a) => ({ key: a, icon: "label", label: a })),
    ];
    if (!partial) return all;
    const p = variants(partial);
    return all.filter((o) => [...variants(o.label), o.key].some((v) => p.some((q) => v.startsWith(q))));
  })();
  const pickAisle = (label: string) => {
    setText(text.replace(/@\S*$/, `@${label} `));
    input.current?.focus();
  };
  return (
    <div style={{ position: "relative" }}>
      <form onSubmit={(e) => { e.preventDefault(); void add(text); }} style={{ display: "flex", gap: 6 }}>
        <input ref={input} className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("quickadd.placeholder")} style={{ padding: big ? "8px 10px" : "4px 8px", fontSize: big ? 14 : 12 }} />
        <Button type="submit" size={big ? "md" : "sm"} disabled={!text.trim()} aria-label={t("quickadd.add")}><Icon name="plus" size={big ? 16 : 12} /></Button>
      </form>
      {options.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
          {options.map((o) => (
            <button key={o.key} type="button" className="chip" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }} onClick={() => pickAisle(o.label)}>
              <Icon name={o.icon} size={10} /> {o.label}
            </button>
          ))}
        </div>
      ) : null}
      {sugg.length ? (
        <div className="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 50, padding: 2 }}>
          {sugg.map((s) => (
            <button key={s.name} type="button" className="menu-item" onClick={() => void add(`${s.name}${s.aisle ? ` @${s.aisle}` : ""}`)}>
              <span style={{ flex: 1 }}>{s.name}</span>
              {s.aisle ? <AisleTag aisle={s.aisle} /> : null}
              <span className="soft" style={{ fontSize: 10 }}>×{s.times}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** store-walk order: template aisles first, then free-form alphabetically, no aisle last */
function groupByAisle(items: ShopItem[]) {
  const map = new Map<string, ShopItem[]>();
  for (const i of items) {
    const k = i.aisle ?? "";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(i);
  }
  return [...map.entries()].sort(([a], [b]) => compareAisles(a || null, b || null));
}

function ItemRow({ i, big, onToggle }: { i: ShopItem; big?: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: big ? "8px 4px" : "4px 2px", borderBottom: "1px dashed var(--line)", textAlign: "left", opacity: i.done ? 0.5 : 1 }}>
      <i className={cx("check")} style={{ width: big ? 22 : 16, height: big ? 22 : 16, border: "1.5px solid var(--line)", background: i.done ? "var(--accent)" : "var(--paper-2)", flex: "none", display: "inline-block" }} />
      <span style={{ flex: 1, fontSize: big ? 15 : 13, textDecoration: i.done ? "line-through" : undefined }}>{i.qty ? <b style={{ fontWeight: 600 }}>{i.qty} </b> : null}{i.name}</span>
      {i.aisle && !big ? <AisleTag aisle={i.aisle} /> : null}
    </button>
  );
}

function AisleHeading({ aisle, size }: { aisle: string; size: number }) {
  const t = useT();
  const tpl = aisleTemplate(aisle);
  return (
    <div className="pixel soft" style={{ fontSize: size, marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
      {tpl ? <Icon name={tpl.icon} size={size} /> : null}
      {aisleLabel(aisle, t)}
    </div>
  );
}

/** pick a template aisle, a free-form one or none (replaces the old prompt()) */
function AislePicker({ item, used, onClose, onPick }: { item: ShopItem; used: string[]; onClose: () => void; onPick: (aisle: string | null) => void }) {
  const t = useT();
  const [custom, setCustom] = useState(item.aisle && !aisleTemplate(item.aisle) ? item.aisle : "");
  const btn = (key: string, label: string, icon: string | null, value: string | null) => (
    <button key={key} type="button" className="chip" aria-pressed={(item.aisle ?? null) === value} style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, outline: (item.aisle ?? null) === value ? "2px solid var(--accent)" : undefined }} onClick={() => onPick(value)}>
      {icon ? <Icon name={icon} size={11} /> : null} {label}
    </button>
  );
  return (
    <Modal open onClose={onClose} title={t("picker.title", { name: item.name })} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {AISLE_TEMPLATES.map((a) => btn(a.id, t(`aisle.${a.id}`), a.icon, a.id))}
          {used.map((a) => btn(a, a, "label", a))}
          {btn("_none", t("picker.none"), null, null)}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onPick(custom.trim() || null); }} style={{ display: "flex", gap: 6 }}>
          <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t("picker.custom")} style={{ flex: 1 }} />
          <Button type="submit" size="sm" disabled={!custom.trim()}>{t("picker.save")}</Button>
        </form>
      </div>
    </Modal>
  );
}

function ListWidget({ config, size }: WidgetProps<{ list?: string; groupByAisle?: boolean; quickAdd?: boolean }>) {
  const api = useModuleApi();
  const t = useT();
  const list = config.list || "groceries";
  const q = useItems(list);
  const items = q.data ?? [];
  const toggle = (i: ShopItem) => void api(`/items/${i.id}`, { method: "PATCH", json: { done: !i.done } }).then(() => q.refetch());
  const big = size.width < 420; // phones / kiosk tiles → store mode
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
        {q.loading && !q.data ? <span className="soft pixel" style={{ fontSize: 12 }}>{t("list.loading")}</span> : items.length === 0 ? <div className="empty" style={{ padding: 10 }}><span className="pixel">{t("list.empty")}</span></div> : null}
        {config.groupByAisle !== false
          ? groupByAisle(items).map(([aisle, rows]) => (
              <div key={aisle || "_"}>
                {aisle ? <AisleHeading aisle={aisle} size={10} /> : null}
                {rows.map((i) => <ItemRow key={i.id} i={i} big={big} onToggle={() => toggle(i)} />)}
              </div>
            ))
          : items.map((i) => <ItemRow key={i.id} i={i} big={big} onToggle={() => toggle(i)} />)}
      </div>
      {config.quickAdd !== false ? <QuickAdd list={list} onAdded={q.refetch} big={big} /> : null}
      <div className="soft" style={{ fontSize: 10, textAlign: "right" }}>{t("list.toBuy", { count: items.length })}</div>
    </div>
  );
}

function ShoppingPage(_p: PageProps) {
  const api = useModuleApi();
  const t = useT();
  const lists = useModuleQuery<Array<{ list: string; open: number }>>("/lists", { refetchOn: ["changed"] });
  const [list, setList] = useState("groceries");
  const open = useItems(list);
  const all = useItems(list, true);
  const aisles = useAisles(list);
  const [picking, setPicking] = useState<ShopItem | null>(null);
  const bought = (all.data ?? []).filter((i) => i.done).slice(0, 40);
  const refetch = () => { void open.refetch(); void all.refetch(); };
  const toggle = (i: ShopItem) => void api(`/items/${i.id}`, { method: "PATCH", json: { done: !i.done } }).then(refetch);
  const names = [...new Set(["groceries", ...(lists.data ?? []).map((l) => l.list)])];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(240px, 320px)", gap: 14, alignItems: "start" }} className="shop-page">
      <style>{`@media (max-width: 760px) { .shop-page { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
      <Window
        title={
          <span style={{ display: "inline-flex", gap: 6 }}>
            {names.map((n) => <button key={n} type="button" className={cx("tab")} aria-selected={n === list} onClick={() => setList(n)} style={{ top: 0, padding: "0 8px", fontSize: 12 }}>{n}{(lists.data ?? []).find((l) => l.list === n)?.open ? ` (${(lists.data ?? []).find((l) => l.list === n)!.open})` : ""}</button>)}
            <button type="button" className="tab" style={{ top: 0, padding: "0 8px", fontSize: 12 }} onClick={() => { const n = prompt(t("list.new")); if (n) setList(n.trim().toLowerCase()); }}>+</button>
          </span>
        }
        right={<Button size="sm" variant="ghost" onClick={() => api("/clear-done", { method: "POST", json: { list } }).then(() => all.refetch())}>{t("list.tidy")}</Button>}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <QuickAdd list={list} onAdded={refetch} big />
          <div className="soft" style={{ fontSize: 11 }}>{t("tip.prefix")} <code>{t("tip.example")}</code> {t("tip.text")}</div>
          {(open.data ?? []).length === 0 ? <Empty icon="shopping-bag" title={t("list.nothing")} /> : null}
          {groupByAisle(open.data ?? []).map(([aisle, rows]) => (
            <div key={aisle || "_"}>
              {aisle ? <AisleHeading aisle={aisle} size={11} /> : null}
              {rows.map((i) => (
                <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ flex: 1 }}><ItemRow i={i} big onToggle={() => toggle(i)} /></div>
                  {i.aisle ? <AisleTag aisle={i.aisle} /> : null}
                  <Button icon size="sm" variant="ghost" aria-label={t("item.aisle")} title={t("item.aisle")} onClick={() => setPicking(i)}><Icon name="label" size={12} /></Button>
                  <Button icon size="sm" variant="ghost" aria-label={t("item.remove")} title={t("item.remove")} onClick={() => void api(`/items/${i.id}`, { method: "DELETE" }).then(refetch)}><Icon name="trash" size={12} /></Button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Window>
      <Window title={t("bought.title")} dashed>
        {bought.length === 0 ? <div className="soft" style={{ fontSize: 12 }}>{t("bought.empty")}</div> : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {bought.map((i) => (
            <button key={i.id} type="button" className="chip" style={{ cursor: "pointer" }} title={t("bought.again")} onClick={() => toggle(i)}>
              <Icon name="plus" size={10} /> {i.name}{i.times > 1 ? <span className="soft"> ×{i.times}</span> : null}
            </button>
          ))}
        </div>
        {bought.length ? <div className="soft" style={{ fontSize: 10, marginTop: 8 }}>{t("bought.hint")}</div> : null}
      </Window>
      {picking ? (
        <AislePicker
          item={picking}
          used={aisles.data?.used ?? []}
          onClose={() => setPicking(null)}
          onPick={(aisle) => { const id = picking.id; setPicking(null); void api(`/items/${id}`, { method: "PATCH", json: { aisle } }).then(refetch); }}
        />
      ) : null}
    </div>
  );
}

export default defineClient({ widgets: { list: ListWidget }, pages: { shopping: ShoppingPage } });
