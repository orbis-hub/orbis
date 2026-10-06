import { useMemo, useState } from "react";
import { defineClient, useModule, useModuleApi, useModuleQuery, useT, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Icon, Input, Modal, Textarea, useToast } from "@orbis/ui";
import type { PlanEntry, Recipe } from "./server";
import type { Translator } from "@orbis/sdk/client";

type Config = { days?: number; showImages?: boolean };

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const monday = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const dayLabel = (d: Date, i: number, t: Translator, locale: string) => (i === 0 ? t("common.today") : i === 1 ? t("common.tomorrow") : d.toLocaleDateString(locale, { weekday: "long" }).toLowerCase());

function useSlots() {
  return useModuleQuery<string[]>("/slots").data ?? ["lunch", "dinner"];
}
function usePlan(from: Date, to: Date) {
  return useModuleQuery<PlanEntry[]>(`/plan?from=${iso(from)}&to=${iso(to)}`, { refetchOn: ["changed"] });
}

function MealsWidget({ config }: WidgetProps<Config>) {
  const slots = useSlots();
  const t = useT();
  const { locale } = useModule();
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const days = Math.min(config.days ?? 2, 7);
  const q = usePlan(today, addDays(today, days - 1));
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>;
  const entries = q.data ?? [];
  const any = entries.some((e) => e.recipe || e.note);
  if (!any) return <Empty icon="coffee" title={t("widget.meals.empty")}>{t("widget.meals.emptyHint")}</Empty>;
  return (
    <div className="scroll-y" style={{ height: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: days }, (_, i) => {
        const d = addDays(today, i);
        return (
          <div key={i}>
            <div className="soft pixel" style={{ fontSize: 10, marginBottom: 2 }}>{dayLabel(d, i, t, locale)}</div>
            {slots.map((s) => {
              const e = entries.find((x) => x.day === iso(d) && x.slot === s);
              return (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
                  {config.showImages !== false && e?.recipe?.image ? <img src={e.recipe.image} alt="" style={{ width: 28, height: 28, objectFit: "cover", border: "1.5px solid var(--line)", imageRendering: "auto" }} /> : <span className="soft" style={{ width: 28, textAlign: "center" }}><Icon name="coffee" size={12} /></span>}
                  <span className="soft" style={{ fontSize: 10, width: 48 }}>{s}</span>
                  <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: e?.recipe || e?.note ? 1 : 0.4 }}>{e?.recipe?.title ?? e?.note ?? "–"}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** pick a recipe (or type a free note) for one slot */
function SlotPicker({ day, slot, current, recipes, onClose }: { day: string; slot: string; current: PlanEntry | undefined; recipes: Recipe[]; onClose: () => void }) {
  const api = useModuleApi();
  const t = useT();
  const { locale } = useModule();
  const [q, setQ] = useState("");
  const [note, setNote] = useState(current?.note ?? "");
  const set = async (recipeId: string | null, n?: string | null) => {
    await api("/plan", { method: "PUT", json: { day, slot, recipeId, note: n ?? null } });
    onClose();
  };
  const list = recipes.filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase()) || r.tags.some((tag) => tag.includes(q.toLowerCase())));
  return (
    <Modal open onClose={onClose} title={`${slot} · ${new Date(day).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })}`} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("picker.searchRecipes")} />
        <div className="scroll-y" style={{ maxHeight: 260, display: "flex", flexDirection: "column", gap: 2 }}>
          {list.length === 0 ? <span className="soft" style={{ fontSize: 12 }}>{t("picker.noRecipes")}</span> : null}
          {list.map((r) => (
            <button key={r.id} type="button" className="menu-item" onClick={() => void set(r.id)} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {r.image ? <img src={r.image} alt="" style={{ width: 24, height: 24, objectFit: "cover" }} /> : <Icon name="coffee" size={12} />}
              <span style={{ flex: 1, textAlign: "left" }}>{r.title}</span>
              {r.servings ? <span className="soft" style={{ fontSize: 10 }}>{r.servings}</span> : null}
            </button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); void set(null, note.trim() || null); }} style={{ display: "flex", gap: 6 }}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("picker.notePlaceholder")} />
          <Button type="submit" size="sm">{t("picker.set")}</Button>
        </form>
        {current?.recipe || current?.note ? <Button size="sm" variant="ghost" onClick={() => void set(null, null)}><Icon name="close" size={12} /> {t("picker.clearSlot")}</Button> : null}
      </div>
    </Modal>
  );
}

function RecipeModal({ recipe, onClose, onDelete }: { recipe: Recipe; onClose: () => void; onDelete: () => void }) {
  const api = useModuleApi();
  const t = useT();
  const toast = useToast();
  const avail = useModuleQuery<{ available: boolean }>("/shopping-available").data?.available;
  const toShopping = async () => {
    const r = await api<{ added: number; list: string }>("/plan/to-shopping", { method: "POST", json: { recipeIds: [recipe.id] } });
    toast(t("recipe.addedToast", { count: r.added, list: r.list }));
  };
  return (
    <Modal open onClose={onClose} title={recipe.title} width={560} right={recipe.url ? <a className="btn btn-sm" href={recipe.url} target="_blank" rel="noreferrer"><Icon name="external-link" size={12} /> {t("recipe.source")}</a> : null}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {recipe.image ? <img src={recipe.image} alt="" style={{ width: "100%", maxHeight: 200, objectFit: "cover", border: "1.5px solid var(--line)" }} /> : null}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {recipe.servings ? <Chip>{recipe.servings}</Chip> : null}
          {recipe.tags.map((tag) => <Chip key={tag}>{tag}</Chip>)}
        </div>
        {recipe.ingredients.length ? (
          <div>
            <div className="pixel" style={{ fontSize: 12, marginBottom: 4 }}>{t("recipe.ingredients")}</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{recipe.ingredients.map((i, n) => <li key={n}>{i}</li>)}</ul>
          </div>
        ) : null}
        {recipe.steps.length ? (
          <div>
            <div className="pixel" style={{ fontSize: 12, marginBottom: 4 }}>{t("recipe.steps")}</div>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{recipe.steps.map((s, n) => <li key={n} style={{ marginBottom: 4 }}>{s}</li>)}</ol>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 6, justifyContent: "space-between" }}>
          <Button size="sm" variant="ghost" onClick={onDelete}><Icon name="trash" size={12} /> {t("common.delete")}</Button>
          {avail && recipe.ingredients.length ? <Button size="sm" onClick={() => void toShopping()}><Icon name="shopping-bag" size={12} /> {t("recipe.toShopping")}</Button> : null}
        </div>
      </div>
    </Modal>
  );
}

function NewRecipe({ onDone }: { onDone: () => void }) {
  const api = useModuleApi();
  const t = useT();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [title, setTitle] = useState("");
  const [ings, setIngs] = useState("");
  const importUrl = async () => {
    setBusy(true);
    try {
      const r = await api<Recipe>("/import", { method: "POST", json: { url } });
      toast(r.ingredients.length ? t("new.importedToast", { title: r.title, count: r.ingredients.length }) : t("new.importedNoneToast", { title: r.title }));
      setUrl("");
      onDone();
    } catch (err) {
      toast((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    await api("/recipes", { method: "POST", json: { title, ingredients: ings.split("\n").map((x) => x.trim()).filter(Boolean) } });
    setTitle("");
    setIngs("");
    setManual(false);
    onDone();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <form onSubmit={(e) => { e.preventDefault(); void importUrl(); }} style={{ display: "flex", gap: 6 }}>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("new.urlPlaceholder")} />
        <Button type="submit" size="sm" loading={busy} disabled={!url.trim()}><Icon name="download" size={12} /> {t("new.import")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setManual((m) => !m)}>{manual ? t("common.cancel") : t("new.byHand")}</Button>
      </form>
      {manual ? (
        <form onSubmit={(e) => { e.preventDefault(); void create(); }} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("new.titlePlaceholder")} />
          <Textarea value={ings} onChange={(e) => setIngs(e.target.value)} rows={4} placeholder={t("new.ingredientsPlaceholder")} />
          <Button type="submit" size="sm" disabled={!title.trim()}>{t("new.save")}</Button>
        </form>
      ) : null}
    </div>
  );
}

function PlanPage(_p: PageProps) {
  const api = useModuleApi();
  const t = useT();
  const { locale } = useModule();
  const toast = useToast();
  const slots = useSlots();
  const [weekOffset, setWeekOffset] = useState(0);
  const start = useMemo(() => addDays(monday(new Date()), weekOffset * 7), [weekOffset]);
  const end = addDays(start, 6);
  const plan = usePlan(start, end);
  const recipes = useModuleQuery<Recipe[]>("/recipes", { refetchOn: ["changed"] });
  const avail = useModuleQuery<{ available: boolean }>("/shopping-available").data?.available;
  const [pick, setPick] = useState<{ day: string; slot: string } | null>(null);
  const [open, setOpen] = useState<Recipe | null>(null);
  const [filter, setFilter] = useState("");
  const todayIso = iso(new Date());
  const weekToShopping = async () => {
    const r = await api<{ added: number; list: string }>("/plan/to-shopping", { method: "POST", json: { from: iso(start), to: iso(end) } });
    toast(r.added ? t("recipe.addedToast", { count: r.added, list: r.list }) : t("page.plan.nothingToAdd"));
  };
  const list = (recipes.data ?? []).filter((r) => !filter || r.title.toLowerCase().includes(filter.toLowerCase()) || r.tags.some((tag) => tag.includes(filter.toLowerCase())));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="win">
        <div className="win-title">
          <span className="dots"><i /><i /><i /></span>
          <span className="title">{t("page.plan.weekOf", { date: start.toLocaleDateString(locale, { day: "numeric", month: "short" }) })}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <Button size="sm" onClick={() => setWeekOffset((w) => w - 1)} aria-label={t("page.plan.prevWeek")}><Icon name="chevron-left" size={12} /></Button>
            <Button size="sm" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>{t("page.plan.thisWeek")}</Button>
            <Button size="sm" onClick={() => setWeekOffset((w) => w + 1)} aria-label={t("page.plan.nextWeek")}><Icon name="chevron-right" size={12} /></Button>
            {avail ? <Button size="sm" onClick={() => void weekToShopping()} title={t("page.plan.weekToShoppingTitle")}><Icon name="shopping-bag" size={12} /> {t("page.plan.toShopping")}</Button> : null}
          </span>
        </div>
        <div className="win-body" style={{ overflowX: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: `64px repeat(7, minmax(110px, 1fr))`, gap: 4, minWidth: 820 }}>
            <div />
            {Array.from({ length: 7 }, (_, i) => {
              const d = addDays(start, i);
              const isToday = iso(d) === todayIso;
              return <div key={i} className="pixel" style={{ fontSize: 11, textAlign: "center", color: isToday ? "var(--accent)" : undefined }}>{d.toLocaleDateString(locale, { weekday: "short" })} {d.getDate()}</div>;
            })}
            {slots.map((s) => (
              <SlotRow key={s} slot={s} start={start} entries={plan.data ?? []} todayIso={todayIso} onPick={(day) => setPick({ day, slot: s })} onOpen={(id) => setOpen((recipes.data ?? []).find((r) => r.id === id) ?? null)} />
            ))}
          </div>
        </div>
      </div>

      <div className="win">
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">{t("page.plan.recipes", { count: recipes.data?.length ?? 0 })}</span><Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("page.plan.filter")} style={{ marginLeft: "auto", width: 160, padding: "2px 6px", fontSize: 12 }} /></div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <NewRecipe onDone={() => void recipes.refetch()} />
          {list.length === 0 ? <span className="soft" style={{ fontSize: 12 }}>{t("page.plan.noRecipes")}</span> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
              {list.map((r) => (
                <button key={r.id} type="button" className="win" style={{ textAlign: "left", cursor: "pointer", padding: 0, overflow: "hidden" }} onClick={() => setOpen(r)}>
                  {r.image ? <img src={r.image} alt="" style={{ width: "100%", height: 90, objectFit: "cover", display: "block" }} /> : <div style={{ height: 40, display: "grid", placeItems: "center", background: "var(--paper-2)" }}><Icon name="coffee" size={16} /></div>}
                  <div style={{ padding: "6px 8px" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
                    <div className="soft" style={{ fontSize: 10 }}>{t("recipe.ingredientsCount", { count: r.ingredients.length })}{r.servings ? ` · ${r.servings}` : ""}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {pick ? <SlotPicker day={pick.day} slot={pick.slot} current={(plan.data ?? []).find((e) => e.day === pick.day && e.slot === pick.slot)} recipes={recipes.data ?? []} onClose={() => setPick(null)} /> : null}
      {open ? <RecipeModal recipe={open} onClose={() => setOpen(null)} onDelete={() => { void api(`/recipes/${open.id}`, { method: "DELETE" }).then(() => { setOpen(null); void recipes.refetch(); }); }} /> : null}
    </div>
  );
}

function SlotRow({ slot, start, entries, todayIso, onPick, onOpen }: { slot: string; start: Date; entries: PlanEntry[]; todayIso: string; onPick: (day: string) => void; onOpen: (recipeId: string) => void }) {
  const t = useT();
  return (
    <>
      <div className="soft pixel" style={{ fontSize: 11, alignSelf: "center" }}>{slot}</div>
      {Array.from({ length: 7 }, (_, i) => {
        const day = iso(addDays(start, i));
        const e = entries.find((x) => x.day === day && x.slot === slot);
        const past = day < todayIso;
        return (
          <div key={i} className="win" style={{ minHeight: 64, padding: 6, display: "flex", flexDirection: "column", gap: 4, opacity: past ? 0.6 : 1, borderStyle: e?.recipe || e?.note ? "solid" : "dashed", cursor: "pointer" }} onClick={() => onPick(day)} role="button" tabIndex={0} onKeyDown={(ev) => ev.key === "Enter" && onPick(day)}>
            {e?.recipe ? (
              <>
                {e.recipe.image ? <img src={e.recipe.image} alt="" style={{ width: "100%", height: 36, objectFit: "cover" }} /> : null}
                <span style={{ fontSize: 12, lineHeight: 1.2, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }} onClick={(ev) => { ev.stopPropagation(); onOpen(e.recipe!.id); }} title={t("recipe.open")}>{e.recipe.title}</span>
              </>
            ) : e?.note ? <span style={{ fontSize: 12, fontStyle: "italic" }}>{e.note}</span> : <span className="soft" style={{ fontSize: 11, margin: "auto" }}>+</span>}
          </div>
        );
      })}
    </>
  );
}

export default defineClient({
  widgets: { meals: MealsWidget },
  pages: { plan: PlanPage },
});
