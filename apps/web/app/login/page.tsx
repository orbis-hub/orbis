"use client";

import { Button, Field, Input, Window } from "@orbis/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { getHubUrl, hubFetch, HubError, isCapacitor, setHubUrl, setToken } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import { useAuthStatus } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";

type Step = "hub" | "setup" | "login";

export default function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [hub, setHub] = useState<string | null | undefined>(undefined);
  const [hubInput, setHubInput] = useState("");
  const [step, setStep] = useState<Step>("hub");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();

  useEffect(() => {
    const h = getHubUrl();
    setHub(h);
    setHubInput(h ?? "http://");
  }, []);

  const status = useAuthStatus(!!hub);
  useEffect(() => {
    if (!hub) {
      setStep("hub");
      return;
    }
    if (status.data) {
      if (status.data.authenticated) router.replace("/");
      else setStep(status.data.setup ? "login" : "setup");
    }
    if (status.error) setError(status.error instanceof HubError ? status.error.message : t("login.error.unreachable"));
  }, [hub, status.data, status.error, router, t]);

  async function saveHub(e: FormEvent) {
    e.preventDefault();
    setError(null);
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
      setError(t("login.connect.failed", { url, error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (step === "setup" && password.length < 6) return setError(t("login.error.short"));
    if (step === "setup" && password !== password2) return setError(t("login.error.mismatch"));
    setBusy(true);
    try {
      const res = await hubFetch<{ token: string }>(step === "setup" ? "/api/auth/setup" : "/api/auth/login", { method: "POST", json: { name, password } });
      setToken(res.token);
      await qc.invalidateQueries();
      router.replace("/");
    } catch (err) {
      const msg = err instanceof HubError ? err.message : "";
      setError(msg === "wrong name or password" ? t("login.error.wrong") : msg || t("login.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 380 }} className="fade-in">
        <div className="wordmark" style={{ justifyContent: "center", fontSize: 28, marginBottom: 16 }}>
          <span style={{ color: "var(--accent)" }}>◎</span> orbis
        </div>
        {step === "hub" || hub === null ? (
          <Window title={t("login.connect.title")}>
            <form onSubmit={saveHub} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p className="soft" style={{ fontSize: 12 }}>
                {isCapacitor() ? t("login.connect.introApp") : t("login.connect.introWeb")}
              </p>
              <Field label={t("login.connect.hubUrl")} hint={t("login.connect.hubUrlHint")}>
                <Input value={hubInput} onChange={(e) => setHubInput(e.target.value)} placeholder="http://192.168.1.20:3001" autoFocus inputMode="url" />
              </Field>
              {error ? <div style={{ color: "var(--dnd)", fontSize: 12 }}>{error}</div> : null}
              <Button type="submit" variant="primary" loading={busy}>
                {t("login.connect.button")}
              </Button>
            </form>
          </Window>
        ) : status.isPending && !status.data ? (
          <Window title={t("login.connecting.title")}>
            <div className="pixel soft" style={{ fontSize: 13 }}>
              {t("login.connecting.talkingTo", { hub })}
              <span className="blink">…</span>
            </div>
            {error ? (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ color: "var(--dnd)", fontSize: 12 }}>{error}</div>
                <Button size="sm" onClick={() => { setHubUrl(null); setHub(null); setError(null); }}>
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
              <Field label={t("login.name")}>
                <Input id="login-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoFocus required aria-label={t("login.name")} />
              </Field>
              <Field label={t("login.password")} hint={step === "setup" ? t("login.passwordHint") : undefined}>
                <Input type="password" aria-label={t("login.password")} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={step === "setup" ? "new-password" : "current-password"} required minLength={6} />
              </Field>
              {step === "setup" ? (
                <Field label={t("login.repeatPassword")}>
                  <Input type="password" aria-label={t("login.repeatPassword")} value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required minLength={6} />
                </Field>
              ) : null}
              {error ? <div style={{ color: "var(--dnd)", fontSize: 12 }}>{error}</div> : null}
              <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
                <button type="button" className="soft" style={{ fontSize: 11, textDecoration: "underline dotted" }} onClick={() => { setHubUrl(null); setHub(null); setStep("hub"); }}>
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
