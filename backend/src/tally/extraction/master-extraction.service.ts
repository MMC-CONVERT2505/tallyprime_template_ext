import { Injectable } from '@nestjs/common';
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

  async getLedgers(company?: string, fromDate?: string, toDate?: string): Promise<TallyLedger[]> {
    const resolved = this.resolveCompany(company);
    if (fromDate && toDate) this.assertDateRange(fromDate, toDate);
    return this.runExtraction(
      ExtractionType.LEDGERS,
      resolved,
      { company: resolved, fromDate: fromDate ?? null, toDate: toDate ?? null },
      async () => {
        const xml = this.builder.buildLedgersRequest(resolved, fromDate, toDate);
        const raw = await this.connector.post(xml);
        return this.parser.mapLedgers(raw);
      },
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
  ): Promise<TallyStockItem[]> {
    const resolved = this.resolveCompany(company);
    if (fromDate && toDate) this.assertDateRange(fromDate, toDate);
    return this.runExtraction(
      ExtractionType.STOCK_ITEMS,
      resolved,
      { company: resolved, fromDate: fromDate ?? null, toDate: toDate ?? null },
      async () => {
        const xml = this.builder.buildStockItemsRequest(resolved, fromDate, toDate);
        const raw = await this.connector.post(xml);
        return this.parser.mapStockItems(raw);
      },
    );
  }
}
