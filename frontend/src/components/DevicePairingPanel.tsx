import { useEffect, useRef, useState } from 'react';
import { ApiError, deviceAuthApi, type DeviceStartResult } from '../api';
import { ErrorBanner } from './JsonView';

export function DevicePairingPanel() {
  const [start, setStart] = useState<DeviceStartResult | null>(null);
  const [defaultCompany, setDefaultCompany] = useState('');
  const [label, setLabel] = useState('Web console pairing');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<{ id: string; label: string; token: string } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const pollTimer = useRef<number | null>(null);
  const countdownTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
      if (countdownTimer.current) window.clearInterval(countdownTimer.current);
    };
  }, []);

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
        <h2>Device pairing — no manual token</h2>
        <p className="muted">
          This is what a real connector bridge does automatically on first boot. Here it's simulated in-browser: this
          page plays the role of the bridge (Start + auto-poll) AND the approving human (Approve), so you can see the
          whole RFC 8628-style flow without a separate process. A real bridge only needs the Approve step done
          elsewhere — see <code>docs/connector-bridge-setup-guide.md</code>.
        </p>
        <button onClick={() => void beginPairing()} disabled={busy} type="button">
          {busy ? 'Working…' : 'Start pairing'}
        </button>

        {start && !approved && (
          <div className="callout">
            <div className="user-code">{start.userCode}</div>
            <p className="muted">
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
                />
              </label>
              <button onClick={() => void approve()} disabled={busy} type="button">
                Approve this code
              </button>
            </div>
          </div>
        )}

        {approved && (
          <div className="callout callout-success">
            <strong>Paired! connectionId: {approved.id}</strong>
            <p className="muted">
              Token (shown once — this is what a real bridge would save into its own .env as AGENT_TOKEN):
            </p>
            <code className="token-box">{approved.token}</code>
          </div>
        )}

        <ErrorBanner message={error} />
      </div>
    </div>
  );
}
