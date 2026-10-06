"use client";

import { Icon, cx } from "@orbis/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Grid } from "@/components/dashboard/DashboardView";
import { useT } from "@/lib/i18n";
import { useDashboards, useModules } from "@/lib/queries";

/**
 * /kiosk/?d=<dashboardId>&rotate=<seconds>&dark=1
 * full-screen dashboard for a wall tablet: no sidebar, no edit controls, screen wake lock,
 * optional rotation through all dashboards, reload once a day so a long-running tab picks up updates.
 */
export default function KioskPage() {
  return (
    <Suspense fallback={null}>
      <Kiosk />
    </Suspense>
  );
}

function Kiosk() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const dashboards = useDashboards();
  const modules = useModules();
  const list = dashboards.data ?? [];
  const requested = params.get("d");
  const rotate = Number(params.get("rotate") ?? 0);
  const [idx, setIdx] = useState(0);
  const dash = requested && !rotate ? list.find((d) => d.id === requested) : list[idx % Math.max(1, list.length)];
  const modMap = useMemo(() => new Map((modules.data ?? []).map((x) => [x.id, x])), [modules.data]);
  const [chrome, setChrome] = useState(true);

  // kiosk flag on <html> for bigger touch targets, dark override
  useEffect(() => {
    document.documentElement.setAttribute("data-kiosk", "1");
    if (params.get("dark") === "1") document.documentElement.setAttribute("data-theme", "dark");
    if (params.get("light") === "1") document.documentElement.setAttribute("data-theme", "light");
    return () => document.documentElement.removeAttribute("data-kiosk");
  }, [params]);

  // keep the screen on
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const request = async () => {
      try {
        lock = await (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen") ?? null;
      } catch {
        /* not allowed, fine */
      }
    };
    void request();
    const onVis = () => document.visibilityState === "visible" && void request();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release();
    };
  }, []);

  // rotate dashboards
  useEffect(() => {
    if (!rotate || list.length < 2) return;
    const timer = setInterval(() => setIdx((i) => i + 1), Math.max(10, rotate) * 1000);
    return () => clearInterval(timer);
  }, [rotate, list.length]);

  // daily reload + hide the little toolbar after a while
  useEffect(() => {
    const reload = setTimeout(() => window.location.reload(), 24 * 3600_000);
    const hide = setTimeout(() => setChrome(false), 6000);
    const show = () => {
      setChrome(true);
      clearTimeout(hide);
      setTimeout(() => setChrome(false), 6000);
    };
    window.addEventListener("pointerdown", show);
    return () => {
      clearTimeout(reload);
      clearTimeout(hide);
      window.removeEventListener("pointerdown", show);
    };
  }, []);

  return (
    <div style={{ minHeight: "100dvh", padding: 12 }}>
      <div className={cx("kiosk-bar", !chrome && "hidden")} style={{ position: "fixed", top: 8, right: 8, display: "flex", gap: 6, zIndex: 50, transition: "opacity 0.3s steps(3)", opacity: chrome ? 1 : 0, pointerEvents: chrome ? "auto" : "none" }}>
        {list.length > 1 ? (
          <select className="input" aria-label={t("common.dashboard")} style={{ width: "auto", padding: "2px 24px 2px 6px", fontSize: 12 }} value={dash?.id ?? ""} onChange={(e) => router.replace(`/kiosk/?d=${e.target.value}`)}>
            {list.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        ) : null}
        <button type="button" className="btn btn-sm" onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()} aria-label={t("kiosk.fullscreen")}>
          <Icon name="frame" size={12} />
        </button>
        <Link className="btn btn-sm" href="/" aria-label={t("kiosk.leave")} title={t("kiosk.leave")}>
          <Icon name="close" size={12} />
        </Link>
      </div>
      {dash ? (
        <Grid dash={dash} modMap={modMap} editing={false} onConfigure={() => {}} onRemove={() => {}} onLayout={() => {}} />
      ) : dashboards.isPending ? null : (
        <div className="empty">{t("kiosk.noDashboard.before")} <code>?d=&lt;id&gt;</code> {t("kiosk.noDashboard.after")}</div>
      )}
    </div>
  );
}
