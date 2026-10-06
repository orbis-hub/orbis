"use client";

import { Button, cx, Icon } from "@orbis/ui";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { hubFetch, onWsStatus, setToken, wsStatus } from "@/lib/hub";
import { useAuthStatus, useDashboards, useModules, useSettings } from "@/lib/queries";
import { useT } from "@/lib/i18n";
import { useShell } from "@/lib/store";
import { Bell } from "./Bell";

export function Shell({ children, title, actions }: { children: ReactNode; title?: ReactNode; actions?: ReactNode }) {
  const { sidebarOpen, setSidebarOpen, sidebarCollapsed } = useShell();
  const t = useT();
  return (
    <div className={cx("shell", sidebarCollapsed && "collapsed")}>
      {sidebarOpen ? <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} /> : null}
      <Suspense fallback={<aside className="sidebar" />}>
        <Sidebar />
      </Suspense>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header className="topbar">
          <Button icon variant="ghost" className="md:hidden" onClick={() => setSidebarOpen(true)} aria-label={t("shell.menu")} style={{ display: "var(--menu-btn, inline-flex)" }}>
            <Icon name="menu" />
          </Button>
          <h1 className="pixel" style={{ fontSize: 16, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </h1>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flex: "none" }}>
            {actions}
            <Bell />
            <ThemeToggle />
          </div>
        </header>
        <main className="main">{children}</main>
      </div>
      <style>{`@media (min-width: 901px) { .topbar { --menu-btn: none; } }`}</style>
    </div>
  );
}

function Sidebar() {
  const pathname = usePathname();
  const params = useSearchParams();
  const { sidebarOpen, setSidebarOpen, sidebarCollapsed, toggleCollapsed, activeDashboard } = useShell();
  const dashboards = useDashboards();
  const modules = useModules();
  const settings = useSettings();
  const auth = useAuthStatus();
  const t = useT();
  const me = auth.data?.user;
  const [ws, setWs] = useState(wsStatus());
  useEffect(() => onWsStatus(setWs), []);

  const pages = (modules.data ?? [])
    .filter((m) => m.enabled && !m.error && m.manifest.pages.length)
    .flatMap((m) => m.manifest.pages.map((p) => ({ module: m, page: p })));

  const isDash = pathname === "/" || pathname === "";
  const currentDash = params.get("d") ?? activeDashboard ?? dashboards.data?.[0]?.id;
  const close = () => setSidebarOpen(false);

  return (
    <aside className={cx("sidebar", sidebarOpen && "open")}>
      <div className="wordmark">
        <span style={{ color: "var(--accent-ink)" }}>◎</span>
        <span>{sidebarCollapsed ? "" : "orbis"}</span>
        <small>{settings.data?.hubName && settings.data.hubName !== "Orbis" ? settings.data.hubName : ""}</small>
      </div>
      <nav style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div className="nav-group">{t("shell.nav.dashboards")}</div>
        {(dashboards.data ?? []).map((d) => (
          <Link key={d.id} href={`/?d=${d.id}`} className="nav-item" aria-current={isDash && currentDash === d.id ? "page" : undefined} onClick={close} title={d.name}>
            <Icon name={d.icon ?? "home"} className="ico" />
            <span>{d.name}</span>
          </Link>
        ))}
        {pages.length ? <div className="nav-group">{t("shell.nav.modules")}</div> : null}
        {pages.map(({ module, page }) => {
          const href = `/m/?id=${module.id}&page=${page.id}`;
          const active = pathname?.startsWith("/m") && params.get("id") === module.id && (params.get("page") ?? module.manifest.pages[0]?.id) === page.id;
          return (
            <Link key={href} href={href} className="nav-item" aria-current={active ? "page" : undefined} onClick={close} title={page.name}>
              <Icon name={page.icon ?? module.manifest.icon ?? "square"} className="ico" />
              <span>{page.name}</span>
            </Link>
          );
        })}
        <div className="nav-group">{t("shell.nav.system")}</div>
        <NavLink href="/modules/" icon="blocks" label={t("shell.nav.modulesPage")} pathname={pathname} onClick={close} badge={(modules.data ?? []).filter((m) => m.enabled && (m.error || m.status?.state === "warning" || m.status?.state === "error")).length || undefined} />
        <NavLink href="/devices/" icon="wifi" label={t("shell.nav.devices")} pathname={pathname} onClick={close} />
        <NavLink href="/eink/" icon="tv" label={t("shell.nav.eink")} pathname={pathname} onClick={close} />
        <NavLink href="/accounts/" icon="users" label={t("shell.nav.accounts")} pathname={pathname} onClick={close} />
        <NavLink href="/settings/" icon="sliders" label={t("shell.nav.settings")} pathname={pathname} onClick={close} />
      </nav>
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: sidebarCollapsed ? "center" : "space-between" }}>
        {!sidebarCollapsed ? (
          <span className="pixel soft" title={`${me?.name ?? ""} · ${me?.role ?? ""} · ${t("shell.hubConnection", { status: ws })}`} style={{ fontSize: "var(--fs-meta)", display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
            <i className="status-dot" role="img" aria-label={t("shell.hubConnection", { status: ws })} style={{ background: ws === "open" ? "var(--ok)" : ws === "connecting" ? "var(--idle)" : "var(--dnd)", width: 7, height: 7, borderWidth: 0 }} />
            {t("shell.by")}{" "}
            <a href="https://vensin.dev" target="_blank" rel="noreferrer" style={{ color: "var(--accent-2)" }}>
              vensin
            </a>
          </span>
        ) : null}
        <div style={{ display: "flex", gap: 4 }}>
          <Button icon size="sm" variant="ghost" onClick={toggleCollapsed} aria-label={t("shell.collapseSidebar")} className="hide-mobile">
            <Icon name={sidebarCollapsed ? "chevron-right" : "chevron-left"} size={14} />
          </Button>
          <LogoutButton />
        </div>
      </div>
      <style>{`@media (max-width: 900px) { .hide-mobile { display: none; } }`}</style>
    </aside>
  );
}

function NavLink({ href, icon, label, pathname, onClick, badge }: { href: string; icon: string; label: string; pathname: string | null; onClick: () => void; badge?: number }) {
  const t = useT();
  const active = pathname === href || pathname === href.replace(/\/$/, "");
  return (
    <Link href={href} className="nav-item" aria-current={active ? "page" : undefined} onClick={onClick} title={badge ? t("shell.nav.needAttention", { label, count: badge }) : label} style={{ position: "relative" }}>
      <Icon name={icon} className="ico" />
      <span style={{ flex: 1 }}>{label}</span>
      {badge ? <span className="chip chip-warn" style={{ fontSize: "var(--fs-min)", padding: "0 5px", lineHeight: "14px" }}>{badge}</span> : null}
    </Link>
  );
}

export function ThemeToggle() {
  const { theme, setTheme } = useShell();
  const t = useT();
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const label = theme === "system" ? t("shell.theme.auto") : theme === "light" ? t("shell.theme.day") : t("shell.theme.night");
  return (
    <Button size="sm" onClick={() => setTheme(next)} aria-label={t("shell.theme", { theme: label })} title={t("shell.theme", { theme: label })}>
      <Icon name={theme === "system" ? "cloud-sun" : theme === "light" ? "sun" : "moon"} size={14} />
      <span style={{ fontSize: "var(--fs-meta)" }}>{label}</span>
    </Button>
  );
}

function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const t = useT();
  return (
    <Button
      icon
      size="sm"
      variant="ghost"
      aria-label={t("shell.logout")}
      title={t("shell.logout")}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await hubFetch("/api/auth/logout", { method: "POST" });
        } catch {
          /* ignore */
        }
        setToken(null);
        // full reload on purpose: drops every cache, module bundle and the websocket of the old session
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = "/login/";
      }}
    >
      <Icon name="power" size={14} />
    </Button>
  );
}
