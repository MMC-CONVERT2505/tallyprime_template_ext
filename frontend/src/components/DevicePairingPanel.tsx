import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  connectionsApi,
  deviceAuthApi,
  type ConnectionSummary,
  type DeviceStartResult,
  type DeviceStatusResult,
} from '../api';
import { useSelectedCompany } from '../SelectedCompanyContext';
import { ErrorBanner } from './JsonView';
import { Modal } from './Modal';
import {
  IconAlert,
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

// ── Post-approve guided modal ────────────────────────────────────────────

const STATUS_POLL_MS = 2500;
const STATUS_POLL_TIMEOUT_MS = 120_000; // 2 minutes — generous headroom over the bridge's own ~5s poll cadence.

type ErrorKind = 'expired' | 'not-found' | 'conflict-other-org' | 'network' | 'unknown';

type PairingPhase =
  | { phase: 'submitting' }
  | { phase: 'error'; kind: ErrorKind; message: string }
  | { phase: 'waiting'; alreadyApproved: boolean }
  | { phase: 'connected'; label: string; defaultCompany: string | null }
  | { phase: 'timed-out' };

/** Submitting an approve() failure into a specific, actionable error kind instead of one generic message. */
function classifyApproveError(err: unknown): { kind: ErrorKind; message: string } {
  if (err instanceof ApiError) {
    if (err.status === 400) return { kind: 'expired', message: err.message };
    if (err.status === 404) return { kind: 'not-found', message: err.message };
    if (err.status === 409) {
      // "already been completed" (fully paired already) resolves through the
      // same success/waiting path as a fresh approval — see the caller.
      if (/different organization/i.test(err.message)) {
        return { kind: 'conflict-other-org', message: err.message };
      }
      return { kind: 'unknown', message: err.message };
    }
    return { kind: 'unknown', message: err.message };
  }
  return { kind: 'network', message: err instanceof Error ? err.message : String(err) };
}

function PairingSummary({ userCode, label, defaultCompany }: { userCode: string; label: string; defaultCompany: string }) {
  return (
    <div className="pairing-summary">
      <div className="pairing-summary-row">
        <span>Code</span>
        <span>{userCode}</span>
      </div>
      <div className="pairing-summary-row">
        <span>Label</span>
        <span>{label}</span>
      </div>
      <div className="pairing-summary-row">
        <span>Company</span>
        <span>{defaultCompany || '(none — multi-company agent)'}</span>
      </div>
    </div>
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

  const [modalOpen, setModalOpen] = useState(false);
  const [modalState, setModalState] = useState<PairingPhase>({ phase: 'submitting' });
  const [submitted, setSubmitted] = useState({ userCode: '', label: '', defaultCompany: '' });
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const pollTimer = useRef<number | null>(null);
  const elapsedTimer = useRef<number | null>(null);
  const pollStartedAt = useRef<number>(0);

  const stopPolling = () => {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    if (elapsedTimer.current) window.clearInterval(elapsedTimer.current);
    pollTimer.current = null;
    elapsedTimer.current = null;
  };

  useEffect(() => stopPolling, []);

  const beginStatusPolling = (code: string) => {
    stopPolling();
    pollStartedAt.current = Date.now();
    setElapsedSeconds(0);

    elapsedTimer.current = window.setInterval(() => {
      setElapsedSeconds(Math.round((Date.now() - pollStartedAt.current) / 1000));
    }, 1000);

    const tick = async () => {
      if (Date.now() - pollStartedAt.current >= STATUS_POLL_TIMEOUT_MS) {
        stopPolling();
        setModalState({ phase: 'timed-out' });
        return;
      }
      try {
        const result: DeviceStatusResult = await deviceAuthApi.status(code);
        if (result.status === 'consumed' && result.connected) {
          stopPolling();
          setModalState({
            phase: 'connected',
            label: result.label ?? submitted.label,
            defaultCompany: result.defaultCompany ?? null,
          });
        }
        // pending/approved/not-yet-connected — keep polling, nothing to do.
      } catch {
        // A single failed tick (transient network blip) shouldn't abort the
        // whole wait — just try again next interval, bounded by the timeout above.
      }
    };

    void tick();
    pollTimer.current = window.setInterval(() => void tick(), STATUS_POLL_MS);
  };

  const submitApprove = async (code: string, lbl: string, company: string) => {
    setModalState({ phase: 'submitting' });
    setBusy(true);
    try {
      const result = await deviceAuthApi.approve({ userCode: code, label: lbl, defaultCompany: company || undefined });
      onApproved(company || null);
      setModalState({ phase: 'waiting', alreadyApproved: result.alreadyApproved });
      beginStatusPolling(code);
    } catch (err) {
      const classified = classifyApproveError(err);
      if (err instanceof ApiError && err.status === 409 && /already been completed/i.test(err.message)) {
        // Already fully paired (likely a duplicate click) — this is the
        // success path, not a dead end: confirm it by polling live status.
        setModalState({ phase: 'waiting', alreadyApproved: true });
        beginStatusPolling(code);
      } else {
        setModalState({ phase: 'error', ...classified });
      }
    } finally {
      setBusy(false);
    }
  };

  const approve = () => {
    const snapshot = { userCode, label, defaultCompany };
    setSubmitted(snapshot);
    setModalOpen(true);
    void submitApprove(snapshot.userCode, snapshot.label, snapshot.defaultCompany);
  };

  const retry = () => void submitApprove(submitted.userCode, submitted.label, submitted.defaultCompany);

  const closeModal = () => {
    stopPolling();
    setModalOpen(false);
  };

  const dismissible = modalState.phase !== 'submitting';

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
        <button onClick={approve} disabled={busy || !userCode} type="button">
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

      <Modal open={modalOpen} onClose={closeModal} title="Connecting your bridge" dismissible={dismissible}>
        <PairingSummary userCode={submitted.userCode} label={submitted.label} defaultCompany={submitted.defaultCompany} />

        {modalState.phase === 'submitting' && (
          <div className="pairing-state">
            <Spinner />
            <p>Approving code {submitted.userCode}…</p>
          </div>
        )}

        {modalState.phase === 'error' && (
          <>
            <div className="pairing-state">
              <IconAlert className="danger-color" />
              <p>{modalState.message}</p>
              {modalState.kind === 'expired' && (
                <p className="muted small">Restart pairing on the connector to get a fresh code.</p>
              )}
              {modalState.kind === 'not-found' && (
                <p className="muted small">Double-check the code for typos, or it may have expired.</p>
              )}
              {modalState.kind === 'conflict-other-org' && (
                <p className="muted small">
                  If this is your own code, someone else may have mistyped into the same organization — restart
                  pairing on the connector for a fresh code.
                </p>
              )}
            </div>
            <div className="modal-actions">
              {(modalState.kind === 'network' || modalState.kind === 'unknown') && (
                <button type="button" onClick={retry} disabled={busy}>
                  {busy && <Spinner />}
                  Retry
                </button>
              )}
              <button type="button" className="ghost" onClick={closeModal}>
                Close
              </button>
            </div>
          </>
        )}

        {modalState.phase === 'waiting' && (
          <div className="pairing-state">
            <Spinner />
            <p>
              {modalState.alreadyApproved ? 'Already approved — confirming' : 'Approved — waiting for'} the connector
              to come online…
            </p>
            <p className="muted small">
              {elapsedSeconds}s elapsed. Check the bridge's own terminal for "Authenticated" if this takes a while.
            </p>
          </div>
        )}

        {modalState.phase === 'connected' && (
          <>
            <div className="pairing-state">
              <IconCheck className="ok-color" />
              <p>
                <strong>Pairing successful!</strong>
              </p>
              <p className="muted small">
                {modalState.label}
                {modalState.defaultCompany ? ` — ${modalState.defaultCompany}` : ''} is now connected.
              </p>
            </div>
            <div className="modal-actions">
              {onPaired && (
                <button
                  type="button"
                  onClick={() => {
                    closeModal();
                    onPaired();
                  }}
                >
                  Go to Extractions →
                </button>
              )}
              <button type="button" className="ghost" onClick={closeModal}>
                Close
              </button>
            </div>
          </>
        )}

        {modalState.phase === 'timed-out' && (
          <>
            <div className="pairing-state">
              <IconAlert className="warn-color" />
              <p>Approved, but the connector hasn't come online yet.</p>
              <p className="muted small">
                Check the bridge's own terminal for errors, confirm it's actually running (
                <code>npm run start:agent</code>), and confirm it wrote <code>AGENT_TOKEN</code> to its own{' '}
                <code>.env</code>. A firewall blocking outbound WebSocket traffic can also cause this.
              </p>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => beginStatusPolling(submitted.userCode)}>
                Keep waiting
              </button>
              <button type="button" className="ghost" onClick={closeModal}>
                Close
              </button>
            </div>
          </>
        )}
      </Modal>
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
          <div className="callout callout-warning">
            <strong>
              <IconAlert /> This code is NOT from your real bridge
            </strong>
            <p className="muted small">
              Clicking "Start pairing" below generates a brand-new, separate code from this browser tab — it has
              nothing to do with whatever code your real connector bridge (<code>npm run start:agent</code>) printed
              to its own console. Do not mix the two up.
            </p>
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
