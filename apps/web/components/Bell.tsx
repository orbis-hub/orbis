"use client";

import type { HubEvent, Notification } from "@orbis/sdk";
import { Button, Icon, useToast } from "@orbis/ui";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { subscribeHub } from "@/lib/hub";
import { useModules, useNotificationMutations, useNotifications } from "@/lib/queries";

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

export function Bell() {
  const q = useNotifications();
  const m = useNotificationMutations();
  const modules = useModules();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = q.data?.unread ?? 0;

  // urgent ones pop up as a toast as well
  useEffect(
    () =>
      subscribeHub((ev: HubEvent) => {
        if (ev.type === "notification" && ev.notification.level === "urgent") toast(`🚨 ${ev.notification.title}`, "bad");
      }),
    [toast],
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
      <Button icon size="sm" variant={unread ? "default" : "ghost"} onClick={() => setOpen((v) => !v)} aria-label={`notifications, ${unread} unread`} style={{ position: "relative" }}>
        <Icon name={unread ? "bell-ring" : "bell"} size={14} />
        {unread ? <span className="chip chip-accent" style={{ position: "absolute", top: -6, right: -6, fontSize: 9, padding: "0 4px", lineHeight: "13px" }}>{unread > 99 ? "99+" : unread}</span> : null}
      </Button>
      {open ? (
        <div className="menu scroll-y" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", width: 340, maxWidth: "calc(100vw - 32px)", maxHeight: 420, padding: 0 }}>
          <div className="win-title" style={{ borderBottom: "1.5px solid var(--line)" }}>
            <span className="title">notifications</span>
            {unread ? (
              <button type="button" className="soft" style={{ fontSize: 11, textDecoration: "underline dotted" }} onClick={() => m.read.mutate("all")}>
                mark all read
              </button>
            ) : items.length ? (
              <button type="button" className="soft" style={{ fontSize: 11, textDecoration: "underline dotted" }} onClick={() => m.clearRead.mutate()}>
                clear
              </button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <div className="empty" style={{ padding: 16 }}>all quiet</div>
          ) : (
            items.map((n: Notification) => {
              const inner = (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px", borderBottom: "1px dashed var(--line)", background: n.readAt ? undefined : "var(--accent-soft)", opacity: n.readAt ? 0.75 : 1 }}>
                  <Icon name={n.icon ?? (n.level === "urgent" ? "warning-diamond" : n.level === "warning" ? "warning-diamond" : "bell")} size={14} style={{ color: n.level === "urgent" ? "var(--dnd)" : n.level === "warning" ? "var(--idle)" : "var(--accent)", flex: "none", marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12 }}>{n.title}</div>
                    {n.body ? <div className="soft" style={{ fontSize: 11, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{n.body}</div> : null}
                    <div className="soft" style={{ fontSize: 10 }}>{name(n.module)} · {ago(n.createdAt)}</div>
                  </div>
                  <button type="button" className="soft" aria-label="dismiss" onClick={(e) => { e.preventDefault(); e.stopPropagation(); m.remove.mutate(n.id); }} style={{ display: "inline-flex", flex: "none" }}>
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
