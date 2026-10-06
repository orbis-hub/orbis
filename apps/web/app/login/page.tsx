"use client";

import { Button, Field, Input, useStableId, Window } from "@orbis/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { safeNext } from "@/components/Providers";
import { getHubUrl, hubFetch, HubError, isCapacitor, setHubUrl, setToken } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import { qk, useAuthStatus } from "@/lib/queries";

type Step = "hub" | "setup" | "login";

/** useSearchParams needs a suspense boundary in the static export */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <Login />
    </Suspense>
  );
}

function Login() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useSearchParams();
  // where to go after signing in: `?next=/some/page` (set when a session expired), otherwise the dashboard
  const next = safeNext(params.get("next")) ?? "/";
  // read once on the client; the static export prerenders with `undefined`
  const [hub, setHub] = useState<string | null | undefined>(() => (typeof window === "undefined" ? undefined : getHubUrl()));
  const [hubInput, setHubInput] = useState(() => (typeof window === "undefined" ? "http://" : (getHubUrl() ?? "http://")));
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();
  const ids = { hub: useStableId("login-hub"), name: useStableId("login-name"), pw: useStableId("login-pw"), pw2: useStableId("login-pw2") };

  const status = useAuthStatus(!!hub);
  // the step is derived from what we know, never synced into state
  const step: Step = !hub ? "hub" : status.data ? (status.data.setup ? "login" : "setup") : "hub";
  const statusError = hub && status.error ? (status.error instanceof HubError ? status.error.message : t("login.error.unreachable")) : null;
  const error = formError ?? statusError;

  // already signed in (e.g. opened /login by hand): AuthGate sends us on; nothing to render meanwhile
  const authed = !!status.data?.authenticated;

  async function saveHub(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    let url = hubInput.trim();
    if (!/^https?:\/\//.test(url)) url = `http://${url}`;
    url = url.replace(/\/+$/, "");
    setBusy(true);
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHubUrl(url);
      setHub(url);
      await qc.invalidateQueries();
    } catch (err) {
      setFormError(t("login.connect.failed", { url, error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    // same rules as the hub (routes/auth.ts): name 1–64 characters after trimming, password at least 6
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 64) return setFormError(t("login.error.name"));
    if (step === "setup" && password.length < 6) return setFormError(t("login.error.short"));
    if (step === "setup" && password !== password2) return setFormError(t("login.error.mismatch"));
    setBusy(true);
    try {
      const res = await hubFetch<{ token: string }>(step === "setup" ? "/api/auth/setup" : "/api/auth/login", { method: "POST", json: { name: trimmed, password } });
      setToken(res.token);
      // a fresh session: nothing fetched before it (possibly by another user) may survive
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.auth[0] });
      await qc.invalidateQueries({ queryKey: qk.auth });
      router.replace(next);
    } catch (err) {
      const msg = err instanceof HubError ? err.message : "";
      setFormError(msg === "wrong name or password" ? t("login.error.wrong") : msg === "invalid input" ? t("login.error.invalid") : msg || t("login.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const changeHub = () => {
    setHubUrl(null);
    setHub(null);
    setFormError(null);
  };

  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 380 }} className="fade-in">
        <div className="wordmark" style={{ justifyContent: "center", fontSize: 28, marginBottom: 16 }}>
          <span style={{ color: "var(--accent)" }}>◎</span> orbis
        </div>
        {hub === undefined || authed ? null : step === "hub" && !hub ? (
          <Window title={t("login.connect.title")}>
            <form onSubmit={saveHub} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p className="soft" style={{ fontSize: 12 }}>
                {isCapacitor() ? t("login.connect.introApp") : t("login.connect.introWeb")}
              </p>
              <Field label={t("login.connect.hubUrl")} hint={t("login.connect.hubUrlHint")} htmlFor={ids.hub}>
                <Input id={ids.hub} value={hubInput} onChange={(e) => setHubInput(e.target.value)} placeholder="http://192.168.1.20:3001" autoFocus inputMode="url" autoComplete="url" />
              </Field>
              {error ? (
                <div role="alert" style={{ color: "var(--dnd)", fontSize: 12 }}>
                  {error}
                </div>
              ) : null}
              <Button type="submit" variant="primary" loading={busy}>
                {t("login.connect.button")}
              </Button>
            </form>
          </Window>
        ) : !status.data ? (
          <Window title={t("login.connecting.title")}>
            <div className="pixel soft" style={{ fontSize: 13 }} aria-live="polite">
              {t("login.connecting.talkingTo", { hub })}
              <span className="blink">…</span>
            </div>
            {error ? (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <div role="alert" style={{ color: "var(--dnd)", fontSize: 12 }}>
                  {error}
                </div>
                <Button size="sm" onClick={changeHub}>
                  {t("login.changeHub")}
                </Button>
              </div>
            ) : null}
          </Window>
        ) : (
          <Window title={step === "setup" ? t("login.setup.title") : t("login.signin.title")} right={<span className="chip" style={{ fontSize: 10 }}>{(hub ?? "").replace(/^https?:\/\//, "")}</span>}>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {step === "setup" ? (
                <p className="soft" style={{ fontSize: 12 }}>
                  {t("login.setup.intro")}
                </p>
              ) : null}
              {next !== "/" ? (
                <p className="soft" style={{ fontSize: 11 }}>
                  {t("login.nextHint", { path: next })}
                </p>
              ) : null}
              <Field label={t("login.name")} htmlFor={ids.name} hint={step === "setup" ? t("login.nameHint") : undefined}>
                <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoFocus required maxLength={64} />
              </Field>
              <Field label={t("login.password")} htmlFor={ids.pw} hint={step === "setup" ? t("login.passwordHint") : undefined}>
                <Input id={ids.pw} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={step === "setup" ? "new-password" : "current-password"} required minLength={step === "setup" ? 6 : undefined} />
              </Field>
              {step === "setup" ? (
                <Field label={t("login.repeatPassword")} htmlFor={ids.pw2}>
                  <Input id={ids.pw2} type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required minLength={6} />
                </Field>
              ) : null}
              {error ? (
                <div role="alert" style={{ color: "var(--dnd)", fontSize: 12 }}>
                  {error}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
                <button type="button" className="soft" style={{ fontSize: 11, textDecoration: "underline dotted" }} onClick={changeHub}>
                  {t("login.otherHub")}
                </button>
                <Button type="submit" variant="primary" loading={busy}>
                  {step === "setup" ? t("login.setup.button") : t("login.signin.button")}
                </Button>
              </div>
            </form>
          </Window>
        )}
      </div>
    </div>
  );
}
