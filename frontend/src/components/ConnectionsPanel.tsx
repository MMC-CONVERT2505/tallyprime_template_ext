import { useEffect, useState } from 'react';
import { ApiError, connectionsApi, type ConnectionSummary } from '../api';
import { ErrorBanner } from './JsonView';

export function ConnectionsPanel() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [label, setLabel] = useState('Manual Connection');
  const [defaultCompany, setDefaultCompany] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ id: string; token: string } | null>(null);

  const refresh = async () => {
    try {
      setConnections(await connectionsApi.list());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await connectionsApi.create({ label, defaultCompany: defaultCompany || undefined });
      setNewToken({ id: result.id, token: result.token });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await connectionsApi.revoke(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const rotate = async (id: string) => {
    setError(null);
    try {
      const result = await connectionsApi.rotateToken(id);
      setNewToken({ id: result.id, token: result.token });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <div className="panel">
      <div className="card">
        <h2>Create a connection (manual — mints a token directly)</h2>
        <p className="muted">
          Always creates a NEW row — don't re-run this for a device you already paired, use Rotate instead.
        </p>
        <div className="form form-row">
          <label>
            Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label>
            Default company (optional)
            <input
              value={defaultCompany}
              onChange={(e) => setDefaultCompany(e.target.value)}
              placeholder="exact Tally company name"
            />
          </label>
          <button onClick={create} disabled={busy} type="button">
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
        {newToken && (
          <div className="callout">
            <strong>Token — shown once, save it now:</strong>
            <code className="token-box">{newToken.token}</code>
            <span className="muted">connectionId: {newToken.id}</span>
          </div>
        )}
        <ErrorBanner message={error} />
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Connections</h2>
          <button onClick={() => void refresh()} type="button">
            Refresh
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Company</th>
              <th>Active</th>
              <th>Connected</th>
              <th>Last seen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {connections.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.label}
                  <div className="muted small">{c.id}</div>
                </td>
                <td>{c.defaultCompany ?? <span className="muted">(unpinned)</span>}</td>
                <td>{c.isActive ? '✅' : '❌'}</td>
                <td>
                  <span className={c.connected ? 'pill pill-ok' : 'pill pill-off'}>
                    {c.connected ? 'online' : 'offline'}
                  </span>
                </td>
                <td className="small">{c.lastSeenAt ? new Date(c.lastSeenAt).toLocaleString() : '—'}</td>
                <td className="actions">
                  <button onClick={() => void rotate(c.id)} type="button" disabled={!c.isActive}>
                    Rotate
                  </button>
                  <button onClick={() => void revoke(c.id)} type="button" disabled={!c.isActive} className="danger">
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
            {connections.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No connections yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
