import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  connectionsApi,
  extractionsApi,
  EXCEL_EXPORTABLE_TYPES,
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

const EXTRACTABLE_TYPES: ExtractableType[] = [
  'COMPANIES',
  'LEDGERS',
  'STOCK_ITEMS',
  'GROUPS',
  'COST_CENTRES',
  'VOUCHERS',
  'RAW',
];
const MASTER_TYPES: MasterType[] = ['COMPANIES', 'LEDGERS', 'STOCK_ITEMS', 'GROUPS', 'COST_CENTRES'];

/** Fires a downloaded Blob as a file save — shared by the job-status card's
 *  "Download Excel" and the job list's per-row quick-download. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExtractionsPanel() {
  const { selectedCompany, selectCompany } = useSelectedCompany();
  // Server-backed job history (was session-only React state before — vanished
  // on refresh and gave the download flow nothing to work from but a job id
  // the user had to already know). Refreshed on mount, after creating a job,
  // and whenever the actively-polled job settles.
  const [jobs, setJobs] = useState<ExtractionJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<ExtractionJob | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [resultBusy, setResultBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
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
  // Re-entrancy guards on refs, not just the `*Busy` state: `disabled={busy}`
  // only blocks a second click once React has re-rendered the button, and a
  // fast double-click can fire the handler twice before that repaint lands.
  // For LEDGERS/STOCK_ITEMS that means two concurrent batched fetches
  // hitting the same Tally instance — the exact load pattern that can wedge
  // Tally's single-threaded HTTP server, not just waste a request. A ref
  // mutation is synchronous and closes that window outright.
  const createInFlight = useRef(false);
  const fetchInFlight = useRef(false);

  // fetch-master form (primary, one-click path)
  const [companyName, setCompanyName] = useState('');
  const [masterType, setMasterType] = useState<MasterType>('GROUPS');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [fetchBusy, setFetchBusy] = useState(false);

  // excel
  const [excelBusy, setExcelBusy] = useState(false);

  const refreshJobs = async () => {
    try {
      const list = await extractionsApi.list(50);
      setJobs(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setJobsLoading(false);
    }
  };

  useEffect(() => {
    void refreshJobs();
  }, []);

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

  /** Selects a freshly-created job and pulls it into the server-backed list
   *  immediately, rather than waiting for the next poll/refresh to show it. */
  const trackNewJob = (id: string) => {
    selectJob(id);
    void refreshJobs();
  };

  const createByConnection = async () => {
    if (createInFlight.current) return;
    createInFlight.current = true;
    setError(null);
    setCreateBusy(true);
    try {
      const res = await extractionsApi.create({
        connectionId,
        type,
        payload: payloadCompany ? { company: payloadCompany } : undefined,
      });
      trackNewJob(res.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      createInFlight.current = false;
      setCreateBusy(false);
    }
  };

  const fetchMaster = async () => {
    if (fetchInFlight.current) return;
    fetchInFlight.current = true;
    setError(null);
    setFetchBusy(true);
    try {
      const res = await extractionsApi.fetchMaster({
        companyName,
        masterType,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      });
      trackNewJob(res.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      fetchInFlight.current = false;
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
          void refreshJobs(); // pick up the settled status/recordCount in the list too
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

  // LEDGERS' companion GROUPS job and VOUCHERS' companion STOCK_ITEMS job
  // are auto-resolved server-side now (most recent successful match for the
  // same company) — no groupsJobId/itemsJobId to look up or type in here.
  const downloadExcel = async () => {
    if (!activeJobId) return;
    setExcelBusy(true);
    setError(null);
    try {
      saveBlob(await extractionsApi.excel(activeJobId), `extraction-${activeJobId}.xlsx`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setExcelBusy(false);
    }
  };

  /** Download straight from a job-list row, without first selecting it. */
  const quickDownload = async (job: ExtractionJob) => {
    setDownloadingId(job.id);
    setError(null);
    try {
      saveBlob(await extractionsApi.excel(job.id), `extraction-${job.id}.xlsx`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setDownloadingId(null);
    }
  };

  const statusPillClass = (status: ExtractionJob['status']) =>
    status === 'SUCCESS' ? 'pill pill-ok' : status === 'FAILED' ? 'pill pill-off' : 'pill';

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

      <div className="card">
        <div className="card-header">
          <h3>Jobs</h3>
          <button onClick={() => void refreshJobs()} disabled={jobsLoading} type="button" className="ghost">
            {jobsLoading && <Spinner />}
            Refresh
          </button>
        </div>
        {jobsLoading && jobs.length === 0 ? (
          <p className="muted">Loading…</p>
        ) : jobs.length === 0 ? (
          <EmptyState message="No extractions yet — fetch some data above to see it here." />
        ) : (
          <div className="job-list">
            {jobs.map((j) => (
              <div key={j.id} className={j.id === activeJobId ? 'job-row active' : 'job-row'}>
                <button type="button" className="job-row-main" onClick={() => selectJob(j.id)}>
                  <span className={statusPillClass(j.status)}>{j.status}</span>
                  <span>{j.type}</span>
                  <span className="muted">{j.company ?? '—'}</span>
                  <span className="muted small">{new Date(j.createdAt).toLocaleString()}</span>
                </button>
                {j.status === 'SUCCESS' && EXCEL_EXPORTABLE_TYPES.includes(j.type) && (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => void quickDownload(j)}
                    disabled={downloadingId === j.id}
                    title="Download Zoho-import-ready Excel"
                  >
                    {downloadingId === j.id ? <Spinner /> : 'Download'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {activeJobId && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <IconExtract />
              <h2>Job status</h2>
              {jobStatus && <span className={statusPillClass(jobStatus.status)}>{jobStatus.status}</span>}
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

          {jobStatus && EXCEL_EXPORTABLE_TYPES.includes(jobStatus.type) && (
            <div className="form form-row">
              <button
                onClick={() => void downloadExcel()}
                disabled={jobStatus?.status !== 'SUCCESS' || excelBusy}
                type="button"
              >
                {excelBusy && <Spinner />}
                {excelBusy ? 'Downloading…' : 'Download Excel'}
              </button>
            </div>
          )}

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
