import { createContext, useContext, useState, type ReactNode } from 'react';
import { authApi, setAccessToken, type AuthResult } from './api';

interface AuthState {
  accessToken: string;
  email: string;
  orgId: string;
  orgName: string;
}

interface AuthContextValue {
  auth: AuthState | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string, orgName: string) => Promise<void>;
  logout: () => void;
}

const STORAGE_KEY = 'tally-e2e-auth';

const AuthContext = createContext<AuthContextValue | null>(null);

function fromAuthResult(result: AuthResult): AuthState {
  return {
    accessToken: result.accessToken,
    email: result.user.email,
    orgId: result.user.orgId,
    orgName: result.user.orgName,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuthState] = useState<AuthState | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as AuthState) : null;
    // Set synchronously, before first render — see the comment on applyAuth
    // below for why this can't be a useEffect.
    setAccessToken(parsed?.accessToken ?? null);
    return parsed;
  });

  /**
   * Sets the module-level API token BEFORE triggering the re-render that
   * mounts/updates children — not in a useEffect. AuthProvider is an
   * ancestor of every panel; React fires child effects before parent
   * effects in the same commit, so a child's mount-time fetch (e.g.
   * ConnectionsPanel's) would otherwise run before an ancestor's useEffect
   * had set the token, sending the very first request unauthenticated
   * (caught live: this shipped as a real 401 on first login before being
   * fixed here — see the smoke test that caught it).
   */
  const applyAuth = (next: AuthState | null) => {
    setAccessToken(next?.accessToken ?? null);
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
    setAuthState(next);
  };

  const login = async (email: string, password: string) => {
    const result = await authApi.login({ email, password });
    applyAuth(fromAuthResult(result));
  };

  const register = async (email: string, password: string, name: string, orgName: string) => {
    const result = await authApi.register({ email, password, name, orgName });
    applyAuth(fromAuthResult(result));
  };

  const logout = () => applyAuth(null);

  return <AuthContext.Provider value={{ auth, login, register, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
