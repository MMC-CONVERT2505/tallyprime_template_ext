import { useState } from 'react';
import { ApiError, tallyApi } from '../api';
import { ErrorBanner, JsonView } from './JsonView';

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

export function TallyDirectPanel() {
  const [company, setCompany] = useState('');
  const [fromDate, setFromDate] = useState('20260401');
  const [toDate, setToDate] = useState('20260430');
  const [voucherType, setVoucherType] = useState('');
  const [reportName, setReportName] = useState('Trial Balance');

  const probe = useRunner(() => tallyApi.probe());
  const companies = useRunner(() => tallyApi.companies(true));
  const ledgers = useRunner(() => tallyApi.ledgers({ company, fromDate, toDate }));
  const stockItems = useRunner(() => tallyApi.stockItems({ company, fromDate, toDate }));
  const groups = useRunner(() => tallyApi.groups({ company }));
  const vouchers = useRunner(() => tallyApi.vouchers({ company, from: fromDate, to: toDate, voucherType }));
  const raw = useRunner(() => tallyApi.raw({ reportName, company: company || undefined }));

  return (
    <div className="panel">
      <div className="card">
        <h2>Tally Direct — dev sanity checks, no bridge needed</h2>
        <p className="muted">
          The BACKEND talks to Tally itself (its own TALLY_HOST/TALLY_PORT). Run Probe first to discover the exact
          company name string, then paste it below — every other request here needs it exact.
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
          <button onClick={() => void probe.run()} disabled={probe.busy} type="button">
            {probe.busy ? 'Running…' : 'Run'}
          </button>
        </div>
        <ErrorBanner message={probe.error} />
        <JsonView value={probe.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Companies</h3>
          <button onClick={() => void companies.run()} disabled={companies.busy} type="button">
            {companies.busy ? 'Running…' : 'Run'}
          </button>
        </div>
        <ErrorBanner message={companies.error} />
        <JsonView value={companies.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Ledgers (period-scoped)</h3>
          <button onClick={() => void ledgers.run()} disabled={ledgers.busy} type="button">
            {ledgers.busy ? 'Running…' : 'Run'}
          </button>
        </div>
        <ErrorBanner message={ledgers.error} />
        <JsonView value={ledgers.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Stock Items (period-scoped)</h3>
          <button onClick={() => void stockItems.run()} disabled={stockItems.busy} type="button">
            {stockItems.busy ? 'Running…' : 'Run'}
          </button>
        </div>
        <ErrorBanner message={stockItems.error} />
        <JsonView value={stockItems.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Groups</h3>
          <button onClick={() => void groups.run()} disabled={groups.busy} type="button">
            {groups.busy ? 'Running…' : 'Run'}
          </button>
        </div>
        <ErrorBanner message={groups.error} />
        <JsonView value={groups.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Vouchers</h3>
          <button onClick={() => void vouchers.run()} disabled={vouchers.busy} type="button">
            {vouchers.busy ? 'Running…' : 'Run'}
          </button>
        </div>
        <label>
          Voucher type (optional)
          <input value={voucherType} onChange={(e) => setVoucherType(e.target.value)} placeholder="Sales" />
        </label>
        <ErrorBanner message={vouchers.error} />
        <JsonView value={vouchers.result} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Raw report (escape hatch)</h3>
          <button onClick={() => void raw.run()} disabled={raw.busy} type="button">
            {raw.busy ? 'Running…' : 'Run'}
          </button>
        </div>
        <label>
          Report name
          <input value={reportName} onChange={(e) => setReportName(e.target.value)} />
        </label>
        <ErrorBanner message={raw.error} />
        {raw.result && (
          <pre className="json-view">{(raw.result as { rawXml: string }).rawXml}</pre>
        )}
      </div>
    </div>
  );
}
