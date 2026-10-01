"use client";

import { Button, cx, Icon } from "@orbis/ui";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { hubFetch, onWsStatus, setToken, wsStatus } from "@/lib/hub";
import { useAuthStatus, useDashboards, useModules, useSettings } from "@/lib/queries";
import { useShell } from "@/lib/store";

export function Shell({ children, title, actions }: { children: ReactNode; title?: ReactNode; actions?: ReactNode }) {
  const { sidebarOpen, setSidebarOpen, sidebarCollapsed } = useShell();
  return (
    <div className={cx("shell", sidebarCollapsed && "collapsed")}>
      {sidebarOpen ? <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} /> : null}
      <Suspense fallback={<aside className="sidebar" />}>
        <Sidebar />
      </Suspense>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header className="topbar">
          <Button icon variant="ghost" className="md:hidden" onClick={() => setSidebarOpen(true)} aria-label="menu" style={{ display: "var(--menu-btn, inline-flex)" }}>
            <Icon name="menu" />
          </Button>
          <h1 className="pixel" style={{ fontSize: 16, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </h1>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {actions}
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
        <span style={{ color: "var(--accent)" }}>◎</span>
        <span>{sidebarCollapsed ? "" : "orbis"}</span>
        <small>{settings.data?.hubName && settings.data.hubName !== "Orbis" ? settings.data.hubName : ""}</small>
      </div>
      <nav style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div className="nav-group">dashboards</div>
        {(dashboards.data ?? []).map((d) => (
          <Link key={d.id} href={`/?d=${d.id}`} className="nav-item" aria-current={isDash && currentDash === d.id ? "page" : undefined} onClick={close} title={d.name}>
            <Icon name={d.icon ?? "home"} className="ico" />
            <span>{d.name}</span>
          </Link>
        ))}
        {pages.length ? <div className="nav-group">modules</div> : null}
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
        <div className="nav-group">system</div>
        <NavLink href="/modules/" icon="blocks" label="modules" pathname={pathname} onClick={close} badge={(modules.data ?? []).filter((m) => m.enabled && (m.error || (m.status && m.status.state !== "ok"))).length || undefined} />
        <NavLink href="/devices/" icon="wifi" label="devices" pathname={pathname} onClick={close} />
        <NavLink href="/accounts/" icon="users" label="accounts" pathname={pathname} onClick={close} />
        <NavLink href="/settings/" icon="sliders" label="settings" pathname={pathname} onClick={close} />
      </nav>
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: sidebarCollapsed ? "center" : "space-between" }}>
        {!sidebarCollapsed ? (
          <span className="pixel soft" title={`${me?.name ?? ""} · ${me?.role ?? ""} · hub connection: ${ws}`} style={{ fontSize: 10, display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
            <i className="status-dot" style={{ background: ws === "open" ? "var(--ok)" : ws === "connecting" ? "var(--idle)" : "var(--dnd)", width: 7, height: 7, borderWidth: 0 }} />
            orbis · by{" "}
            <a href="https://vensin.dev" target="_blank" rel="noreferrer" style={{ color: "var(--accent-2)" }}>
              vensin
            </a>
          </span>
        ) : null}
        <div style={{ display: "flex", gap: 4 }}>
          <Button icon size="sm" variant="ghost" onClick={toggleCollapsed} aria-label="collapse sidebar" className="hide-mobile">
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
  const active = pathname === href || pathname === href.replace(/\/$/, "");
  return (
    <Link href={href} className="nav-item" aria-current={active ? "page" : undefined} onClick={onClick} title={badge ? `${label} · ${badge} need attention` : label} style={{ position: "relative" }}>
      <Icon name={icon} className="ico" />
      <span style={{ flex: 1 }}>{label}</span>
      {badge ? <span className="chip chip-warn" style={{ fontSize: 9, padding: "0 5px", lineHeight: "14px" }}>{badge}</span> : null}
    </Link>
  );
}

export function ThemeToggle() {
  const { theme, setTheme } = useShell();
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const label = theme === "system" ? "auto" : theme === "light" ? "day" : "night";
  return (
    <Button size="sm" onClick={() => setTheme(next)} aria-label={`theme: ${label}`} title={`theme: ${label}`}>
      <Icon name={theme === "system" ? "cloud-sun" : theme === "light" ? "sun" : "moon"} size={14} />
      <span style={{ fontSize: 11 }}>{label}</span>
    </Button>
  );
}

function LogoutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      icon
      size="sm"
      variant="ghost"
      aria-label="log out"
      title="log out"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await hubFetch("/api/auth/logout", { method: "POST" });
        } catch {
          /* ignore */
        }
        setToken(null);
        window.location.href = "/login/";
      }}
    >
      <Icon name="power" size={14} />
    </Button>
  );
}
