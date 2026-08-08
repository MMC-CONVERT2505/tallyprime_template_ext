import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  extractionsApi,
  type ExtractableType,
  type ExtractionJob,
  type MasterType,
} from '../api';
import { ErrorBanner, JsonView } from './JsonView';

const EXTRACTABLE_TYPES: ExtractableType[] = ['COMPANIES', 'LEDGERS', 'STOCK_ITEMS', 'GROUPS', 'VOUCHERS', 'RAW'];
const MASTER_TYPES: MasterType[] = ['COMPANIES', 'LEDGERS', 'STOCK_ITEMS', 'GROUPS'];

interface TrackedJob {
  id: string;
  label: string;
}

export function ExtractionsPanel() {
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<ExtractionJob | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  // by-connectionId form
  const [connectionId, setConnectionId] = useState('');
  const [type, setType] = useState<ExtractableType>('GROUPS');
  const [payloadCompany, setPayloadCompany] = useState('');

  // fetch-master form
  const [companyName, setCompanyName] = useState('');
  const [masterType, setMasterType] = useState<MasterType>('GROUPS');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // excel
  const [groupsJobIdForExcel, setGroupsJobIdForExcel] = useState('');
  const [excelBusy, setExcelBusy] = useState(false);

  const track = (id: string, label: string) => {
    setJobs((prev) => [{ id, label }, ...prev].slice(0, 10));
    setActiveJobId(id);
    setResult(null);
  };

  const createByConnection = async () => {
    setError(null);
    try {
      const res = await extractionsApi.create({
        connectionId,
        type,
        payload: payloadCompany ? { company: payloadCompany } : undefined,
      });
      track(res.id, `${type} via connectionId`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const fetchMaster = async () => {
    setError(null);
    try {
      const res = await extractionsApi.fetchMaster({
        companyName,
        masterType,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      });
      track(res.id, `${masterType} via fetch-master`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
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
    try {
      setResult(await extractionsApi.result(activeJobId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

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

  return (
    <div className="panel">
      <div className="card">
        <h2>Create extraction — by connectionId</h2>
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
          <button onClick={() => void createByConnection()} type="button">
            Create
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Fetch master — by company name</h2>
        <p className="muted">Resolves the connector automatically. Requires exactly one active, online connection paired to this company.</p>
        <div className="form form-row">
          <label>
            Company name
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="exact Tally company name" />
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
            From date (ISO, optional)
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label>
            To date (ISO, optional)
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>
          <button onClick={() => void fetchMaster()} type="button">
            Fetch master
          </button>
        </div>
      </div>

      <ErrorBanner message={error} />

      {jobs.length > 0 && (
        <div className="card">
          <h2>Jobs (this session)</h2>
          <div className="job-list">
            {jobs.map((j) => (
              <button
                key={j.id}
                type="button"
                className={j.id === activeJobId ? 'job-chip active' : 'job-chip'}
                onClick={() => setActiveJobId(j.id)}
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
            <h2>
              Job status{' '}
              {jobStatus && (
                <span
                  className={
                    jobStatus.status === 'SUCCESS'
                      ? 'pill pill-ok'
                      : jobStatus.status === 'FAILED'
                        ? 'pill pill-off'
                        : 'pill'
                  }
                >
                  {jobStatus.status}
                </span>
              )}
            </h2>
            <div className="actions">
              <button onClick={() => void loadResult()} disabled={jobStatus?.status !== 'SUCCESS'} type="button">
                View result
              </button>
            </div>
          </div>
          <JsonView value={jobStatus} />

          <div className="form form-row">
            <label>
              groupsJobId (only for LEDGERS excel)
              <input value={groupsJobIdForExcel} onChange={(e) => setGroupsJobIdForExcel(e.target.value)} />
            </label>
            <button onClick={() => void downloadExcel()} disabled={jobStatus?.status !== 'SUCCESS' || excelBusy} type="button">
              {excelBusy ? 'Downloading…' : 'Download Excel'}
            </button>
          </div>

          {result !== null && (
            <>
              <h3>Result</h3>
              <JsonView value={result} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
