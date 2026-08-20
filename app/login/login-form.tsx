"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Sign in failed");
      router.push("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login-card" onSubmit={submit}>
      <header className="login-form-head">
        <div className="login-eyebrow">Secure staff access</div>
        <h2>Welcome back</h2>
        <p>Sign in with the Eagle Shield account provided by your administrator.</p>
      </header>
      {error && <div className="login-error" role="alert">{error}</div>}
      <label>
        <span>Email address</span>
        <input name="email" type="email" inputMode="email" autoCapitalize="none" autoComplete="username" placeholder="name@eagleshield.com" required autoFocus />
      </label>
      <label>
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" placeholder="Enter your password" required />
      </label>
      <button className="btn primary login-submit" disabled={busy}>
        <span>{busy ? "Signing in…" : "Sign in to calendar"}</span>
        {!busy && <span aria-hidden="true">→</span>}
      </button>
      <div className="login-session-note">
        <span aria-hidden="true">●</span>
        Protected 12-hour staff session
      </div>
    </form>
  );
}
