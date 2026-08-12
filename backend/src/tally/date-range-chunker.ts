export interface DateChunk {
  from: string;
  to: string;
}

/**
 * Splits [fromDate, toDate] (both YYYYMMDD, inclusive) into contiguous,
 * non-overlapping chunks of at most `chunkDays` days each.
 *
 * Exists specifically for VOUCHERS (Day Book) extraction: unlike a ledger's
 * balance-as-of-date (which Tally computes by walking history from the
 * company's books-from date regardless of how wide the requested window is —
 * splitting THAT by date multiplies work without reducing it), a Day Book
 * export's size scales directly with the number of days requested. Chunking
 * turns one large, timeout-prone request into several small, reliable ones.
 * See TransactionExtractionService.getVouchers for the caller.
 *
 * Dates are parsed/compared as UTC noon (not midnight) specifically to dodge
 * DST-adjacent date math bugs in some JS engines — irrelevant here since
 * these are calendar dates with no time-of-day meaning, but cheap insurance.
 */
export function chunkDateRange(fromDate: string, toDate: string, chunkDays: number): DateChunk[] {
  if (chunkDays < 1) {
    throw new Error(`chunkDays must be >= 1, got ${chunkDays}`);
  }

  const start = parseYyyyMmDd(fromDate);
  const end = parseYyyyMmDd(toDate);
  if (start > end) {
    throw new Error(`fromDate (${fromDate}) must not be after toDate (${toDate})`);
  }

  const chunks: DateChunk[] = [];
  let chunkStart = start;
  while (chunkStart <= end) {
    const chunkEnd = new Date(
      Math.min(addDays(chunkStart, chunkDays - 1).getTime(), end.getTime()),
    );
    chunks.push({ from: formatYyyyMmDd(chunkStart), to: formatYyyyMmDd(chunkEnd) });
    chunkStart = addDays(chunkEnd, 1);
  }
  return chunks;
}

function parseYyyyMmDd(s: string): Date {
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function formatYyyyMmDd(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function addDays(d: Date, days: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, 12));
}
