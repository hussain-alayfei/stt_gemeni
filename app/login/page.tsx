"use client";

import { FormEvent, useState } from "react";

/** Only same-site paths are allowed as the return address, never another site. */
function safeNext(): string {
  const next = new URLSearchParams(window.location.search).get("next") || "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export default function LoginPage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (response.ok) {
        window.location.assign(safeNext());
        return;
      }
      const data = await response.json().catch(() => ({}));
      setError(data.error || "Sign-in failed. Please try again.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <main className="shell loginShell">
      <header className="topbar">
        <div className="brandArea">
          <div className="brand">Speech to Text</div>
        </div>
      </header>

      <section className="intro">
        <h1>Sign in</h1>
        <p>Enter the access code to use the transcriber.</p>
      </section>

      <form className="card loginCard" onSubmit={submit}>
        <div className="balanceForm">
          <label htmlFor="access-code">Access code</label>
          <div className="loginField">
            <input
              id="access-code"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
        </div>
        {error && <div className="queueError" role="alert">{error}</div>}
        <button className="primaryButton" type="submit" disabled={!code.trim() || busy}>
          {busy ? "Signing in" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
