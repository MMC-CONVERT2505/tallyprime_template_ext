import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  connectionsApi,
  deviceAuthApi,
  type ConnectionSummary,
  type DeviceStartResult,
} from '../api';
import { useSelectedCompany } from '../SelectedCompanyContext';
import { ErrorBanner } from './JsonView';
import {
  IconCheck,
  IconCompany,
  IconConnections,
  IconDatabase,
  IconExtract,
  IconPairing,
} from './Icons';
import { CopyButton, Spinner } from './ui';

const FLOW_STEPS = [
  { icon: IconCompany, label: 'Company', hint: 'The Tally company you want data from' },
  { icon: IconConnections, label: 'Connection', hint: "This org's pairing record + device token for that company" },
  { icon: IconPairing, label: 'Device / Agent', hint: 'The bridge process on the Tally machine, holding the token' },
  { icon: IconDatabase, label: 'Tally', hint: 'TallyPrime itself, which the agent talks to locally' },
  { icon: IconExtract, label: 'Extraction', hint: 'One data-pull job run through that live connection' },
];

function FlowStepper() {
  return (
    <div className="flow-stepper">
      {FLOW_STEPS.map((s, i) => (
        <div className="flow-step" key={s.label}>
          <div className="flow-step-icon" title={s.hint}>
            <s.icon />
          </div>
          <span>{s.label}</span>
          {i < FLOW_STEPS.length - 1 && (
            <span className="flow-arrow" aria-hidden="true">
              →
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Preview of what approving will actually do — reuse vs. create — computed
 *  client-side from the already-loaded connections list, before the user commits. */
function ReuseGlance({ company, connections }: { company: string; connections: ConnectionSummary[] }) {
  const trimmed = company.trim();
  if (!trimmed) return null;

  const existing = connections.find((c) => c.defaultCompany === trimmed && c.isActive);
  return (
    <p className="muted small reuse-glance">
      {existing ? (
        <>
          <IconCheck className="ok-color" /> Updates the existing connection ("{existing.label}") for this
          company — token rotated, no duplicate created.
        </>
      ) : (
        <>A new connection will be created for "{trimmed}" — no active connection exists for it yet.</>
      )}
    </p>
  );
}

/** Approves a userCode that a REAL bridge process printed to its own console — the actual production path. */
function ApproveRealBridgePanel({
  connections,
  companyOptions,
  onApproved,
  onPaired,
}: {
  connections: ConnectionSummary[];
  companyOptions: string[];
  onApproved: (company: string | null) => void;
  onPaired?: () => void;
}) {
  const { selectedCompany } = useSelectedCompany();
  const [userCode, setUserCode] = useState('');
  const [label, setLabel] = useState('Accounts PC');
  const [defaultCompany, setDefaultCompany] = useState(selectedCompany ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  const approve = async () => {
    setBusy(true);
    setError(null);
    setApproved(false);
    try {
      await deviceAuthApi.approve({ userCode, label, defaultCompany: defaultCompany || undefined });
      setApproved(true);
      onApproved(defaultCompany || null);
      // The bridge mints its own connection on its next poll (a few seconds,
      // per its own --interval) — this tab has nothing more to wait on.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-title">
        <IconPairing />
        <h2>Connect a company</h2>
      </div>
      <p className="muted">
        Run the real bridge on the machine with Tally (<code>npm run start:agent</code>, no <code>AGENT_TOKEN</code>{' '}
        set) — it prints a short code to its own console. Enter that code below to approve it; the bridge picks up
        the approval on its next poll and comes online within a few seconds.
      </p>
      <div className="form form-row">
        <label>
          Code from the bridge
          <input
            value={userCode}
            onChange={(e) => setUserCode(e.target.value)}
            placeholder="XXXX-XXXX"
            style={{ textTransform: 'uppercase' }}
          />
        </label>
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Company
          <input
            value={defaultCompany}
            onChange={(e) => setDefaultCompany(e.target.value)}
            placeholder="exact Tally company name"
            list="known-companies"
          />
        </label>
        <button onClick={() => void approve()} disabled={busy || !userCode} type="button">
          {busy && <Spinner />}
          Approve
        </button>
      </div>
      <ReuseGlance company={defaultCompany} connections={connections} />
      {companyOptions.length > 0 && (
        <datalist id="known-companies">
          {companyOptions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      {approved && (
        <div className="callout callout-success">
          <strong>
            <IconCheck className="ok-color" /> Approved
          </strong>
          <p className="muted small">
            Check the bridge's own terminal for "Authenticated" — then the Connections tab should show it online.
          </p>
          {onPaired && (
            <button type="button" onClick={onPaired} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
              Go to Extractions →
            </button>
          )}
        </div>
      )}
      <ErrorBanner message={error} />
    </div>
  );
}

export function DevicePairingPanel({ onPaired }: { onPaired?: () => void }) {
  const { selectedCompany, selectCompany } = useSelectedCompany();
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [start, setStart] = useState<DeviceStartResult | null>(null);
  const [defaultCompany, setDefaultCompany] = useState(selectedCompany ?? '');
  const [label, setLabel] = useState('Web console pairing');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<{ id: string; label: string; token: string; reused: boolean } | null>(
    null,
  );
  const [secondsLeft, setSecondsLeft] = useState(0);
  const pollTimer = useRef<number | null>(null);
  const countdownTimer = useRef<number | null>(null);

  useEffect(() => {
    connectionsApi.list().then(setConnections).catch(() => undefined);
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
      if (countdownTimer.current) window.clearInterval(countdownTimer.current);
    };
  }, []);

  const companyOptions = useMemo(
    () => Array.from(new Set(connections.filter((c) => c.isActive && c.defaultCompany).map((c) => c.defaultCompany as string))),
    [connections],
  );

  const handleApproved = (company: string | null) => {
    if (company) selectCompany(company);
  };

  const beginPairing = async () => {
    setBusy(true);
    setError(null);
    setApproved(null);
    try {
      const result = await deviceAuthApi.start();
      setStart(result);
      setSecondsLeft(result.expiresIn);

      if (pollTimer.current) window.clearInterval(pollTimer.current);
      if (countdownTimer.current) window.clearInterval(countdownTimer.current);

      countdownTimer.current = window.setInterval(() => {
        setSecondsLeft((s) => Math.max(0, s - 1));
      }, 1000);

      pollTimer.current = window.setInterval(async () => {
        try {
          const poll = await deviceAuthApi.poll(result.deviceCode);
          if (poll.status === 'approved') {
            setApproved(poll);
            handleApproved(defaultCompany || null);
            if (pollTimer.current) window.clearInterval(pollTimer.current);
            if (countdownTimer.current) window.clearInterval(countdownTimer.current);
          }
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
          if (pollTimer.current) window.clearInterval(pollTimer.current);
          if (countdownTimer.current) window.clearInterval(countdownTimer.current);
        }
      }, result.interval * 1000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!start) return;
    setBusy(true);
    setError(null);
    try {
      await deviceAuthApi.approve({
        userCode: start.userCode,
        label,
        defaultCompany: defaultCompany || undefined,
      });
      // The background poll loop above will pick up the approval on its next tick.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="card">
        <div className="card-title">
          <IconPairing />
          <h2>How company connections work</h2>
        </div>
        <FlowStepper />
        <p className="muted">
          <strong>Company</strong> — the Tally company you want data from. <strong>Connection</strong> — this
          org's record of being paired to that company, holding its device token. <strong>Device/Agent</strong> —
          the bridge process on the machine with Tally, which holds that token and relays commands over a secure
          tunnel. <strong>Tally</strong> — TallyPrime itself, which only the agent talks to directly. One pairing
          below connects a company all the way through to being ready for <strong>Extraction</strong>.
        </p>
      </div>

      <ApproveRealBridgePanel
        connections={connections}
        companyOptions={companyOptions}
        onApproved={handleApproved}
        onPaired={onPaired}
      />

      <details className="advanced">
        <summary>Advanced: simulate the whole flow in-browser (no real bridge, for demos/testing)</summary>
        <div className="card">
          <div className="card-title">
            <IconPairing />
            <h2>Device pairing — simulated</h2>
          </div>
          <p className="muted">
            This page plays the role of BOTH the bridge (Start + auto-poll) AND the approving human (Approve), so
            you can see the whole RFC 8628-style flow without a separate process. It mints a real, valid connection
            — but since no real bridge is behind it, it will show "not currently online" until a real bridge
            authenticates with its token.
          </p>
          <button onClick={() => void beginPairing()} disabled={busy} type="button">
            {busy && <Spinner />}
            {busy ? 'Working…' : 'Start pairing'}
          </button>

          {start && !approved && (
            <div className="callout">
              <div className="user-code-wrap">
                <div className="user-code">{start.userCode}</div>
              </div>
              <p className="muted small" style={{ textAlign: 'center' }}>
                Polling every {start.interval}s — expires in {Math.floor(secondsLeft / 60)}m {secondsLeft % 60}s.
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
                    list="known-companies"
                  />
                </label>
                <button onClick={() => void approve()} disabled={busy} type="button">
                  {busy && <Spinner />}
                  Approve this code
                </button>
              </div>
              <ReuseGlance company={defaultCompany} connections={connections} />
            </div>
          )}

          {approved && (
            <div className="callout callout-success">
              <strong>
                <IconCheck className="ok-color" />{' '}
                {approved.reused
                  ? 'Reconnected — reused your existing pairing for this company, no duplicate created'
                  : 'Paired!'}
              </strong>
              <p className="muted small">
                Token (shown once — this is what a real bridge would save into its own .env as AGENT_TOKEN):
              </p>
              <div className="token-row">
                <code className="token-box">{approved.token}</code>
                <CopyButton value={approved.token} />
              </div>
              <span className="muted small">connectionId: {approved.id}</span>
              {onPaired && (
                <button type="button" onClick={onPaired} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                  Go to Extractions →
                </button>
              )}
            </div>
          )}

          <ErrorBanner message={error} />
        </div>
      </details>
    </div>
  );
}
