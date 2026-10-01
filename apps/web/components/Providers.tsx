"use client";

import { ToastProvider } from "@orbis/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { connectWs, disconnectWs, getHubUrl, HubError, setHubUrl } from "@/lib/hub";
import { installHostBridge } from "@/lib/module-host";
import { useAuthStatus, useHubEventsSync } from "@/lib/queries";
import { applyTheme, useShell } from "@/lib/store";

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (count, err) => !(err instanceof HubError && (err.status === 401 || err.status === 0)) && count < 2,
            refetchOnWindowFocus: true,
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
        <AuthGate>{children}</AuthGate>
      </ToastProvider>
    </QueryClientProvider>
  );
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
  const [hubUrl, setHubUrlState] = useState<string | null | undefined>(undefined);
  useEffect(() => setHubUrlState(getHubUrl()), []);
  const status = useAuthStatus(hubUrl !== undefined && hubUrl !== null);
  const onLogin = pathname?.startsWith("/login");
  useHubEventsSync();

  const authed = !!status.data?.authenticated;
  useEffect(() => {
    if (authed) connectWs();
    else disconnectWs();
  }, [authed]);

  useEffect(() => {
    if (hubUrl === undefined) return;
    if (onLogin) {
      if (authed) router.replace("/");
      return;
    }
    if (hubUrl === null || (status.data && !status.data.authenticated) || (status.error && !status.isFetching)) router.replace("/login/");
  }, [hubUrl, status.data, status.error, status.isFetching, authed, onLogin, router]);

  if (onLogin) return <>{children}</>;
  if (hubUrl && status.error && !status.isFetching && status.error instanceof HubError && status.error.status === 0) {
    return <Unreachable hubUrl={hubUrl} error={status.error.message} onRetry={() => status.refetch()} />;
  }
  if (hubUrl === undefined || status.isPending) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <div className="pixel soft fade-in" style={{ fontSize: 13 }}>
          connecting to hub<span className="blink">…</span>
        </div>
      </div>
    );
  }
  if (!authed) return null;
  return <>{children}</>;
}

function Unreachable({ hubUrl, error, onRetry }: { hubUrl: string; error: string; onRetry: () => void }) {
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16 }}>
      <section className="win fade-in" style={{ maxWidth: 440, width: "100%" }}>
        <div className="win-title">
          <span className="dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span className="title">hub unreachable</span>
        </div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
          <div className="pixel" style={{ fontSize: 15 }}>cannot talk to your hub</div>
          <div>
            tried <code style={{ overflowWrap: "anywhere" }}>{hubUrl}</code>
          </div>
          <div className="soft">{error}</div>
          <ul className="soft" style={{ margin: 0, paddingLeft: 16 }}>
            <li>is the hub running? open <code>{hubUrl}/api/health</code> in a tab.</li>
            <li>same network / vpn as the hub?</li>
            <li>https page but http hub? browsers block that.</li>
          </ul>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              retry
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setHubUrl(null);
                window.location.href = "/login/";
              }}
            >
              change hub url
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
