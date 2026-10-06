"use client";

import type { HubEvent, Notification } from "@orbis/sdk";
import { Button, Icon, useToast } from "@orbis/ui";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { subscribeHub } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import { useAuthStatus, useModules, useNotificationMutations, useNotifications } from "@/lib/queries";

type T = ReturnType<typeof useT>;

const ago = (iso: string, t: T) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? t("notifications.ago.now") : m < 60 ? t("notifications.ago.min", { count: m }) : m < 1440 ? t("notifications.ago.h", { count: Math.round(m / 60) }) : t("notifications.ago.d", { count: Math.round(m / 1440) });
};

export function Bell() {
  const t = useT();
  const q = useNotifications();
  const m = useNotificationMutations();
  const modules = useModules();
  const toast = useToast();
  const me = useAuthStatus().data?.user?.id;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = q.data?.unread ?? 0;

  // urgent ones pop up as a toast as well; notifications addressed to another account are not ours
  useEffect(
    () =>
      subscribeHub((ev: HubEvent) => {
        if (ev.type !== "notification") return;
        if (ev.notification.userId && ev.notification.userId !== me) return;
        if (ev.notification.level === "urgent") toast(t("notifications.urgent", { title: ev.notification.title }), "bad");
      }),
    [toast, t, me],
  );
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const name = (id: string) => modules.data?.find((x) => x.id === id)?.manifest.name ?? id;
  const items = q.data?.items ?? [];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Button icon size="sm" variant={unread ? "default" : "ghost"} onClick={() => setOpen((v) => !v)} aria-label={t("notifications.aria", { count: unread })} style={{ position: "relative" }}>
        <Icon name={unread ? "bell-ring" : "bell"} size={14} />
        {unread ? <span className="chip chip-accent" style={{ position: "absolute", top: -6, right: -6, fontSize: 9, padding: "0 4px", lineHeight: "13px" }}>{unread > 99 ? "99+" : unread}</span> : null}
      </Button>
      {open ? (
        <div className="menu scroll-y" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", width: 340, maxWidth: "calc(100vw - 32px)", maxHeight: 420, padding: 0 }}>
          <div className="win-title" style={{ borderBottom: "1.5px solid var(--line)" }}>
            <span className="title">{t("notifications.title")}</span>
            {unread ? (
              <button type="button" className="soft" style={{ fontSize: 11, textDecoration: "underline dotted" }} onClick={() => m.read.mutate("all")}>
                {t("notifications.markAllRead")}
              </button>
            ) : items.length ? (
              <button type="button" className="soft" style={{ fontSize: 11, textDecoration: "underline dotted" }} onClick={() => m.clearRead.mutate()}>
                {t("notifications.clear")}
              </button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <div className="empty" style={{ padding: 16 }}>{t("notifications.quiet")}</div>
          ) : (
            items.map((n: Notification) => {
              const inner = (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px", borderBottom: "1px dashed var(--line)", background: n.readAt ? undefined : "var(--accent-soft)", opacity: n.readAt ? 0.75 : 1 }}>
                  <Icon name={n.icon ?? (n.level === "urgent" ? "warning-diamond" : n.level === "warning" ? "warning-diamond" : "bell")} size={14} style={{ color: n.level === "urgent" ? "var(--dnd)" : n.level === "warning" ? "var(--idle)" : "var(--accent)", flex: "none", marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12 }}>{n.title}</div>
                    {n.body ? <div className="soft" style={{ fontSize: 11, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{n.body}</div> : null}
                    <div className="soft" style={{ fontSize: 10 }}>{name(n.module)} · {ago(n.createdAt, t)}</div>
                  </div>
                  <button type="button" className="soft" aria-label={t("notifications.dismiss")} onClick={(e) => { e.preventDefault(); e.stopPropagation(); m.remove.mutate(n.id); }} style={{ display: "inline-flex", flex: "none" }}>
                    <Icon name="close" size={11} />
                  </button>
                </div>
              );
              const onOpen = () => {
                if (!n.readAt) m.read.mutate([n.id]);
                setOpen(false);
              };
              return n.url ? (
                n.url.startsWith("/") ? (
                  <Link key={n.id} href={n.url} onClick={onOpen} style={{ textDecoration: "none", color: "inherit", display: "block" }}>{inner}</Link>
                ) : (
                  <a key={n.id} href={n.url} target="_blank" rel="noreferrer" onClick={onOpen} style={{ textDecoration: "none", color: "inherit", display: "block" }}>{inner}</a>
                )
              ) : (
                <div key={n.id} onClick={onOpen} style={{ cursor: "pointer" }}>{inner}</div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
