import { Injectable } from '@nestjs/common';
import { ExtractionJob } from '@prisma/client';
import {
  TallyCompany,
  TallyGroup,
  TallyLedger,
  TallyStockItem,
} from '../interfaces/tally.interfaces';
import { ExtractionType, TallyExtractionServiceBase } from './tally-extraction.base';

const COMPANIES_CACHE_KEY = 'tally:companies';
const COMPANIES_CACHE_TTL_SECONDS = 15;

/**
 * One independently-callable, independently-testable method per Tally master
 * type. Today: Companies, Ledgers, Groups, Stock Items — the masters this
 * project's Tally↔Zoho mapping (docs/tally-zoho-function-mapping.md) actually
 * needs right now. Adding another master (Godowns, Cost Centres, Currencies,
 * ...) means one more method here plus one more EnvelopeBuilder/
 * TallyResponseParser pair — nothing else in this class needs to change.
 */
@Injectable()
export class MasterExtractionService extends TallyExtractionServiceBase {
  async getCompanies(useCache = true): Promise<TallyCompany[]> {
    if (useCache) {
      const cached = await this.readCache<TallyCompany[]>(COMPANIES_CACHE_KEY);
      if (cached) return cached;
    }

    const result = await this.runExtraction(ExtractionType.COMPANIES, null, {}, async () => {
      const xml = this.builder.buildCompaniesRequest();
      const raw = await this.connector.post(xml);
      return this.parser.mapCompanies(raw);
    });

    await this.writeCache(COMPANIES_CACHE_KEY, result, COMPANIES_CACHE_TTL_SECONDS);
    return result;
  }

  async getLedgers(
    company?: string,
    fromDate?: string,
    toDate?: string,
    signal?: AbortSignal,
  ): Promise<TallyLedger[]> {
    const resolved = this.resolveCompany(company);
    if (fromDate && toDate) this.assertDateRange(fromDate, toDate);
    return this.runExtraction(
      ExtractionType.LEDGERS,
      resolved,
      { company: resolved, fromDate: fromDate ?? null, toDate: toDate ?? null },
      (job) => this.fetchLedgersBatched(resolved, fromDate, toDate, signal, job),
    );
  }

  async getGroups(company?: string): Promise<TallyGroup[]> {
    const resolved = this.resolveCompany(company);
    return this.runExtraction(ExtractionType.GROUPS, resolved, { company: resolved }, async () => {
      const xml = this.builder.buildGroupsRequest(resolved);
      const raw = await this.connector.post(xml);
      return this.parser.mapGroups(raw);
    });
  }

  async getStockItems(
    company?: string,
    fromDate?: string,
    toDate?: string,
    signal?: AbortSignal,
  ): Promise<TallyStockItem[]> {
    const resolved = this.resolveCompany(company);
    if (fromDate && toDate) this.assertDateRange(fromDate, toDate);
    return this.runExtraction(
      ExtractionType.STOCK_ITEMS,
      resolved,
      { company: resolved, fromDate: fromDate ?? null, toDate: toDate ?? null },
      (job) => this.fetchStockItemsBatched(resolved, fromDate, toDate, signal, job),
    );
  }

  /**
   * A large company's ledger collection can make Tally hang or time out if
   * asked for in one unbounded request. Below `masterBatchSize` this is
   * exactly the single request it always was — no behavior change for the
   * common case. Above it, a cheap Name+AlterID pass establishes the total
   * count, which is then split into batches, each fetched as a normal
   * full-field request scoped via an AlterID range filter (see
   * EnvelopeBuilder.buildLedgersRequest's `alterIdRange` param) — a plain
   * integer, not a name. Two name-based approaches were tried first and both
   * broke on real data: an alphabetical range mismatched Tally's own string
   * collation against JavaScript's sort order (one batch returned zero
   * records, another more than its slice), and exact-name matching silently
   * missed ~4% of records whose names contained a literal `&#13;&#10;`
   * marker (Tally's own encoding of an embedded CR/LF pasted into a name
   * field, which doesn't round-trip through a TDL string literal the same
   * way Tally compares it internally). AlterID has none of that ambiguity —
   * it's a plain number Tally bumps on every change, already one of the
   * fields fetched here.
   *
   * Each batch uses `retries: 0` — same reasoning as
   * TransactionExtractionService's date chunking: batching already trades one
   * big risky call for several small reliable ones, so a batch that times out
   * anyway is more likely a genuinely stuck Tally than a transient blip.
   *
   * The final count cross-check exists because a subtly wrong filter would
   * otherwise silently drop or duplicate records rather than error —
   * unacceptable for financial data. The expected total is the FULL cheap-pass
   * count (before filtering out any record with a null AlterID, which
   * shouldn't happen for a real persisted record but is not assumed away) —
   * any mismatch, including one caused by an unexpectedly null AlterID,
   * throws instead of returning partial data. This is exactly what caught
   * both name-based bugs during testing, before either could ship
   * incomplete data.
   */
  private async fetchLedgersBatched(
    company: string,
    fromDate?: string,
    toDate?: string,
    signal?: AbortSignal,
    job?: ExtractionJob | null,
  ): Promise<TallyLedger[]> {
    const namesXml = await this.connector.post(this.builder.buildLedgerNamesRequest(company), {
      signal,
    });
    const allEntries = this.parser.mapLedgers(namesXml);
    const totalCount = allEntries.length;
    const batchable = allEntries
      .filter((l): l is TallyLedger & { alterId: number } => l.alterId !== null)
      .sort((a, b) => a.alterId - b.alterId);
    if (batchable.length !== totalCount) {
      this.logger.warn(
        `LEDGERS for "${company}": ${totalCount - batchable.length} record(s) have no AlterID ` +
          'and cannot be batched — the count cross-check below will catch this.',
      );
    }

    if (totalCount <= this.tally.masterBatchSize) {
      const xml = this.builder.buildLedgersRequest(company, fromDate, toDate);
      const raw = await this.connector.post(xml, { signal });
      return this.parser.mapLedgers(raw);
    }

    const batchCount = Math.ceil(batchable.length / this.tally.masterBatchSize);
    this.logger.log(
      `LEDGERS for "${company}": ${totalCount} record(s) — batching into ` +
        `${batchCount} request(s) of at most ${this.tally.masterBatchSize}.`,
    );

    const results: TallyLedger[] = [];
    for (let i = 0; i < batchable.length; i += this.tally.masterBatchSize) {
      if (signal?.aborted) throw new Error('Extraction cancelled.');
      const batch = batchable.slice(i, i + this.tally.masterBatchSize);
      const startedAt = Date.now();
      const alterIdRange = { from: batch[0].alterId, to: batch[batch.length - 1].alterId };
      const xml = this.builder.buildLedgersRequest(company, fromDate, toDate, alterIdRange);
      const raw = await this.connector.post(xml, { retries: 0, signal });
      const parsed = this.parser.mapLedgers(raw);
      results.push(...parsed);
      const progressMsg =
        `batch ${i / this.tally.masterBatchSize + 1}/${batchCount} ` +
        `(AlterID ${alterIdRange.from}-${alterIdRange.to}, ${batch.length} expected): ` +
        `${parsed.length} record(s) in ${Date.now() - startedAt}ms`;
      this.logger.log(`  ${progressMsg}`);
      await this.reportProgress(job ?? null, progressMsg);

      const isLastBatch = i + this.tally.masterBatchSize >= batchable.length;
      if (!isLastBatch && this.tally.chunkDelayMs > 0) {
        await this.sleep(this.tally.chunkDelayMs, signal);
      }
    }

    if (results.length !== totalCount) {
      throw new Error(
        `Batched LEDGERS fetch for "${company}" returned ${results.length} record(s), ` +
          `expected ${totalCount} — a batch likely dropped or duplicated ` +
          'records. Not returning partial data.',
      );
    }
    return results;
  }

  /** Stock-item counterpart of fetchLedgersBatched — see its doc comment for the full rationale. */
  private async fetchStockItemsBatched(
    company: string,
    fromDate?: string,
    toDate?: string,
    signal?: AbortSignal,
    job?: ExtractionJob | null,
  ): Promise<TallyStockItem[]> {
    const namesXml = await this.connector.post(this.builder.buildStockItemNamesRequest(company), {
      signal,
    });
    const allEntries = this.parser.mapStockItems(namesXml);
    const totalCount = allEntries.length;
    const batchable = allEntries
      .filter((s): s is TallyStockItem & { alterId: number } => s.alterId !== null)
      .sort((a, b) => a.alterId - b.alterId);
    if (batchable.length !== totalCount) {
      this.logger.warn(
        `STOCK_ITEMS for "${company}": ${totalCount - batchable.length} record(s) have no AlterID ` +
          'and cannot be batched — the count cross-check below will catch this.',
      );
    }

    if (totalCount <= this.tally.masterBatchSize) {
      const xml = this.builder.buildStockItemsRequest(company, fromDate, toDate);
      const raw = await this.connector.post(xml, { signal });
      return this.parser.mapStockItems(raw);
    }

    const batchCount = Math.ceil(batchable.length / this.tally.masterBatchSize);
    this.logger.log(
      `STOCK_ITEMS for "${company}": ${totalCount} record(s) — batching into ` +
        `${batchCount} request(s) of at most ${this.tally.masterBatchSize}.`,
    );

    const results: TallyStockItem[] = [];
    for (let i = 0; i < batchable.length; i += this.tally.masterBatchSize) {
      if (signal?.aborted) throw new Error('Extraction cancelled.');
      const batch = batchable.slice(i, i + this.tally.masterBatchSize);
      const startedAt = Date.now();
      const alterIdRange = { from: batch[0].alterId, to: batch[batch.length - 1].alterId };
      const xml = this.builder.buildStockItemsRequest(company, fromDate, toDate, alterIdRange);
      const raw = await this.connector.post(xml, { retries: 0, signal });
      const parsed = this.parser.mapStockItems(raw);
      results.push(...parsed);
      const progressMsg =
        `batch ${i / this.tally.masterBatchSize + 1}/${batchCount} ` +
        `(AlterID ${alterIdRange.from}-${alterIdRange.to}, ${batch.length} expected): ` +
        `${parsed.length} record(s) in ${Date.now() - startedAt}ms`;
      this.logger.log(`  ${progressMsg}`);
      await this.reportProgress(job ?? null, progressMsg);

      const isLastBatch = i + this.tally.masterBatchSize >= batchable.length;
      if (!isLastBatch && this.tally.chunkDelayMs > 0) {
        await this.sleep(this.tally.chunkDelayMs, signal);
      }
    }

    if (results.length !== totalCount) {
      throw new Error(
        `Batched STOCK_ITEMS fetch for "${company}" returned ${results.length} record(s), ` +
          `expected ${totalCount} — a batch likely dropped or duplicated ` +
          'records. Not returning partial data.',
      );
    }
    return results;
  }
}
