"use client";

import { Button, Field, Input, Window } from "@orbis/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { getHubUrl, hubFetch, HubError, isCapacitor, setHubUrl, setToken } from "@/lib/hub";
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
    if (status.error) setError(status.error instanceof HubError ? status.error.message : "hub unreachable");
  }, [hub, status.data, status.error, router]);

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
      setError(`could not reach a hub at ${url} (${(err as Error).message})`);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (step === "setup" && password !== password2) return setError("passwords do not match");
    setBusy(true);
    try {
      const res = await hubFetch<{ token: string }>(step === "setup" ? "/api/auth/setup" : "/api/auth/login", { method: "POST", json: { name, password } });
      setToken(res.token);
      await qc.invalidateQueries();
      router.replace("/");
    } catch (err) {
      setError(err instanceof HubError ? err.message : "something went wrong");
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
          <Window title="connect to your hub">
            <form onSubmit={saveHub} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p className="soft" style={{ fontSize: 12 }}>
                {isCapacitor() ? "enter the address of your orbis hub on the local network." : "where is your orbis hub running?"}
              </p>
              <Field label="hub url" hint="e.g. http://192.168.1.20:3001 or https://orbis.example.com">
                <Input value={hubInput} onChange={(e) => setHubInput(e.target.value)} placeholder="http://192.168.1.20:3001" autoFocus inputMode="url" />
              </Field>
              {error ? <div style={{ color: "var(--dnd)", fontSize: 12 }}>{error}</div> : null}
              <Button type="submit" variant="primary" loading={busy}>
                connect
              </Button>
            </form>
          </Window>
        ) : status.isPending && !status.data ? (
          <Window title="connecting">
            <div className="pixel soft" style={{ fontSize: 13 }}>
              talking to {hub}
              <span className="blink">…</span>
            </div>
            {error ? (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ color: "var(--dnd)", fontSize: 12 }}>{error}</div>
                <Button size="sm" onClick={() => { setHubUrl(null); setHub(null); setError(null); }}>
                  change hub url
                </Button>
              </div>
            ) : null}
          </Window>
        ) : (
          <Window title={step === "setup" ? "welcome · create your account" : "sign in"} right={<span className="chip" style={{ fontSize: 10 }}>{(hub ?? "").replace(/^https?:\/\//, "")}</span>}>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {step === "setup" ? (
                <p className="soft" style={{ fontSize: 12 }}>
                  this hub is brand new. pick a name and a password, you are the owner.
                </p>
              ) : null}
              <Field label="name">
                <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoFocus required />
              </Field>
              <Field label="password" hint={step === "setup" ? "at least 6 characters" : undefined}>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={step === "setup" ? "new-password" : "current-password"} required minLength={6} />
              </Field>
              {step === "setup" ? (
                <Field label="repeat password">
                  <Input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required minLength={6} />
                </Field>
              ) : null}
              {error ? <div style={{ color: "var(--dnd)", fontSize: 12 }}>{error}</div> : null}
              <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
                <button type="button" className="soft" style={{ fontSize: 11, textDecoration: "underline dotted" }} onClick={() => { setHubUrl(null); setHub(null); setStep("hub"); }}>
                  other hub
                </button>
                <Button type="submit" variant="primary" loading={busy}>
                  {step === "setup" ? "create & enter" : "enter"}
                </Button>
              </div>
            </form>
          </Window>
        )}
      </div>
    </div>
  );
}
