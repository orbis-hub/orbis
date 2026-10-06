"use client";

import { ToastProvider, useToast } from "@orbis/ui";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { connectWs, disconnectWs, getHubUrl, HubError, isUnauthorized, onUnauthorized, setHubUrl, setToken } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import { installHostBridge } from "@/lib/module-host";
import { qk, useAuthStatus, useHubEventsSync } from "@/lib/queries";
import { applyTheme, useShell } from "@/lib/store";
import { ConfirmProvider } from "./Confirm";

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (count, err) => !(err instanceof HubError && (err.status === 401 || err.status === 0)) && count < 2,
            // a lost session must not keep polling: every refetch would be another 401 (polling queries check the same)
            refetchOnWindowFocus: (query) => !isUnauthorized(query.state.error),
          },
        },
      }),
  );
  useEffect(() => {
    installHostBridge();
    applyTheme(useShell.getState().theme);
  }, []);
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <AuthGate>{children}</AuthGate>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

/** `?next=` must stay inside the app: a relative path, never a different origin */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/login")) return null;
  return raw;
}

/** where to send the user after signing in again: the page they were on, with its query string */
function currentPath() {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Decides between onboarding/login and the app. Everything is client side (static export):
 *  - no hub url known (Capacitor first start) → /login (hub url step)
 *  - hub reachable but not set up / not authenticated → /login
 *  - authenticated → children, plus the websocket
 */
function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  // read once on the client; the static export prerenders with `undefined` ("connecting"), the client picks up the stored url on hydration
  const [hubUrl] = useState<string | null | undefined>(() => (typeof window === "undefined" ? undefined : getHubUrl()));
  const status = useAuthStatus(hubUrl !== undefined && hubUrl !== null);
  const onLogin = pathname?.startsWith("/login");
  const t = useT();
  const qc = useQueryClient();
  useHubEventsSync();

  const authed = !!status.data?.authenticated;
  useEffect(() => {
    if (authed) connectWs();
    else disconnectWs();
  }, [authed]);

  // the status poll itself can be the first to notice (refetch on focus): authenticated → not authenticated
  const wasAuthed = useRef(false);
  useEffect(() => {
    if (authed) wasAuthed.current = true;
    else if (wasAuthed.current && status.data) {
      wasAuthed.current = false;
      setToken(null);
      toast(t("shell.sessionExpired"), "warn");
    }
  }, [authed, status.data, toast, t]);

  // session lost (first 401 from any api call, or ws close 4401): drop the token, forget everything we
  // fetched with it, tell the user once and go to the login page with a way back
  useEffect(
    () =>
      onUnauthorized(() => {
        wasAuthed.current = false; // this handler tells the user; the status transition below must not repeat it
        setToken(null);
        void qc.cancelQueries();
        void qc.invalidateQueries({ queryKey: qk.auth }); // → authenticated: false → the gate unmounts the app
        if (window.location.pathname.startsWith("/login")) return;
        toast(t("shell.sessionExpired"), "warn");
        router.replace(`/login/?next=${encodeURIComponent(currentPath())}`);
      }),
    [router, toast, t, qc],
  );

  useEffect(() => {
    if (hubUrl === undefined) return;
    if (onLogin) {
      if (authed) router.replace(safeNext(new URLSearchParams(window.location.search).get("next")) ?? "/");
      return;
    }
    if (hubUrl === null || (status.data && !status.data.authenticated) || (status.error && !status.isFetching)) {
      const next = hubUrl === null ? null : safeNext(currentPath());
      router.replace(next && next !== "/" ? `/login/?next=${encodeURIComponent(next)}` : "/login/");
    }
  }, [hubUrl, status.data, status.error, status.isFetching, authed, onLogin, router]);

  if (onLogin) return <>{children}</>;
  if (hubUrl && status.error && !status.isFetching && status.error instanceof HubError && status.error.status === 0) {
    return <Unreachable hubUrl={hubUrl} error={status.error.message} onRetry={() => status.refetch()} />;
  }
  if (hubUrl === undefined || status.isPending) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <div className="pixel soft fade-in" style={{ fontSize: 13 }}>
          {t("shell.connecting")}<span className="blink">…</span>
        </div>
      </div>
    );
  }
  if (!authed) return null;
  return <>{children}</>;
}

function Unreachable({ hubUrl, error, onRetry }: { hubUrl: string; error: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16 }}>
      <section className="win fade-in" style={{ maxWidth: 440, width: "100%" }}>
        <div className="win-title">
          <span className="dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span className="title">{t("shell.unreachable.title")}</span>
        </div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
          <div className="pixel" style={{ fontSize: 15 }}>{t("shell.unreachable.headline")}</div>
          <div>
            {t("shell.unreachable.tried")} <code style={{ overflowWrap: "anywhere" }}>{hubUrl}</code>
          </div>
          <div className="soft">{error}</div>
          <ul className="soft" style={{ margin: 0, paddingLeft: 16 }}>
            <li>{t("shell.unreachable.hint1", { url: `${hubUrl}/api/health` })}</li>
            <li>{t("shell.unreachable.hint2")}</li>
            <li>{t("shell.unreachable.hint3")}</li>
          </ul>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              {t("shell.unreachable.retry")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setHubUrl(null);
                // full reload on purpose: a different hub means fresh module bundles, caches and websocket
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.href = "/login/";
              }}
            >
              {t("shell.unreachable.changeHub")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
