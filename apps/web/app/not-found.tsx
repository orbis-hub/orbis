import Link from "next/link";

export default function NotFound() {
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
            <div className="pixel" style={{ fontSize: 18 }}>nothing here</div>
            <p className="soft" style={{ fontSize: 12, marginTop: 4 }}>
              this page does not exist on this hub. module pages live under <code>/m/?id=…</code>, everything else is in the sidebar.
            </p>
          </div>
          <Link href="/" className="btn btn-primary">
            back to the dashboard
          </Link>
        </div>
      </section>
    </div>
  );
}
