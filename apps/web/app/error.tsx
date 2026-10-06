"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16 }}>
      <section className="win fade-in" style={{ maxWidth: 520, width: "100%" }}>
        <div className="win-title">
          <span className="dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span className="title">{t("error.title")}</span>
        </div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="pixel" style={{ fontSize: 16 }}>{t("error.subtitle")}</div>
          <pre className="input" style={{ fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0, maxHeight: 200, overflow: "auto" }}>
            {error.message}
            {error.digest ? `\n\n${t("error.digest", { digest: error.digest })}` : ""}
          </pre>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" onClick={() => reset()}>
              {t("common.tryAgain")}
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              {t("common.reload")}
            </button>
            <Link className="btn" href="/">
              {t("common.dashboard")}
            </Link>
          </div>
          <p className="soft" style={{ fontSize: 11 }}>
            {t("error.issueHint")}{" "}
            <a href="https://github.com/orbis-hub/orbis/issues/new" target="_blank" rel="noreferrer">
              orbis-hub/orbis
            </a>
          </p>
        </div>
      </section>
    </div>
  );
}
