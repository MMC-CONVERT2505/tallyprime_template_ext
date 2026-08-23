import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  bulkExportApi,
  connectionsApi,
  extractionsApi,
  EXCEL_EXPORTABLE_TYPES,
  type BulkExportRecord,
  type ConnectionSummary,
  type ExtractableType,
  type ExtractionJob,
  type MasterType,
} from '../api';
import { useSelectedCompany } from '../SelectedCompanyContext';
import { ErrorBanner, JsonView } from './JsonView';
import { ResultView } from './ResultView';
import { IconChevronRight, IconExtract } from './Icons';
import { EmptyState, Spinner } from './ui';

type BulkRowAction = 'download' | 'retry' | 'delete';

/** A cluster of standalone (non-bulk-export) single-type jobs that share a
 *  company and the same requested date range — e.g. GROUPS/LEDGERS/
 *  STOCK_ITEMS/COST_CENTRES/VOUCHERS fetched one at a time for the same org
 *  and period instead of via "Run full export". Shown as one expandable row,
 *  same as a formal bulk export, so History reads as one group per real
 *  extraction effort instead of N disconnected rows. */
interface JobGroup {
  key: string;
  company: string;
  from?: string;
  to?: string;
  jobs: ExtractionJob[];
  latestCreatedAt: string;
}

/** One entry in the unified History list below — a full bulk export, a
 *  cluster of related standalone jobs, or (when a "cluster" would only ever
 *  have one member) a single plain job row — merged and sorted by recency. */
type HistoryEntry =
  | { kind: 'bulk'; record: BulkExportRecord }
  | { kind: 'jobGroup'; group: JobGroup }
  | { kind: 'job'; job: ExtractionJob };

/** LEDGERS/STOCK_ITEMS use fromDate/toDate; VOUCHERS uses from/to; GROUPS/
 *  COST_CENTRES/COMPANIES carry no date scope at all — see each type's
 *  params shape in MasterExtractionService/TransactionExtractionService. */
function dateRangeOf(job: ExtractionJob): { from?: string; to?: string } {
  const params = job.params as Record<string, unknown> | null;
  if (!params) return {};
  const from = (params.fromDate ?? params.from) as string | undefined;
  const to = (params.toDate ?? params.to) as string | undefined;
  return { from: from || undefined, to: to || undefined };
}

function groupKeyOf(job: ExtractionJob): string {
  const { from, to } = dateRangeOf(job);
  return `${job.company ?? '—'}::${from ?? ''}::${to ?? ''}`;
}

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
  const [jobRowBusy, setJobRowBusy] = useState<Partial<Record<string, 'delete'>>>({});
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(new Set());
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

  // Full Zoho export (all 9 "Master and Invoice or Bill" templates, zipped).
  // Its own live progress lives in the unified History list below, not a
  // separate status block here — starting one just adds/refreshes a row
  // there (expanded automatically) and the History poll picks it up.
  const [bulkFromDate, setBulkFromDate] = useState('');
  const [bulkToDate, setBulkToDate] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkInFlight = useRef(false);

  // Bulk-export history — separate list from `jobs` (single-type extraction
  // jobs) because they're fetched from a different endpoint, but merged with
  // it for display (see historyEntries below) so "History" reads as one
  // unified, chronological list rather than two disconnected ones.
  const [bulkExports, setBulkExports] = useState<BulkExportRecord[]>([]);
  const [bulkExportsLoading, setBulkExportsLoading] = useState(true);
  const [expandedBulkIds, setExpandedBulkIds] = useState<Set<string>>(new Set());
  const [bulkRowBusy, setBulkRowBusy] = useState<Partial<Record<string, BulkRowAction>>>({});
  // Mirrors `bulkExports` for the polling interval below, which needs the
  // latest list without re-subscribing/restarting a timer every time it
  // changes (a plain closure over `bulkExports` would only ever see its
  // value from whenever the interval was created).
  const bulkExportsRef = useRef<BulkExportRecord[]>([]);

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

  const refreshBulkExports = async () => {
    try {
      const list = await bulkExportApi.list(20);
      setBulkExports(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBulkExportsLoading(false);
    }
  };

  useEffect(() => {
    void refreshBulkExports();
  }, []);

  useEffect(() => {
    bulkExportsRef.current = bulkExports;
  }, [bulkExports]);

  // One persistent interval for the component's lifetime rather than
  // starting/stopping a timer per in-flight export — each tick only
  // actually hits the network when the latest list has something still
  // PENDING/RUNNING, so an idle history costs nothing.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const hasInFlight = bulkExportsRef.current.some(
        (b) => b.status === 'PENDING' || b.status === 'RUNNING',
      );
      if (hasInFlight) void refreshBulkExports();
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshHistory = async () => {
    await Promise.all([refreshJobs(), refreshBulkExports()]);
  };

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

  /** Kicks off the full "every Zoho template for this company, in one zip"
   *  export — see backend BulkExportService's doc comment for the exact
   *  8-fetch + generate + zip step sequence. Its progress shows up as a row
   *  in the History list below (auto-expanded), kept fresh by the polling
   *  effect above — no separate per-export status view to manage here. */
  const startBulkExport = async () => {
    if (bulkInFlight.current || !companyName || !bulkFromDate || !bulkToDate) return;
    bulkInFlight.current = true;
    setError(null);
    setBulkBusy(true);
    try {
      const res = await bulkExportApi.start({
        companyName,
        fromDate: bulkFromDate,
        toDate: bulkToDate,
      });
      await refreshBulkExports();
      setExpandedBulkIds((prev) => new Set(prev).add(res.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      bulkInFlight.current = false;
      setBulkBusy(false);
    }
  };

  const toggleBulkExpanded = (id: string) => {
    setExpandedBulkIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const downloadBulkExportRow = async (record: BulkExportRecord) => {
    setBulkRowBusy((prev) => ({ ...prev, [record.id]: 'download' }));
    setError(null);
    try {
      saveBlob(await bulkExportApi.download(record.id), record.filename ?? `zoho-export-${record.id}.zip`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBulkRowBusy((prev) => ({ ...prev, [record.id]: undefined }));
    }
  };

  /** "Retry Failed Functions" — the server computes what's actually still
   *  broken (see bulkExportApi.retry's doc comment); refreshing the list
   *  picks the row back up as PENDING/RUNNING, and the poll effect keeps it
   *  live from there. */
  const retryBulkExportRow = async (id: string) => {
    setBulkRowBusy((prev) => ({ ...prev, [id]: 'retry' }));
    setError(null);
    try {
      await bulkExportApi.retry(id);
      await refreshBulkExports();
      setExpandedBulkIds((prev) => new Set(prev).add(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBulkRowBusy((prev) => ({ ...prev, [id]: undefined }));
    }
  };

  const deleteBulkExportRow = async (id: string) => {
    if (!window.confirm('Delete this export from history? This cannot be undone.')) return;
    setBulkRowBusy((prev) => ({ ...prev, [id]: 'delete' }));
    setError(null);
    try {
      await bulkExportApi.remove(id);
      setBulkExports((prev) => prev.filter((b) => b.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBulkRowBusy((prev) => ({ ...prev, [id]: undefined }));
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

  const deleteJobRow = async (id: string) => {
    if (!window.confirm('Delete this extraction from history? This cannot be undone.')) return;
    setJobRowBusy((prev) => ({ ...prev, [id]: 'delete' }));
    setError(null);
    try {
      await extractionsApi.remove(id);
      setJobs((prev) => prev.filter((j) => j.id !== id));
      if (activeJobId === id) {
        setActiveJobId(null);
        setResult(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setJobRowBusy((prev) => ({ ...prev, [id]: undefined }));
    }
  };

  const toggleGroupExpanded = (key: string) => {
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const statusPillClass = (status: ExtractionJob['status']) =>
    status === 'SUCCESS' ? 'pill pill-ok' : status === 'FAILED' ? 'pill pill-off' : 'pill';

  const bulkStatusPillClass = (status: string) =>
    status === 'SUCCESS' ? 'pill pill-ok' : status === 'FAILED' ? 'pill pill-off' : 'pill';

  // A bulk export's own 8 function jobs + generate/zip already show up
  // nested under its History row (see the expand toggle below) — surfacing
  // them AGAIN as flat standalone rows would just be duplicate, disconnected
  // noise, so they're filtered out of the plain job list here.
  const bulkJobIds = useMemo(
    () =>
      new Set(
        bulkExports.flatMap((b) =>
          b.steps.map((s) => s.jobId).filter((jobId): jobId is string => Boolean(jobId)),
        ),
      ),
    [bulkExports],
  );
  const standaloneJobs = useMemo(() => jobs.filter((j) => !bulkJobIds.has(j.id)), [jobs, bulkJobIds]);

  // Clusters standalone jobs fetched one function at a time (GROUPS,
  // LEDGERS, STOCK_ITEMS, COST_CENTRES, VOUCHERS, ...) into one group per
  // (company, date range) — the same real-world "extraction effort" a
  // formal bulk export represents, just assembled organically instead of
  // through "Run full export". A group of exactly one job renders as a
  // plain row further down (see historyEntries) rather than an unnecessary
  // one-item expandable wrapper.
  const jobGroups = useMemo<JobGroup[]>(() => {
    const byKey = new Map<string, JobGroup>();
    for (const job of standaloneJobs) {
      const key = groupKeyOf(job);
      const existing = byKey.get(key);
      if (existing) {
        existing.jobs.push(job);
        if (job.createdAt > existing.latestCreatedAt) existing.latestCreatedAt = job.createdAt;
      } else {
        const { from, to } = dateRangeOf(job);
        byKey.set(key, {
          key,
          company: job.company ?? '—',
          from,
          to,
          jobs: [job],
          latestCreatedAt: job.createdAt,
        });
      }
    }
    return Array.from(byKey.values());
  }, [standaloneJobs]);

  const historyEntries = useMemo<HistoryEntry[]>(() => {
    const entries: HistoryEntry[] = [
      ...bulkExports.map((record) => ({ kind: 'bulk' as const, record })),
      ...jobGroups.map((group): HistoryEntry =>
        group.jobs.length > 1 ? { kind: 'jobGroup', group } : { kind: 'job', job: group.jobs[0] },
      ),
    ];
    // ISO 8601 timestamps sort correctly as plain strings — newest first.
    const timestampOf = (entry: HistoryEntry): string => {
      if (entry.kind === 'bulk') return entry.record.createdAt;
      if (entry.kind === 'jobGroup') return entry.group.latestCreatedAt;
      return entry.job.createdAt;
    };
    entries.sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)));
    return entries;
  }, [bulkExports, jobGroups]);

  const historyLoading = jobsLoading || bulkExportsLoading;

  const jobGroupStatusSummary = (jobs: ExtractionJob[]): { text: string; cls: string } => {
    const failed = jobs.filter((j) => j.status === 'FAILED').length;
    const pending = jobs.filter((j) => j.status === 'PENDING').length;
    if (failed > 0) return { text: `${failed} failed`, cls: 'pill pill-off' };
    if (pending > 0) return { text: `${pending} pending`, cls: 'pill' };
    return { text: 'All succeeded', cls: 'pill pill-ok' };
  };

  /** Shared by a standalone single-job row and each member of an expanded
   *  job group — status/type/company/timestamp plus Download (when
   *  applicable) and Delete (once it's left PENDING). */
  const renderJobRow = (j: ExtractionJob) => (
    <div key={j.id} className={j.id === activeJobId ? 'job-row active' : 'job-row'}>
      <button type="button" className="job-row-main" onClick={() => selectJob(j.id)}>
        <span className={statusPillClass(j.status)}>{j.status}</span>
        <span>{j.type}</span>
        <span className="muted">{j.company ?? '—'}</span>
        <span className="muted small">{new Date(j.createdAt).toLocaleString()}</span>
      </button>
      <div className="actions">
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
        {j.status !== 'PENDING' && (
          <button
            type="button"
            className="danger small"
            onClick={() => void deleteJobRow(j.id)}
            disabled={jobRowBusy[j.id] === 'delete'}
            title="Delete this extraction from history"
          >
            {jobRowBusy[j.id] === 'delete' ? <Spinner /> : 'Delete'}
          </button>
        )}
      </div>
    </div>
  );

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
            <select
              value={masterType}
              onChange={(e) => {
                const next = e.target.value as MasterType;
                setMasterType(next);
                // A period-scoped Stock Items fetch is rejected server-side
                // by default — confirmed live to wedge Tally regardless of
                // batch size (see backend TallyConfig.stockItemsPeriodScopingEnabled).
                // Clearing the dates here avoids a guaranteed-to-fail
                // request rather than letting the user hit that error.
                if (next === 'STOCK_ITEMS') {
                  setFromDate('');
                  setToDate('');
                }
              }}
            >
              {MASTER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            From date {masterType === 'STOCK_ITEMS' ? '(disabled for Stock Items)' : '(optional)'}
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              disabled={masterType === 'STOCK_ITEMS'}
            />
          </label>
          <label>
            To date {masterType === 'STOCK_ITEMS' ? '(disabled for Stock Items)' : '(optional)'}
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              disabled={masterType === 'STOCK_ITEMS'}
            />
          </label>
          <button onClick={() => void fetchMaster()} disabled={fetchBusy || !companyName} type="button">
            {fetchBusy && <Spinner />}
            {fetchBusy ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
        {masterType === 'STOCK_ITEMS' && (
          <p className="muted small" style={{ marginTop: 8 }}>
            Stock Items always fetches the current opening balance (unscoped) — a date-scoped fetch
            is disabled because it&apos;s confirmed to hang this kind of Tally request.
          </p>
        )}
      </div>

      <div className="card">
        <div className="card-title">
          <IconExtract />
          <h2>Full Zoho export (all 9 templates)</h2>
        </div>
        <p className="muted">
          Pulls every Zoho-mapped entity for the selected company — Chart of Accounts, Customers, Vendors, Items,
          Reporting Tags, Invoices, Bills, Credit Notes, and Inventory Adjustments — and packages the real "Master
          and Invoice or Bill" templates, fully seeded, into one downloadable .zip. Runs sequentially against Tally
          (one connector, one request at a time), so a large company can take several minutes.
        </p>
        <div className="form form-row">
          <label>
            From date
            <input type="date" value={bulkFromDate} onChange={(e) => setBulkFromDate(e.target.value)} />
          </label>
          <label>
            To date
            <input type="date" value={bulkToDate} onChange={(e) => setBulkToDate(e.target.value)} />
          </label>
          <button
            onClick={() => void startBulkExport()}
            disabled={bulkBusy || !companyName || !bulkFromDate || !bulkToDate}
            type="button"
          >
            {bulkBusy && <Spinner />}
            {bulkBusy ? 'Starting…' : 'Run full export (.zip)'}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          Progress shows up in History below as one row per run — expand it to see each of its 8
          function jobs.
        </p>
      </div>

      <ErrorBanner message={error} />

      <div className="card">
        <div className="card-header">
          <h3>History</h3>
          <button onClick={() => void refreshHistory()} disabled={historyLoading} type="button" className="ghost">
            {historyLoading && <Spinner />}
            Refresh
          </button>
        </div>
        {historyLoading && historyEntries.length === 0 ? (
          <p className="muted">Loading…</p>
        ) : historyEntries.length === 0 ? (
          <EmptyState message="No extractions yet — fetch some data above to see it here." />
        ) : (
          <div className="job-list">
            {historyEntries.map((entry) => {
              if (entry.kind === 'job') {
                return renderJobRow(entry.job);
              }

              if (entry.kind === 'jobGroup') {
                const { group } = entry;
                const expanded = expandedGroupKeys.has(group.key);
                const summary = jobGroupStatusSummary(group.jobs);
                const rangeLabel = group.from && group.to ? `${group.from} → ${group.to}` : 'No date range';
                const sortedMembers = [...group.jobs].sort((a, b) =>
                  b.createdAt.localeCompare(a.createdAt),
                );
                return (
                  <div key={group.key} className="job-row-group">
                    <div className="job-row">
                      <button
                        type="button"
                        className={expanded ? 'job-row-toggle expanded' : 'job-row-toggle'}
                        onClick={() => toggleGroupExpanded(group.key)}
                        aria-expanded={expanded}
                        aria-label={expanded ? 'Collapse extraction group' : 'Expand extraction group'}
                      >
                        <IconChevronRight />
                      </button>
                      <div className="job-row-summary">
                        <span className={summary.cls}>{summary.text}</span>
                        <span className="job-row-title">Extraction group ({group.jobs.length})</span>
                        <span className="muted">{group.company}</span>
                        <span className="muted small">{rangeLabel}</span>
                        <span className="muted small">
                          {new Date(group.latestCreatedAt).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    {expanded && (
                      <div className="job-list job-row-substeps">
                        {sortedMembers.map((j) => renderJobRow(j))}
                      </div>
                    )}
                  </div>
                );
              }

              // A full "run full export" job: one row for the whole run,
              // expandable to reveal its 8 individual function jobs (plus
              // the generate/zip finishing steps) instead of scattering
              // those across the flat list as 10 disconnected entries.
              const record = entry.record;
              const expanded = expandedBulkIds.has(record.id);
              const busy = bulkRowBusy[record.id];
              const inFlight = record.status === 'PENDING' || record.status === 'RUNNING';
              return (
                <div key={record.id} className="job-row-group">
                  <div className="job-row">
                    <button
                      type="button"
                      className={expanded ? 'job-row-toggle expanded' : 'job-row-toggle'}
                      onClick={() => toggleBulkExpanded(record.id)}
                      aria-expanded={expanded}
                      aria-label={expanded ? 'Collapse function jobs' : 'Expand function jobs'}
                    >
                      <IconChevronRight />
                    </button>
                    <div className="job-row-summary">
                      <span className={bulkStatusPillClass(record.status)}>{record.status}</span>
                      <span className="job-row-title">Full export</span>
                      <span className="muted">{record.company}</span>
                      <span className="muted small">
                        {record.fromDate} → {record.toDate}
                      </span>
                      <span className="muted small">{new Date(record.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="actions">
                      {record.status === 'SUCCESS' && (
                        <button
                          type="button"
                          className="ghost small"
                          onClick={() => void downloadBulkExportRow(record)}
                          disabled={busy === 'download'}
                        >
                          {busy === 'download' ? <Spinner /> : 'Download .zip'}
                        </button>
                      )}
                      {record.status === 'FAILED' && (
                        <button
                          type="button"
                          className="ghost small"
                          onClick={() => void retryBulkExportRow(record.id)}
                          disabled={busy === 'retry'}
                        >
                          {busy === 'retry' ? <Spinner /> : 'Retry Failed Functions'}
                        </button>
                      )}
                      {!inFlight && (
                        <button
                          type="button"
                          className="danger small"
                          onClick={() => void deleteBulkExportRow(record.id)}
                          disabled={busy === 'delete'}
                          title="Delete this export from history"
                        >
                          {busy === 'delete' ? <Spinner /> : 'Delete'}
                        </button>
                      )}
                    </div>
                  </div>
                  {expanded && (
                    <>
                      {record.error && <ErrorBanner message={record.error} />}
                      <ul className="bulk-export-steps job-row-substeps">
                        {record.steps.map((step) => (
                          <li key={step.key}>
                            <span className={bulkStatusPillClass(step.status)}>{step.status}</span>
                            <span>{step.label}</span>
                            {step.recordCount !== undefined && (
                              <span className="muted small">{step.recordCount} record(s)</span>
                            )}
                            {step.error && <span className="muted small">{step.error}</span>}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              );
            })}
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
