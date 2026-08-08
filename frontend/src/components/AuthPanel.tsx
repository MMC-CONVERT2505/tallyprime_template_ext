import { useState, type FormEvent } from 'react';
import { useAuth } from '../AuthContext';
import { ApiError } from '../api';
import { ErrorBanner } from './JsonView';

export function AuthPanel() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password, name, orgName);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card auth-card">
      <h1>Tally Connector — API Console</h1>
      <p className="muted">
        A simple UI over every endpoint in the backend, for end-to-end testing. Mirrors the Postman collection in
        <code> postman/</code>.
      </p>
      <div className="tabs tabs-small">
        <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')} type="button">
          Login
        </button>
        <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')} type="button">
          Register
        </button>
      </div>
      <form onSubmit={submit} className="form">
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>
        {mode === 'register' && (
          <>
            <label>
              Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>
              Org name
              <input type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
            </label>
          </>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Register'}
        </button>
      </form>
      <ErrorBanner message={error} />
    </div>
  );
}
