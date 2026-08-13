import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  connectionsApi,
  extractionsApi,
  type ConnectionSummary,
  type ExtractableType,
  type ExtractionJob,
  type MasterType,
} from '../api';
import { useSelectedCompany } from '../SelectedCompanyContext';
import { ErrorBanner, JsonView } from './JsonView';
import { ResultView } from './ResultView';
import { IconExtract } from './Icons';
import { EmptyState, Spinner } from './ui';

const EXTRACTABLE_TYPES: ExtractableType[] = ['COMPANIES', 'LEDGERS', 'STOCK_ITEMS', 'GROUPS', 'VOUCHERS', 'RAW'];
const MASTER_TYPES: MasterType[] = ['COMPANIES', 'LEDGERS', 'STOCK_ITEMS', 'GROUPS'];

interface TrackedJob {
  id: string;
  label: string;
}

export function ExtractionsPanel() {
  const { selectedCompany, selectCompany } = useSelectedCompany();
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<ExtractionJob | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [resultBusy, setResultBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  // Paired companies, for the primary flow's picker — no connectionId ever
  // shown or typed by the user; the backend resolves it (see fetch-master).
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);

  // by-connectionId form (advanced/power-user path)
  const [connectionId, setConnectionId] = useState('');
  const [type, setType] = useState<ExtractableType>('GROUPS');
  const [payloadCompany, setPayloadCompany] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  // fetch-master form (primary, one-click path)
  const [companyName, setCompanyName] = useState('');
  const [masterType, setMasterType] = useState<MasterType>('GROUPS');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [fetchBusy, setFetchBusy] = useState(false);

  // excel
  const [groupsJobIdForExcel, setGroupsJobIdForExcel] = useState('');
  const [excelBusy, setExcelBusy] = useState(false);

  useEffect(() => {
    connectionsApi
      .list()
      .then(setConnections)
      .catch(() => undefined) // non-fatal — the picker just falls back to free text below
      .finally(() => setConnectionsLoaded(true));
  }, []);

  const pairedCompanies = useMemo(() => {
    const names = connections.filter((c) => c.isActive && c.defaultCompany).map((c) => c.defaultCompany as string);
    return Array.from(new Set(names));
  }, [connections]);

  // Prefer the company the user is already working with elsewhere (set on
  // Connections or Device Pairing) so it's never picked twice; only fall back
  // to "whatever's first" when nothing is selected yet. Free text stays
  // available below when nothing is paired at all.
  useEffect(() => {
    if (pairedCompanies.length === 0) return;
    if (selectedCompany && pairedCompanies.includes(selectedCompany)) {
      setCompanyName(selectedCompany);
    } else if (!companyName) {
      setCompanyName(pairedCompanies[0]);
    }
  }, [pairedCompanies, selectedCompany, companyName]);

  const chooseCompany = (name: string) => {
    setCompanyName(name);
    selectCompany(name);
  };

  const selectJob = (id: string) => {
    setActiveJobId(id);
    setResult(null);
  };

  const track = (id: string, label: string) => {
    setJobs((prev) => [{ id, label }, ...prev].slice(0, 10));
    selectJob(id);
  };

  const createByConnection = async () => {
    setError(null);
    setCreateBusy(true);
    try {
      const res = await extractionsApi.create({
        connectionId,
        type,
        payload: payloadCompany ? { company: payloadCompany } : undefined,
      });
      track(res.id, `${type} via connectionId`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const fetchMaster = async () => {
    setError(null);
    setFetchBusy(true);
    try {
      const res = await extractionsApi.fetchMaster({
        companyName,
        masterType,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      });
      track(res.id, `${masterType} — ${companyName}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setFetchBusy(false);
    }
  };

  // Poll the active job's status every 2s until it settles.
  useEffect(() => {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    setJobStatus(null);
    if (!activeJobId) return;

    const poll = async () => {
      try {
        const status = await extractionsApi.status(activeJobId);
        setJobStatus(status);
        if (status.status !== 'PENDING' && pollTimer.current) {
          window.clearInterval(pollTimer.current);
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
        if (pollTimer.current) window.clearInterval(pollTimer.current);
      }
    };

    void poll();
    pollTimer.current = window.setInterval(() => void poll(), 2000);
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, [activeJobId]);

  const loadResult = async () => {
    if (!activeJobId) return;
    setError(null);
    setResultBusy(true);
    try {
      setResult(await extractionsApi.result(activeJobId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setResultBusy(false);
    }
  };

  // As close to one-click as the underlying job queue allows: the moment a
  // job succeeds, load its result automatically instead of waiting for a
  // manual "View result" click.
  useEffect(() => {
    if (jobStatus?.status === 'SUCCESS' && result === null && !resultBusy) {
      void loadResult();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId, jobStatus?.status]);

  const downloadExcel = async () => {
    if (!activeJobId) return;
    setExcelBusy(true);
    setError(null);
    try {
      const blob = await extractionsApi.excel(activeJobId, groupsJobIdForExcel || undefined);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `extraction-${activeJobId}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setExcelBusy(false);
    }
  };

  const statusPillClass =
    jobStatus?.status === 'SUCCESS' ? 'pill pill-ok' : jobStatus?.status === 'FAILED' ? 'pill pill-off' : 'pill';

  return (
    <div className="panel">
      <div className="card">
        <div className="card-title">
          <IconExtract />
          <h2>Fetch data</h2>
        </div>
        {connectionsLoaded && pairedCompanies.length === 0 ? (
          <EmptyState message="No company is paired yet — pair one via the Device Pairing tab first." />
        ) : (
          <p className="muted">Pick a paired company and go — the connector is resolved automatically.</p>
        )}
        <div className="form form-row">
          <label>
            Company
            {pairedCompanies.length > 0 ? (
              <select value={companyName} onChange={(e) => chooseCompany(e.target.value)}>
                {pairedCompanies.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="exact Tally company name"
              />
            )}
          </label>
          <label>
            Master type
            <select value={masterType} onChange={(e) => setMasterType(e.target.value as MasterType)}>
              {MASTER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            From date (optional)
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label>
            To date (optional)
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>
          <button onClick={() => void fetchMaster()} disabled={fetchBusy || !companyName} type="button">
            {fetchBusy && <Spinner />}
            {fetchBusy ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
      </div>

      <ErrorBanner message={error} />

      {jobs.length > 0 && (
        <div className="card">
          <h3>Jobs (this session)</h3>
          <div className="job-list">
            {jobs.map((j) => (
              <button
                key={j.id}
                type="button"
                className={j.id === activeJobId ? 'job-chip active' : 'job-chip'}
                onClick={() => selectJob(j.id)}
              >
                {j.label}
                <span className="muted small"> {j.id.slice(0, 8)}…</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {activeJobId && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <IconExtract />
              <h2>Job status</h2>
              {jobStatus && <span className={statusPillClass}>{jobStatus.status}</span>}
            </div>
            <div className="actions">
              <button
                onClick={() => void loadResult()}
                disabled={jobStatus?.status !== 'SUCCESS' || resultBusy}
                type="button"
                className="ghost"
              >
                {resultBusy && <Spinner />}
                Reload result
              </button>
            </div>
          </div>
          <JsonView value={jobStatus} />

          <div className="form form-row">
            <label>
              groupsJobId (only for LEDGERS excel)
              <input value={groupsJobIdForExcel} onChange={(e) => setGroupsJobIdForExcel(e.target.value)} />
            </label>
            <button
              onClick={() => void downloadExcel()}
              disabled={jobStatus?.status !== 'SUCCESS' || excelBusy}
              type="button"
            >
              {excelBusy && <Spinner />}
              {excelBusy ? 'Downloading…' : 'Download Excel'}
            </button>
          </div>

          {result !== null && (
            <>
              <h3 style={{ marginTop: 14 }}>Result</h3>
              <ResultView value={result} />
            </>
          )}
        </div>
      )}

      <details className="advanced">
        <summary>Advanced: create by connectionId</summary>
        <div className="card">
          <div className="card-title">
            <IconExtract />
            <h2>Create extraction — by connectionId</h2>
          </div>
          <p className="muted">
            Power-user / debugging path: bypasses company resolution and targets one connector directly. The
            primary flow above (Fetch data) never needs this.
          </p>
          <div className="form form-row">
            <label>
              Connection ID
              <input value={connectionId} onChange={(e) => setConnectionId(e.target.value)} placeholder="uuid" />
            </label>
            <label>
              Type
              <select value={type} onChange={(e) => setType(e.target.value as ExtractableType)}>
                {EXTRACTABLE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              payload.company (optional)
              <input value={payloadCompany} onChange={(e) => setPayloadCompany(e.target.value)} />
            </label>
            <button onClick={() => void createByConnection()} disabled={createBusy} type="button">
              {createBusy && <Spinner />}
              Create
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
