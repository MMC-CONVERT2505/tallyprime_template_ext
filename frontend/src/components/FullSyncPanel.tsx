import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  fullSyncApi,
  type FullSyncRunStatus,
  type FullSyncStatus,
  type MappedZohoEntity,
  type ZohoEntityKey,
} from '../api';
import { useSelectedCompany } from '../SelectedCompanyContext';
import { ErrorBanner } from './JsonView';
import { ResultView } from './ResultView';
import { IconDownload, IconLayers } from './Icons';
import { EmptyState, Spinner } from './ui';

const POLL_INTERVAL_MS = 2000;
/** Above this many rows, JsonView's unguarded JSON.stringify can visibly
 *  freeze the tab (confirmed against a real 13k+ voucher "All vouchers"
 *  view) — the table itself still paginates fine at that size. */
const LARGE_ROW_THRESHOLD = 3000;

const ZOHO_ENTITY_LABELS: Record<ZohoEntityKey, string> = {
  COA: 'Chart of Accounts',
  CUSTOMER: 'Customer',
  VENDOR: 'Vendor',
  ITEM: 'Item',
  COST_CENTRE: 'Reporting Tag',
  INVOICE: 'Invoice',
  BILL: 'Bill',
  CREDIT_NOTE: 'Credit Note',
  STOCK_JOURNAL: 'Stock Journal',
};
const ZOHO_ENTITY_KEYS = Object.keys(ZOHO_ENTITY_LABELS) as ZohoEntityKey[];

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** "VOUCHERS:Sales" -> "Sales vouchers", "STOCK_ITEMS" -> "Stock Items". */
function rawEntityLabel(entityType: string): string {
  if (entityType === 'VOUCHERS:ALL') return 'All vouchers';
  if (entityType === 'COMPANY') return 'Company';
  if (entityType.startsWith('VOUCHERS:')) return `${entityType.slice('VOUCHERS:'.length)} vouchers`;
  return entityType
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

function statusPillClass(status: FullSyncRunStatus): string {
  return status === 'SUCCESS' ? 'pill pill-ok' : status === 'FAILED' ? 'pill pill-off' : 'pill';
}

interface RawFunction {
  key: string;
  label: string;
  count: number;
}

/**
 * The debugging workflow the raw `/tally/full-sync` extraction (already
 * live, see backend TallyFullSyncService) exists to serve: (1) trigger the
 * extraction and browse exactly what landed in Redis, function by function,
 * every column visible; (2) map that same cached data into the 9 Zoho
 * template shapes to see which real Zoho columns end up populated vs. blank;
 * (3) export one combined workbook (raw + mapped sheets) for offline review.
 * Deliberately its own tab, not folded into Extractions — this whole family
 * of endpoints is unauthenticated/direct-to-Tally (same posture as Tally
 * Direct), unlike Extractions' org-scoped, agent-mediated production path.
 */
export function FullSyncPanel() {
  const { selectedCompany } = useSelectedCompany();
  const [company, setCompany] = useState(selectedCompany ?? '');

  const [status, setStatus] = useState<FullSyncStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const extractInFlight = useRef(false);
  const [extractBusy, setExtractBusy] = useState(false);
  const pollTimer = useRef<number | null>(null);

  const [selectedRaw, setSelectedRaw] = useState<string | null>(null);
  const [rawData, setRawData] = useState<unknown>(null);
  const [rawBusy, setRawBusy] = useState(false);

  const mapInFlight = useRef(false);
  const [mapBusy, setMapBusy] = useState(false);
  const [mapped, setMapped] = useState(false);
  const [selectedZoho, setSelectedZoho] = useState<ZohoEntityKey | null>(null);
  const [zohoData, setZohoData] = useState<MappedZohoEntity | null>(null);
  const [zohoBusy, setZohoBusy] = useState(false);

  const [excelBusy, setExcelBusy] = useState(false);
  const [downloadingEntity, setDownloadingEntity] = useState<ZohoEntityKey | null>(null);

  const refreshStatus = async (forCompany: string) => {
    if (!forCompany) return;
    setStatusLoading(true);
    setError(null);
    try {
      setStatus(await fullSyncApi.status(forCompany));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setStatusLoading(false);
    }
  };

  // Poll while a run is in progress — stops itself the moment status leaves
  // RUNNING (success, failure, or this tab picking up a run already started
  // elsewhere via "Check status").
  useEffect(() => {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    if (status?.status !== 'RUNNING' || !company) return undefined;
    pollTimer.current = window.setInterval(() => void refreshStatus(company), POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.status, company]);

  const startExtraction = async () => {
    if (extractInFlight.current || !company) return;
    extractInFlight.current = true;
    setExtractBusy(true);
    setError(null);
    // A fresh run invalidates whatever was being browsed from a previous one.
    setSelectedRaw(null);
    setRawData(null);
    setMapped(false);
    setSelectedZoho(null);
    setZohoData(null);
    try {
      // Deliberately no fromDate/toDate — Full Sync always pulls the
      // company's COMPLETE history (Tally's own StartingFrom through today;
      // see backend TallyFullSyncService.doFullSync). Letting this be
      // manually scoped invites exactly the bug this comment replaces: a
      // guessed start date earlier than the company's real books silently
      // returns ZERO vouchers (live-confirmed, 2026-09-24) instead of an
      // error — Tally's Day Book export just comes back empty rather than
      // failing loudly. "Full Sync" means full; a narrower pull belongs to
      // the Extractions tab's date-scoped fetch instead.
      await fullSyncApi.start({ company });
      await refreshStatus(company);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      extractInFlight.current = false;
      setExtractBusy(false);
    }
  };

  const loadRawEntity = async (entityType: string) => {
    setSelectedRaw(entityType);
    setSelectedZoho(null);
    setZohoData(null);
    setRawBusy(true);
    setError(null);
    try {
      setRawData(await fullSyncApi.data({ company, entityType }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRawBusy(false);
    }
  };

  const generateMapping = async () => {
    if (mapInFlight.current || !company) return;
    mapInFlight.current = true;
    setMapBusy(true);
    setError(null);
    try {
      await fullSyncApi.map(company);
      setMapped(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      mapInFlight.current = false;
      setMapBusy(false);
    }
  };

  const loadZohoEntity = async (entity: ZohoEntityKey) => {
    setSelectedZoho(entity);
    setSelectedRaw(null);
    setRawData(null);
    setZohoBusy(true);
    setError(null);
    try {
      setZohoData(await fullSyncApi.mappedData({ company, entity }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setZohoBusy(false);
    }
  };

  /** Downloads one Zoho entity's mapped rows written into its real template
   *  file (same layout as "Master and Invoice or Bill") — independent of
   *  whether that entity's JSON preview is currently loaded/selected. */
  const downloadMappedExcel = async (entity: ZohoEntityKey) => {
    if (!company || downloadingEntity) return;
    setDownloadingEntity(entity);
    setError(null);
    try {
      const blob = await fullSyncApi.mappedDataExcel({ company, entity });
      saveBlob(blob, `${company}-${entity}.xlsx`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setDownloadingEntity(null);
    }
  };

  const downloadExcel = async () => {
    if (!company) return;
    setExcelBusy(true);
    setError(null);
    try {
      saveBlob(await fullSyncApi.excel(company), `${company}-full-sync-debug.xlsx`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setExcelBusy(false);
    }
  };

  const rawFunctions = useMemo<RawFunction[]>(() => {
    const manifest = status?.manifest;
    if (!manifest) return [];
    const masters = Object.entries(manifest.entityCounts)
      .filter(([key]) => key !== 'VOUCHERS')
      .map(([key, count]) => ({ key, label: rawEntityLabel(key), count }));
    const voucherTypes = Object.entries(manifest.voucherTypeBreakdown).map(([type, count]) => ({
      key: `VOUCHERS:${type}`,
      label: rawEntityLabel(`VOUCHERS:${type}`),
      count,
    }));
    return [
      ...masters,
      { key: 'COMPANY', label: 'Company', count: 1 },
      { key: 'VOUCHERS:ALL', label: 'All vouchers', count: manifest.entityCounts.VOUCHERS ?? 0 },
      ...voucherTypes,
    ];
  }, [status]);

  const rawIsLarge = Array.isArray(rawData) && rawData.length > LARGE_ROW_THRESHOLD;
  const succeeded = status?.status === 'SUCCESS';

  return (
    <div className="panel">
      <div className="card">
        <div className="card-title">
          <IconLayers />
          <h2>Full Sync Explorer</h2>
        </div>
        <p className="muted">
          Extracts every Tally master and voucher type for one company straight into Redis — no
          Excel yet, just the raw cache (see backend TallyFullSyncService). From here you can
          browse exactly what landed, map it into the 9 Zoho templates to see which columns end up
          populated vs. blank, and export one combined debug workbook. Same unauthenticated,
          direct-to-Tally connection as Tally Direct — no bridge needed.
        </p>
        <div className="form form-row">
          <label>
            Company
            <input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="exact Tally company name"
            />
          </label>
          <button onClick={() => void startExtraction()} disabled={extractBusy || !company} type="button">
            {extractBusy && <Spinner />}
            {extractBusy ? 'Starting…' : 'Extract All Tally Data'}
          </button>
          <button
            onClick={() => void refreshStatus(company)}
            disabled={!company || statusLoading}
            type="button"
            className="ghost"
          >
            {statusLoading && <Spinner />}
            Check status
          </button>
        </div>
        {status && status.status !== 'NOT_STARTED' && (
          <div className="form-row" style={{ marginTop: 10, alignItems: 'center', gap: 10 }}>
            <span className={statusPillClass(status.status)}>{status.status}</span>
            {status.status === 'RUNNING' && (
              <span className="muted small">
                Running since {status.startedAt ? new Date(status.startedAt).toLocaleTimeString() : '—'}{' '}
                — a large company can take several minutes (verified live: ~8 min for 13k+ vouchers).
              </span>
            )}
            {status.status === 'FAILED' && <span className="muted small">{status.error}</span>}
            {succeeded && status.manifest && (
              <span className="muted small">
                {Object.values(status.manifest.entityCounts)
                  .reduce((a, b) => a + b, 0)
                  .toLocaleString()}{' '}
                total record(s) as of {new Date(status.manifest.extractedAt).toLocaleString()}
              </span>
            )}
          </div>
        )}
      </div>

      <ErrorBanner message={error} />

      {succeeded && (
        <div className="card">
          <div className="card-title">
            <IconLayers />
            <h2>1. Extracted data (raw, as cached from Tally)</h2>
          </div>
          {rawFunctions.length === 0 ? (
            <EmptyState message="No data cached yet." />
          ) : (
            <div className="chip-row">
              {rawFunctions.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={selectedRaw === f.key ? 'chip active' : 'chip'}
                  onClick={() => void loadRawEntity(f.key)}
                >
                  {f.label}
                  <span className="chip-count">{f.count.toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}
          {rawBusy && <p className="muted small">Loading…</p>}
          {!rawBusy && selectedRaw && (
            <>
              {rawIsLarge && (
                <p className="muted small" style={{ marginTop: 8 }}>
                  {(rawData as unknown[]).length.toLocaleString()} rows — Raw JSON is disabled here
                  (it would freeze the tab at this size); the table below still paginates fine, or
                  use "Generate Excel" below for the full data.
                </p>
              )}
              <div style={{ marginTop: 8 }}>
                <ResultView value={rawData} disableRawView={rawIsLarge} />
              </div>
            </>
          )}
        </div>
      )}

      {succeeded && (
        <div className="card">
          <div className="card-title">
            <IconLayers />
            <h2>2. Map into Zoho templates</h2>
          </div>
          <p className="muted">
            Runs the same mappers the production Zoho export uses, against the cached data above —
            no new Tally calls. Shows every real Zoho column, including ones nothing populates, so
            you can see exactly what's missing.
          </p>
          <div className="form-row">
            <button onClick={() => void generateMapping()} disabled={mapBusy} type="button">
              {mapBusy && <Spinner />}
              {mapBusy ? 'Mapping…' : mapped ? 'Re-run Zoho Mapping' : 'Generate Zoho Mapping'}
            </button>
          </div>
          {mapped && (
            <div className="chip-row" style={{ marginTop: 12 }}>
              {ZOHO_ENTITY_KEYS.map((key) => (
                <div className="chip-with-action" key={key}>
                  <button
                    type="button"
                    className={selectedZoho === key ? 'chip active' : 'chip'}
                    onClick={() => void loadZohoEntity(key)}
                  >
                    {ZOHO_ENTITY_LABELS[key]}
                  </button>
                  <button
                    type="button"
                    className="chip-download-btn"
                    onClick={() => void downloadMappedExcel(key)}
                    disabled={downloadingEntity !== null}
                    title={`Download ${ZOHO_ENTITY_LABELS[key]} as a Zoho Excel template`}
                  >
                    {downloadingEntity === key ? <Spinner /> : <IconDownload />}
                  </button>
                </div>
              ))}
            </div>
          )}
          {zohoBusy && <p className="muted small">Loading…</p>}
          {!zohoBusy && zohoData && (
            <div style={{ marginTop: 8 }}>
              <ResultView value={zohoData.rows} />
            </div>
          )}
        </div>
      )}

      {succeeded && (
        <div className="card">
          <div className="card-title">
            <IconLayers />
            <h2>3. Export</h2>
          </div>
          <p className="muted">
            One combined .xlsx workbook: a sheet per raw function above, plus a sheet per Zoho
            template (computed on the fly if step 2 hasn't been run yet) — the shareable, offline
            form of everything above, for spotting field-mapping gaps at a glance.
          </p>
          <button onClick={() => void downloadExcel()} disabled={excelBusy} type="button">
            {excelBusy && <Spinner />}
            {excelBusy ? 'Generating…' : 'Generate Excel (Raw + Mapped)'}
          </button>
        </div>
      )}
    </div>
  );
}
