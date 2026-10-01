"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16 }}>
      <section className="win fade-in" style={{ maxWidth: 520, width: "100%" }}>
        <div className="win-title">
          <span className="dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span className="title">something broke</span>
        </div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="pixel" style={{ fontSize: 16 }}>the page crashed, the hub is probably fine</div>
          <pre className="input" style={{ fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0, maxHeight: 200, overflow: "auto" }}>
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </pre>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" onClick={() => reset()}>
              try again
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              reload
            </button>
            <a className="btn" href="/">
              dashboard
            </a>
          </div>
          <p className="soft" style={{ fontSize: 11 }}>
            if it keeps happening, open an issue with this message and what you clicked:{" "}
            <a href="https://github.com/orbis-hub/orbis/issues/new" target="_blank" rel="noreferrer">
              orbis-hub/orbis
            </a>
          </p>
        </div>
      </section>
    </div>
  );
}
