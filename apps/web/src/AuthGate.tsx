import { createContext, useContext, useState, type FormEvent, type ReactNode } from "react";
import { ADMIN_TOKEN_STORAGE_KEY, setApiAuthTokenProvider, verifyAdminToken } from "./lib/api";

const AdminSessionContext = createContext<{ signOut: () => void } | null>(null);

export function useAdminSession(): { signOut: () => void } {
  const session = useContext(AdminSessionContext);
  if (!session) throw new Error("useAdminSession must be used inside AuthGate");
  return session;
}

export function getStoredAdminToken(): string | null {
  return typeof window === "undefined" ? null : window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
}

export function setStoredAdminTokenProvider(): void {
  setApiAuthTokenProvider(async () => getStoredAdminToken());
}

setStoredAdminTokenProvider();

export function AuthGate({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? "");
  const [draftToken, setDraftToken] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextToken = draftToken.trim();
    if (!nextToken) return;
    setChecking(true);
    setError("");
    try {
      const result = await verifyAdminToken(nextToken);
      if (!result.ok) {
        setError(result.status === 401 ? "Invalid admin token." : `Token check failed with ${result.status}.`);
        return;
      }
      window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, nextToken);
      setToken(nextToken);
      setDraftToken("");
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "Token check failed.");
    } finally {
      setChecking(false);
    }
  }

  function clearToken() {
    window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    setToken("");
  }

  if (!token) {
    return (
      <div className="authPage">
        <form className="authPanel" onSubmit={saveToken}>
          <h1>minutesbot admin</h1>
          <label htmlFor="admin-token">Admin token</label>
          <input
            id="admin-token"
            type="password"
            value={draftToken}
            onChange={(event) => setDraftToken(event.target.value)}
            autoComplete="current-password"
            autoFocus
          />
          {error && <span className="fieldError">{error}</span>}
          <button type="submit" disabled={checking}>{checking ? "Checking..." : "Continue"}</button>
        </form>
      </div>
    );
  }

  return (
    <AdminSessionContext.Provider value={{ signOut: clearToken }}>
      {children}
    </AdminSessionContext.Provider>
  );
}
