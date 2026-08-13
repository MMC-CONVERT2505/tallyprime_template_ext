import { useEffect, useRef, useState } from 'react';
import { ApiError, tallyApi, tallyJobsApi, type ExtractableType } from '../api';
import { useSelectedCompany } from '../SelectedCompanyContext';
import { ErrorBanner } from './JsonView';
import { ResultView } from './ResultView';
import { IconDatabase } from './Icons';
import { Spinner } from './ui';

const POLL_INTERVAL_MS = 2000;

function useRunner<T>(fn: () => Promise<T>) {
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await fn());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { result, error, busy, run };
}

/**
 * Async counterpart of useRunner: queue via POST /tally/jobs instead of
 * blocking on the Tally call, poll until it settles, then fetch the result —
 * so a slow LEDGERS/VOUCHERS pull can't tie up this tab's fetch() the way it
 * used to (the exact 180s+ hangs this project hit against a slow/stuck
 * Tally). Same {result, error, busy, run} shape as useRunner, so the JSX
 * below barely changes.
 */
function useTallyJob<T>(type: ExtractableType) {
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, []);

  const run = async (payload?: Record<string, unknown>) => {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    setBusy(true);
    setError(null);
    setResult(null);
    setStatus(null);

    try {
      const { id } = await tallyJobsApi.create({ type, payload });
      setStatus('PENDING');

      const poll = async () => {
        try {
          const job = await tallyJobsApi.status(id);
          setStatus(job.status);
          if (job.status === 'SUCCESS') {
            if (pollTimer.current) window.clearInterval(pollTimer.current);
            setResult((await tallyJobsApi.result(id)) as T);
            setBusy(false);
          } else if (job.status === 'FAILED') {
            if (pollTimer.current) window.clearInterval(pollTimer.current);
            setError(job.error ?? 'Extraction failed.');
            setBusy(false);
          }
        } catch (err) {
          if (pollTimer.current) window.clearInterval(pollTimer.current);
          setError(err instanceof ApiError ? err.message : String(err));
          setBusy(false);
        }
      };

      void poll();
      pollTimer.current = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  };

  return { result, error, busy, status, run };
}

function RunButton({ busy, status, onClick }: { busy: boolean; status?: string | null; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={busy} type="button">
      {busy && <Spinner />}
      {busy ? (status && status !== 'PENDING' ? `${status}…` : 'Queued…') : 'Run'}
    </button>
  );
}

export function TallyDirectPanel() {
  const { selectedCompany } = useSelectedCompany();
  const [company, setCompany] = useState(selectedCompany ?? '');
  const [fromDate, setFromDate] = useState('20260401');
  const [toDate, setToDate] = useState('20260430');
  const [voucherType, setVoucherType] = useState('');
  const [reportName, setReportName] = useState('Trial Balance');

  // Probe stays synchronous — it's already a fast, no-retry health check
  // (TALLY_PROBE_TIMEOUT_MS), not a long-running pull worth queuing.
  const probe = useRunner(() => tallyApi.probe());

  const companies = useTallyJob<unknown[]>('COMPANIES');
  const ledgers = useTallyJob<unknown[]>('LEDGERS');
  const stockItems = useTallyJob<unknown[]>('STOCK_ITEMS');
  const groups = useTallyJob<unknown[]>('GROUPS');
  const vouchers = useTallyJob<unknown[]>('VOUCHERS');
  const raw = useTallyJob<{ reportName: string; company: string | null; rawXml: string; bytes: number }>('RAW');

  return (
    <div className="panel">
      <div className="card">
        <div className="card-title">
          <IconDatabase />
          <h2>Tally Direct — dev sanity checks, no bridge needed</h2>
        </div>
        <p className="muted">
          The BACKEND talks to Tally itself (its own TALLY_HOST/TALLY_PORT) — no connection/agent involved. Company
          is pre-filled from the one you're working with elsewhere, but editable here since this bypasses that
          entirely; run Probe first to confirm the exact company name string if unsure. Every report below runs as
          a queued, pollable job instead of blocking this request, so a slow Tally can't hang the page.
        </p>
        <div className="form form-row">
          <label>
            Company
            <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="exact Tally company name" />
          </label>
          <label>
            From (YYYYMMDD)
            <input value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label>
            To (YYYYMMDD)
            <input value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Probe</h3>
          <RunButton busy={probe.busy} onClick={() => void probe.run()} />
        </div>
        <ErrorBanner message={probe.error} />
        <ResultView value={probe.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Companies</h3>
          <RunButton busy={companies.busy} status={companies.status} onClick={() => void companies.run({ fresh: true })} />
        </div>
        <ErrorBanner message={companies.error} />
        <ResultView value={companies.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Ledgers (period-scoped)</h3>
          <RunButton
            busy={ledgers.busy}
            status={ledgers.status}
            onClick={() => void ledgers.run({ company, fromDate, toDate })}
          />
        </div>
        <ErrorBanner message={ledgers.error} />
        <ResultView value={ledgers.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Stock Items (period-scoped)</h3>
          <RunButton
            busy={stockItems.busy}
            status={stockItems.status}
            onClick={() => void stockItems.run({ company, fromDate, toDate })}
          />
        </div>
        <ErrorBanner message={stockItems.error} />
        <ResultView value={stockItems.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Groups</h3>
          <RunButton busy={groups.busy} status={groups.status} onClick={() => void groups.run({ company })} />
        </div>
        <ErrorBanner message={groups.error} />
        <ResultView value={groups.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Vouchers</h3>
          <RunButton
            busy={vouchers.busy}
            status={vouchers.status}
            onClick={() => void vouchers.run({ company, from: fromDate, to: toDate, voucherType: voucherType || undefined })}
          />
        </div>
        <label>
          Voucher type (optional)
          <input value={voucherType} onChange={(e) => setVoucherType(e.target.value)} placeholder="Sales" />
        </label>
        <ErrorBanner message={vouchers.error} />
        <ResultView value={vouchers.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Raw report (escape hatch)</h3>
          <RunButton
            busy={raw.busy}
            status={raw.status}
            onClick={() => void raw.run({ reportName, company: company || undefined })}
          />
        </div>
        <label>
          Report name
          <input value={reportName} onChange={(e) => setReportName(e.target.value)} />
        </label>
        <ErrorBanner message={raw.error} />
        {raw.result && <pre className="json-view">{raw.result.rawXml}</pre>}
      </div>
    </div>
  );
}
