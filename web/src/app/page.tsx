// F01 stub home page. A01 (Next.js skeleton + auth) replaces this with the
// real router groups (agent, admin, sup).

export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 640 }}>
        <h1 style={{ fontSize: "3rem", margin: 0 }}>vici2</h1>
        <p style={{ opacity: 0.7, marginTop: "1rem" }}>
          Open-source Vicidial alternative on FreeSWITCH + MySQL + BYOC SIP.
        </p>
        <p style={{ opacity: 0.6, marginTop: "2rem", fontSize: "0.875rem" }}>
          Foundation phase. See <code>spec/modules/</code> for module status.
        </p>
      </div>
    </main>
  );
}
