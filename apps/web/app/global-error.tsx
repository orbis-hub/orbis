"use client";

// last line of defence: the root layout itself failed, so this renders its own <html>
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#17121c", color: "#f1e7f0", fontFamily: "ui-monospace, monospace", fontSize: 14, padding: 16 }}>
        <div style={{ maxWidth: 520, width: "100%", border: "1.5px solid #5c4a62", boxShadow: "4px 4px 0 #5c4a62", background: "#1f1826" }}>
          <div style={{ padding: "5px 10px", borderBottom: "1.5px solid #5c4a62", background: "#291f32", fontSize: 13 }}>● ○ ○ orbis crashed</div>
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>the app could not start. this is a bug in orbis, not in your hub.</div>
            <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0, background: "#291f32", padding: 8, border: "1.5px solid #5c4a62" }}>
              {error.message}
              {error.digest ? `\n\ndigest: ${error.digest}` : ""}
            </pre>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => reset()} style={{ font: "inherit", padding: "4px 12px", background: "#ff8fb4", color: "#fff", border: "1.5px solid #ff8fb4", boxShadow: "2px 2px 0 #f1e7f0", cursor: "pointer" }}>
                try again
              </button>
              <a href="/" style={{ font: "inherit", padding: "4px 12px", background: "#291f32", color: "#f1e7f0", border: "1.5px solid #5c4a62", boxShadow: "2px 2px 0 #5c4a62", textDecoration: "none" }}>
                reload
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
