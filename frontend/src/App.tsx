import { useState } from 'react';
import './App.css';
import { AuthProvider, useAuth } from './AuthContext';
import { AuthPanel } from './components/AuthPanel';
import { ConnectionsPanel } from './components/ConnectionsPanel';
import { DevicePairingPanel } from './components/DevicePairingPanel';
import { TallyDirectPanel } from './components/TallyDirectPanel';
import { ExtractionsPanel } from './components/ExtractionsPanel';
import { API_BASE_URL } from './api';

type Tab = 'connections' | 'pairing' | 'tally' | 'extractions';

const TABS: { id: Tab; label: string }[] = [
  { id: 'connections', label: 'Connections' },
  { id: 'pairing', label: 'Device Pairing' },
  { id: 'tally', label: 'Tally Direct' },
  { id: 'extractions', label: 'Extractions' },
];

function Console() {
  const { auth, logout } = useAuth();
  const [tab, setTab] = useState<Tab>('connections');

  if (!auth) return <AuthPanel />;

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <strong>Tally Connector — API Console</strong>
          <span className="muted small"> {API_BASE_URL}</span>
        </div>
        <div className="user-info">
          <span>
            {auth.email} · {auth.orgName}
          </span>
          <button onClick={logout} type="button" className="ghost">
            Log out
          </button>
        </div>
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)} type="button">
            {t.label}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'connections' && <ConnectionsPanel />}
        {tab === 'pairing' && <DevicePairingPanel />}
        {tab === 'tally' && <TallyDirectPanel />}
        {tab === 'extractions' && <ExtractionsPanel />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Console />
    </AuthProvider>
  );
}
