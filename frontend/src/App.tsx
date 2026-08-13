import { useState, type ReactElement } from 'react';
import './App.css';
import { AuthProvider, useAuth } from './AuthContext';
import { SelectedCompanyProvider, useSelectedCompany } from './SelectedCompanyContext';
import { AuthPanel } from './components/AuthPanel';
import { ConnectionsPanel } from './components/ConnectionsPanel';
import { DevicePairingPanel } from './components/DevicePairingPanel';
import { TallyDirectPanel } from './components/TallyDirectPanel';
import { ExtractionsPanel } from './components/ExtractionsPanel';
import { LogoMark, IconConnections, IconPairing, IconDatabase, IconExtract } from './components/Icons';
import { API_BASE_URL } from './api';

type Tab = 'connections' | 'pairing' | 'tally' | 'extractions';

const TABS: { id: Tab; label: string; icon: (p: { className?: string }) => ReactElement }[] = [
  { id: 'connections', label: 'Connections', icon: IconConnections },
  { id: 'pairing', label: 'Device Pairing', icon: IconPairing },
  { id: 'tally', label: 'Tally Direct', icon: IconDatabase },
  { id: 'extractions', label: 'Extractions', icon: IconExtract },
];

function Console() {
  const { auth, logout } = useAuth();
  const { selectedCompany } = useSelectedCompany();
  const [tab, setTab] = useState<Tab>('connections');

  if (!auth) return <AuthPanel />;

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <div className="brand-mark">
            <LogoMark />
          </div>
          <div className="brand-text">
            <h1>Tally Connector — API Console</h1>
            <span className="api-url">{API_BASE_URL}</span>
          </div>
        </div>
        <div className="user-info">
          {selectedCompany && (
            <div className="working-on" title="The company every tab below acts on">
              <span className="working-on-label">Working on</span>
              <span className="working-on-company">{selectedCompany}</span>
            </div>
          )}
          <div className="user-info-text">
            <span className="org">{auth.orgName}</span>
            <span className="email">{auth.email}</span>
          </div>
          <button onClick={logout} type="button" className="ghost">
            Log out
          </button>
        </div>
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)} type="button">
            <t.icon />
            {t.label}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'connections' && <ConnectionsPanel />}
        {tab === 'pairing' && <DevicePairingPanel onPaired={() => setTab('extractions')} />}
        {tab === 'tally' && <TallyDirectPanel />}
        {tab === 'extractions' && <ExtractionsPanel />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <SelectedCompanyProvider>
        <Console />
      </SelectedCompanyProvider>
    </AuthProvider>
  );
}
