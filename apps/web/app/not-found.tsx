"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n";

export default function NotFound() {
  const t = useT();
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16 }}>
      <section className="win fade-in" style={{ maxWidth: 420, width: "100%" }}>
        <div className="win-title">
          <span className="dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span className="title">404</span>
        </div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
          <img src="/logo.svg" alt="" width={48} height={48} style={{ imageRendering: "pixelated" }} />
          <div>
            <div className="pixel" style={{ fontSize: 18 }}>{t("error.notFound.title")}</div>
            <p className="soft" style={{ fontSize: 12, marginTop: 4 }}>
              {t("error.notFound.before")} <code>/m/?id=…</code>{t("error.notFound.after")}
            </p>
          </div>
          <Link href="/" className="btn btn-primary">
            {t("error.notFound.back")}
          </Link>
        </div>
      </section>
    </div>
  );
}
