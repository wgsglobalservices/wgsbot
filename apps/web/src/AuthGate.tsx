import { createContext, useContext, useState, type FormEvent, type ReactNode } from "react";
import { setApiAuthTokenProvider } from "./lib/api";

const ADMIN_TOKEN_STORAGE_KEY = "minutesbot.adminToken";
const AdminSessionContext = createContext<{ signOut: () => void } | null>(null);

export function useAdminSession(): { signOut: () => void } {
  const session = useContext(AdminSessionContext);
  if (!session) throw new Error("useAdminSession must be used inside AuthGate");
  return session;
}

export function getStoredAdminToken(): string | null {
  return typeof window === "undefined" ? null : window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
}

export function setStoredAdminTokenProvider(): void {
  setApiAuthTokenProvider(async () => getStoredAdminToken());
}

setStoredAdminTokenProvider();

export function AuthGate({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? "");
  const [draftToken, setDraftToken] = useState("");

  function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextToken = draftToken.trim();
    if (!nextToken) return;
    window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, nextToken);
    setToken(nextToken);
    setDraftToken("");
  }

  function clearToken() {
    window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
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
          <button type="submit">Continue</button>
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
