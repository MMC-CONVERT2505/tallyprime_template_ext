import { useMemo, useState, type ReactNode } from 'react';
import { JsonView } from './JsonView';

const PAGE_SIZE = 25;

type Row = Record<string, unknown>;

function isTabular(value: unknown): value is Row[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
  );
}

/** Union of keys across every row, in first-seen order — safer than just
 *  row[0]'s keys for a field that's occasionally absent, without needing to
 *  know each extraction type's shape ahead of time. */
function deriveColumns(rows: Row[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}

function formatCell(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString();
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">—</span>;
    return (
      <details className="cell-detail">
        <summary>
          {value.length} item{value.length === 1 ? '' : 's'}
        </summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    );
  }
  if (typeof value === 'object') {
    return (
      <details className="cell-detail">
        <summary>Show</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    );
  }
  return String(value);
}

function rowMatches(row: Row, query: string): boolean {
  const q = query.toLowerCase();
  return Object.values(row).some((v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'object') return false; // nested blobs aren't searched — expand to inspect
    return String(v).toLowerCase().includes(q);
  });
}

function DataTable({ rows }: { rows: Row[] }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const columns = useMemo(() => deriveColumns(rows), [rows]);
  const filtered = useMemo(() => {
    const q = search.trim();
    return q ? rows.filter((r) => rowMatches(r, q)) : rows;
  }, [rows, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="data-table-wrap">
      <div className="data-table-toolbar">
        <input
          className="search-input"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder={`Search ${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}…`}
        />
        <span className="muted small">
          {filtered.length.toLocaleString()} row{filtered.length === 1 ? '' : 's'}
          {filtered.length !== rows.length ? ` (of ${rows.length.toLocaleString()})` : ''}
        </span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => (
              <tr key={currentPage * PAGE_SIZE + i}>
                {columns.map((c) => (
                  <td key={c}>{formatCell(row[c])}</td>
                ))}
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="muted">
                  No rows match "{search}".
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="data-table-pager">
          <button type="button" className="ghost" disabled={currentPage === 0} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </button>
          <span className="muted small">
            Page {currentPage + 1} of {pageCount}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The primary way extraction results are shown: a real, searchable,
 * paginated table for the tabular shape every extraction type actually
 * returns (array of same-shaped records), with a one-click fallback to raw
 * JSON for whoever wants the untransformed payload. Pagination is plain
 * client-side slicing (25 rows/page) — the result is already fully loaded in
 * memory by the time this renders, so this is just about not asking the DOM
 * to hold thousands of rows at once, not about re-fetching.
 */
export function ResultView({ value }: { value: unknown }) {
  const [showRaw, setShowRaw] = useState(false);
  const tabular = isTabular(value);

  if (!tabular) return <JsonView value={value} />;

  return (
    <div>
      <div className="result-view-toggle">
        <button type="button" className={showRaw ? 'ghost' : ''} onClick={() => setShowRaw(false)}>
          Table
        </button>
        <button type="button" className={showRaw ? '' : 'ghost'} onClick={() => setShowRaw(true)}>
          Raw JSON
        </button>
      </div>
      {showRaw ? <JsonView value={value} /> : <DataTable rows={value} />}
    </div>
  );
}
