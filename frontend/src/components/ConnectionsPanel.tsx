import { useEffect, useMemo, useState } from 'react';
import { ApiError, connectionsApi, type ConnectionSummary } from '../api';
import { useSelectedCompany } from '../SelectedCompanyContext';
import { ErrorBanner } from './JsonView';
import { IconConnections, IconRefresh, IconCheck } from './Icons';
import { CopyButton, EmptyState, Spinner } from './ui';

export function ConnectionsPanel() {
  const { selectedCompany, selectCompany } = useSelectedCompany();
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [search, setSearch] = useState('');
  const [label, setLabel] = useState('Manual Connection');
  const [defaultCompany, setDefaultCompany] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ id: string; token: string; reused: boolean } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    try {
      setConnections(await connectionsApi.list());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Client-side: the full list is already loaded (realistic org scale is
  // dozens of connections, not thousands), so filtering here is instant and
  // avoids a network round-trip per keystroke. The backend also accepts
  // GET /connections?search= for other consumers (Postman, scripts).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter(
      (c) => c.defaultCompany?.toLowerCase().includes(q) || c.label.toLowerCase().includes(q),
    );
  }, [connections, search]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await connectionsApi.create({ label, defaultCompany: defaultCompany || undefined });
      setNewToken({ id: result.id, token: result.token, reused: result.reused });
      if (defaultCompany) selectCompany(defaultCompany);
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
      setNewToken({ id: result.id, token: result.token, reused: result.reused });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const remove = async (c: ConnectionSummary) => {
    const confirmed = window.confirm(
      `Permanently delete "${c.label}"${c.defaultCompany ? ` (${c.defaultCompany})` : ''}? ` +
        'This cannot be undone — unlike Revoke, there is no re-pairing your way back to this exact row.',
    );
    if (!confirmed) return;

    setError(null);
    setDeletingId(c.id);
    try {
      await connectionsApi.delete(c.id);
      if (c.defaultCompany && c.defaultCompany === selectedCompany) selectCompany(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="panel">
      <div className="card">
        <div className="card-title">
          <IconConnections />
          <h2>Create a connection (manual — mints a token directly)</h2>
        </div>
        <p className="muted">
          For scripted/enterprise rollout. For pairing a physical machine, use the Device Pairing tab instead —
          it needs no manual token. Safe to re-run either way: a company that already has an active connection
          gets its token rotated on that same row instead of creating a duplicate.
        </p>
        <div className="form form-row">
          <label>
            Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label>
            Company (optional)
            <input
              value={defaultCompany}
              onChange={(e) => setDefaultCompany(e.target.value)}
              placeholder="exact Tally company name"
            />
          </label>
          <button onClick={() => void create()} disabled={busy} type="button">
            {busy && <Spinner />}
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
        {newToken && (
          <div className="callout callout-success">
            <strong>
              <IconCheck className="ok-color" />{' '}
              {newToken.reused ? 'Reused existing connection — token rotated' : 'New connection created'} — token
              shown once, save it now
            </strong>
            <div className="token-row">
              <code className="token-box">{newToken.token}</code>
              <CopyButton value={newToken.token} />
            </div>
            <span className="muted small">connectionId: {newToken.id}</span>
          </div>
        )}
        <ErrorBanner message={error} />
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <IconConnections />
            <h2>Connections</h2>
          </div>
          <button onClick={() => void refresh()} type="button" className="ghost" disabled={refreshing}>
            {refreshing ? <Spinner /> : <IconRefresh />}
            Refresh
          </button>
        </div>
        <p className="muted">
          Click a company name to make it the working company for Device Pairing, Tally Direct, and Extractions.
        </p>
        <input
          className="search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by company or label…"
        />
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Label</th>
              <th>Active</th>
              <th>Connected</th>
              <th>Last seen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id} className={c.defaultCompany === selectedCompany ? 'row-selected' : ''}>
                <td>
                  {c.defaultCompany ? (
                    <button
                      type="button"
                      className="link-cell"
                      onClick={() => selectCompany(c.defaultCompany)}
                      title="Work with this company"
                    >
                      {c.defaultCompany}
                    </button>
                  ) : (
                    <span className="muted">(unpinned — serves any company)</span>
                  )}
                </td>
                <td>
                  {c.label}
                  <div className="muted small">{c.id}</div>
                </td>
                <td>
                  <span className={c.isActive ? 'pill pill-ok' : 'pill pill-off'}>
                    {c.isActive ? 'active' : 'revoked'}
                  </span>
                </td>
                <td>
                  <span className={c.connected ? 'pill pill-ok' : 'pill pill-off'}>
                    {c.connected ? 'online' : 'offline'}
                  </span>
                </td>
                <td className="small">{c.lastSeenAt ? new Date(c.lastSeenAt).toLocaleString() : '—'}</td>
                <td className="actions">
                  <button onClick={() => void rotate(c.id)} type="button" className="ghost" disabled={!c.isActive}>
                    Rotate
                  </button>
                  <button onClick={() => void revoke(c.id)} type="button" disabled={!c.isActive} className="danger">
                    Revoke
                  </button>
                  <button
                    onClick={() => void remove(c)}
                    type="button"
                    className="danger"
                    disabled={deletingId === c.id}
                  >
                    {deletingId === c.id && <Spinner />}
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && connections.length > 0 && (
              <tr>
                <td colSpan={6}>
                  <EmptyState message={`No connections match "${search}".`} />
                </td>
              </tr>
            )}
            {connections.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <EmptyState message="No connections yet." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
