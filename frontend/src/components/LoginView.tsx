import { useState, type FormEvent } from "react";
import { api } from "../lib/api";

export default function LoginView({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-view">
      <form className="login-card" onSubmit={submit}>
        <h1>Notes</h1>
        <p className="login-sub">Your personal markdown notebook.</p>
        <label htmlFor="login-pass">Password</label>
        <input
          id="login-pass"
          type="password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
        />
        {error && <div className="login-error">{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}