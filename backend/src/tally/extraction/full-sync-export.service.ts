import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { ExcelGeneratorService } from '../../excel/excel-generator.service';
import { sanitizeSheetName } from '../../excel/sheet-name.util';
import { ZOHO_ENTITIES, ZohoEntityKey } from '../../mapping/zoho-entity.map';
import { withLock } from '../../redis/lock.util';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { FULL_SYNC_QUICK_LOCK_TTL_MS } from './full-sync.constants';
import { TallyFullSyncMappingService } from './full-sync-mapping.service';
import { TallyFullSyncService } from './full-sync.service';

const NO_RECORDS_HEADER = ['(no records)'];

/**
 * Builds the one combined debug workbook the Full Sync Explorer's "Generate
 * Excel" button downloads: one sheet per RAW cached entity (masters + each
 * real voucher type, using whatever keys a fresh union of the cached rows
 * happens to have) PLUS one sheet per Zoho template (using the template's
 * real, full header list — computed via TallyFullSyncMappingService if not
 * already cached — so a column nothing ever populates still shows up,
 * blank). `VOUCHERS:ALL`/`COMPANY` are skipped: the former is redundant with
 * the per-type sheets and would just be one huge sparse-column sheet, the
 * latter is a single object, not a row list.
 */
@Injectable()
export class TallyFullSyncExportService {
  constructor(
    private readonly fullSync: TallyFullSyncService,
    private readonly mapping: TallyFullSyncMappingService,
    private readonly excel: ExcelGeneratorService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  async buildWorkbook(company: string): Promise<Buffer> {
    if (!this.redis) {
      throw new BadRequestException('Redis is not configured — the Excel export requires it.');
    }

    const result = await withLock(
      this.redis,
      this.fullSync.getLockKey(company),
      FULL_SYNC_QUICK_LOCK_TTL_MS,
      () => this.doBuildWorkbook(company),
    );
    if (result === null) {
      throw new BadRequestException(
        `A full sync for "${company}" is currently running — wait for it to finish (GET ` +
          '/tally/full-sync/status) before generating the Excel export.',
      );
    }
    return result;
  }

  private async doBuildWorkbook(company: string): Promise<Buffer> {
    const knownEntityTypes = await this.fullSync.listKnownEntityTypes(company);
    if (!knownEntityTypes) {
      throw new BadRequestException(
        `"${company}" needs a completed full sync first — run POST /tally/full-sync and wait for ` +
          'it to succeed.',
      );
    }

    const usedNames = new Set<string>();
    const sheets: Array<{ name: string; headers: string[]; rows: Array<Record<string, unknown>> }> =
      [];

    const rawEntityTypes = knownEntityTypes.filter(
      (type) => type !== 'COMPANY' && type !== 'VOUCHERS:ALL',
    );
    for (const entityType of rawEntityTypes) {
      const rows =
        (await this.fullSync.getEntitySnapshot<Array<Record<string, unknown>>>(
          company,
          entityType,
        )) ?? [];
      const headers = rows.length > 0 ? this.deriveDynamicHeaders(rows) : NO_RECORDS_HEADER;
      sheets.push({ name: this.uniqueSheetName(`RAW ${entityType}`, usedNames), headers, rows });
    }

    const mapped = await this.getOrComputeMapped(company);
    for (const key of Object.keys(ZOHO_ENTITIES) as ZohoEntityKey[]) {
      const entity = mapped[key];
      sheets.push({
        name: this.uniqueSheetName(`ZOHO ${key}`, usedNames),
        headers: entity.headers,
        rows: entity.rows,
      });
    }

    return this.excel.buildDebugWorkbook(sheets);
  }

  private async getOrComputeMapped(company: string) {
    const cached = await Promise.all(
      (Object.keys(ZOHO_ENTITIES) as ZohoEntityKey[]).map((key) => this.mapping.getMapped(company, key)),
    );
    if (cached.every((entity) => entity !== null)) {
      const result: Record<string, { headers: string[]; rows: Array<Record<string, unknown>> }> = {};
      (Object.keys(ZOHO_ENTITIES) as ZohoEntityKey[]).forEach((key, index) => {
        result[key] = cached[index]!;
      });
      return result as Record<ZohoEntityKey, { headers: string[]; rows: Array<Record<string, unknown>> }>;
    }
    // Not yet mapped (or partially expired) — compute it now, transparently,
    // rather than forcing the caller to click "Generate Zoho Mapping" first.
    // Uses the unlocked path since this method only ever runs inside
    // buildWorkbook's own withLock — calling the normal, self-locking
    // mapAll here would just fail to re-acquire the lock this call is
    // already holding.
    return this.mapping.mapAllUnlocked(company);
  }

  private deriveDynamicHeaders(rows: Array<Record<string, unknown>>): string[] {
    const seen = new Set<string>();
    const headers: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          headers.push(key);
        }
      }
    }
    return headers;
  }

  private uniqueSheetName(raw: string, usedLowercased: Set<string>): string {
    const name = sanitizeSheetName(raw, usedLowercased);
    usedLowercased.add(name.toLowerCase());
    return name;
  }
}
