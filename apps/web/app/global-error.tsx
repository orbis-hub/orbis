"use client";

import { appTranslator, browserLanguage } from "@/lib/i18n";

// last line of defence: the root layout itself failed, so this renders its own <html>
// (no providers available here, so the translator is built from the browser language directly)
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = appTranslator(browserLanguage());
  return (
    <html lang={t.language}>
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#17121c", color: "#f1e7f0", fontFamily: "ui-monospace, monospace", fontSize: 14, padding: 16 }}>
        <div style={{ maxWidth: 520, width: "100%", border: "1.5px solid #5c4a62", boxShadow: "4px 4px 0 #5c4a62", background: "#1f1826" }}>
          <div style={{ padding: "5px 10px", borderBottom: "1.5px solid #5c4a62", background: "#291f32", fontSize: 13 }}>● ○ ○ {t("error.crashed")}</div>
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>{t("error.couldNotStart")}</div>
            <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0, background: "#291f32", padding: 8, border: "1.5px solid #5c4a62" }}>
              {error.message}
              {error.digest ? `\n\n${t("error.digest", { digest: error.digest })}` : ""}
            </pre>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => reset()} style={{ font: "inherit", padding: "4px 12px", background: "#ff8fb4", color: "#fff", border: "1.5px solid #ff8fb4", boxShadow: "2px 2px 0 #f1e7f0", cursor: "pointer" }}>
                {t("common.tryAgain")}
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- the root layout (and with it the router) crashed; a plain link forces the full reload we want */}
              <a href="/" style={{ font: "inherit", padding: "4px 12px", background: "#291f32", color: "#f1e7f0", border: "1.5px solid #5c4a62", boxShadow: "2px 2px 0 #5c4a62", textDecoration: "none" }}>
                {t("common.reload")}
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
