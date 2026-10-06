"use client";

import type { InstalledModule, WidgetDef } from "@orbis/sdk";
import { Button, Empty, Icon, Input, Modal } from "@orbis/ui";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n";

export function AddWidgetModal({ open, onClose, modules, onPick }: { open: boolean; onClose: () => void; modules: InstalledModule[]; onPick: (mod: InstalledModule, widget: WidgetDef) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const items = useMemo(
    () =>
      modules
        .filter((m) => m.enabled && !m.error)
        .flatMap((m) => m.manifest.widgets.map((w) => ({ m, w })))
        .filter(({ m, w }) => !q || `${m.manifest.name} ${w.name} ${w.description ?? ""}`.toLowerCase().includes(q.toLowerCase())),
    [modules, q],
  );
  return (
    <Modal open={open} onClose={onClose} title={t("dashboard.addWidget")} width={560} closeLabel={t("common.close")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input type="search" placeholder={t("dashboard.searchWidgets")} aria-label={t("dashboard.searchWidgets")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {items.length === 0 ? (
          <Empty icon="blocks" title={t("dashboard.noWidgetsFound")}>
            {modules.length === 0 ? (
              <>
                {t("dashboard.installFirst.before")} <Link href="/modules/">{t("common.modules")}</Link>{t("dashboard.installFirst.after")}
              </>
            ) : (
              t("dashboard.nothingMatches")
            )}
          </Empty>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
            {items.map(({ m, w }) => (
              <button
                key={`${m.id}/${w.id}`}
                type="button"
                className="win win-flat"
                aria-label={t("dashboard.addWidgetNamed", { widget: w.name, module: m.manifest.name })}
                style={{ textAlign: "left", padding: 10, cursor: "pointer", gap: 6 }}
                onClick={() => {
                  onPick(m, w);
                  onClose();
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name={m.manifest.icon ?? "square"} size={16} style={{ color: "var(--accent-ink)" }} />
                  <span className="pixel" style={{ fontSize: 13 }}>
                    {w.name}
                  </span>
                </div>
                <div className="soft" style={{ fontSize: "var(--fs-meta)" }}>
                  {w.description ?? m.manifest.name}
                </div>
                <div className="soft" style={{ fontSize: "var(--fs-meta)", marginTop: "auto" }}>
                  {w.defaultSize.w}×{w.defaultSize.h}
                </div>
              </button>
            ))}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
        </div>
      </div>
    </Modal>
  );
}
