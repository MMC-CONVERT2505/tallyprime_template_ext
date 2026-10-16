import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { ExcelGeneratorService } from '../../excel/excel-generator.service';
import { BillMapper } from '../../mapping/bill.mapper';
import { CostCentreMapper } from '../../mapping/cost-centre.mapper';
import { CreditNoteMapper } from '../../mapping/credit-note.mapper';
import { CustomerMapper } from '../../mapping/customer.mapper';
import { GroupHierarchyResolver } from '../../mapping/group-hierarchy.resolver';
import { InvoiceMapper } from '../../mapping/invoice.mapper';
import { LedgerMapper } from '../../mapping/ledger.mapper';
import { StockItemMapper } from '../../mapping/stock-item.mapper';
import { StockJournalMapper } from '../../mapping/stock-journal.mapper';
import { VendorMapper } from '../../mapping/vendor.mapper';
import { buildStockItemIndex, tallyDateToJsDate } from '../../mapping/voucher-line.shared';
import {
  ZOHO_ENTITIES,
  ZohoEntityKey,
  templatePathFor,
} from '../../mapping/zoho-entity.map';
import { withLock } from '../../redis/lock.util';
import { REDIS_CLIENT } from '../../redis/redis.module';
import {
  TallyCostCentre,
  TallyGroup,
  TallyLedger,
  TallyStockItem,
  TallyVoucher,
} from '../interfaces/tally.interfaces';
import { FULL_SYNC_QUICK_LOCK_TTL_MS } from './full-sync.constants';
import { TallyFullSyncService } from './full-sync.service';

export interface MappedZohoEntity {
  headers: string[];
  rows: Array<Record<string, unknown>>;
}

const VOUCHER_TYPE_BY_ENTITY: Partial<Record<ZohoEntityKey, string>> = {
  INVOICE: 'Sales',
  BILL: 'Purchase',
  CREDIT_NOTE: 'Credit Note',
  STOCK_JOURNAL: 'Stock Journal',
};

/**
 * Re-points ExtractionsService.getExcelResult's exact mapping logic at the
 * `tally:full:{company}:*` Redis snapshots TallyFullSyncService writes,
 * instead of a single ExtractionJob's cached result — there is no jobId in
 * this flow, just "everything currently cached for this company." Produces
 * every one of the 9 Zoho entities in one pass, each paired with its real
 * template's full header list (so a column nothing ever populates still
 * shows up, blank — the entire point of this debug feature) rather than only
 * the keys a mapped row object happens to have.
 *
 * A missing MASTER snapshot (GROUPS/LEDGERS/STOCK_ITEMS/COST_CENTRES) means
 * full sync never ran (or ran before Redis was available) — a clear
 * BadRequestException, matching getExcelResult's own wording style. A
 * missing VOUCHER-TYPE snapshot (e.g. no "Purchase Order" key) is NOT an
 * error — a company can legitimately have zero vouchers of a given type —
 * and is treated as an empty array instead.
 */
@Injectable()
export class TallyFullSyncMappingService {
  constructor(
    private readonly fullSync: TallyFullSyncService,
    private readonly excel: ExcelGeneratorService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /** Computes and caches all 9 Zoho entities' mapped rows for `company`,
   *  returning the same map `getMapped` would then read back piece by
   *  piece. Locked against a concurrent full sync for the same company —
   *  see TallyFullSyncService.getLockKey's doc comment. */
  async mapAll(company: string): Promise<Record<ZohoEntityKey, MappedZohoEntity>> {
    if (!this.redis) {
      throw new BadRequestException('Redis is not configured — the Zoho mapping step requires it.');
    }

    const result = await withLock(
      this.redis,
      this.fullSync.getLockKey(company),
      FULL_SYNC_QUICK_LOCK_TTL_MS,
      () => this.doMapAll(company),
    );
    if (result === null) {
      throw new BadRequestException(
        `A full sync for "${company}" is currently running — wait for it to finish (GET ` +
          '/tally/full-sync/status) before generating the Zoho mapping.',
      );
    }
    return result;
  }

  /** Reads one already-mapped entity back — `null` if `mapAll` hasn't been
   *  run yet (or its cache has since expired). */
  async getMapped(company: string, entity: ZohoEntityKey): Promise<MappedZohoEntity | null> {
    return this.fullSync.getEntitySnapshot<MappedZohoEntity>(company, this.mappedKey(entity));
  }

  /**
   * Writes one already-mapped entity's rows into its REAL Zoho template
   * (same file/sheet/column layout as the "Master and Invoice or Bill"
   * source templates and the production export — see
   * ExcelGeneratorService.writeIntoTemplate), producing the exact .xlsx a
   * human would otherwise get from the real Zoho export, but sourced from
   * this debug feature's cached mapping instead of a production
   * ExtractionJob. Requires POST .../map to have run first — same
   * "run mapping first" contract as getMapped, just surfaced as a
   * BadRequestException here since there is no caller to return null to.
   */
  async exportMappedExcel(company: string, entity: ZohoEntityKey): Promise<Buffer> {
    const mapped = await this.getMapped(company, entity);
    if (!mapped) {
      throw new BadRequestException(
        `No Zoho mapping cached yet for "${company}" — run POST /tally/full-sync/map first.`,
      );
    }
    const { sheetName } = ZOHO_ENTITIES[entity];
    return this.excel.writeIntoTemplate(templatePathFor(entity), sheetName, mapped.rows);
  }

  /**
   * Same computation as `mapAll`, WITHOUT acquiring the per-company lock —
   * for the one caller (TallyFullSyncExportService) that's already holding
   * that exact lock itself when it needs a fresh mapping computed on the
   * fly. `acquireLock`'s `SET NX` would simply fail as "already held" rather
   * than deadlock if `mapAll` were called instead, but skipping the
   * re-acquisition entirely is simpler than reasoning about that.
   */
  async mapAllUnlocked(company: string): Promise<Record<ZohoEntityKey, MappedZohoEntity>> {
    return this.doMapAll(company);
  }

  mappedKey(entity: ZohoEntityKey): string {
    return `MAPPED:${entity}`;
  }

  private async doMapAll(company: string): Promise<Record<ZohoEntityKey, MappedZohoEntity>> {
    const groups = await this.requireMaster<TallyGroup>(company, 'GROUPS');
    const ledgers = await this.requireMaster<TallyLedger>(company, 'LEDGERS');
    const stockItems = await this.requireMaster<TallyStockItem>(company, 'STOCK_ITEMS');
    const costCentres = await this.requireMaster<TallyCostCentre>(company, 'COST_CENTRES');

    const resolver = new GroupHierarchyResolver(groups);
    const itemIndex = buildStockItemIndex(stockItems);

    const salesVouchers = await this.optionalVoucherType(company, VOUCHER_TYPE_BY_ENTITY.INVOICE!);
    const purchaseVouchers = await this.optionalVoucherType(company, VOUCHER_TYPE_BY_ENTITY.BILL!);
    const creditNoteVouchers = await this.optionalVoucherType(
      company,
      VOUCHER_TYPE_BY_ENTITY.CREDIT_NOTE!,
    );
    const stockJournalVouchers = await this.optionalVoucherType(
      company,
      VOUCHER_TYPE_BY_ENTITY.STOCK_JOURNAL!,
    );

    const invoiceDatesByNumber = new Map<string, Date>();
    for (const voucher of salesVouchers) {
      const date = tallyDateToJsDate(voucher.date);
      if (voucher.voucherNumber && date) invoiceDatesByNumber.set(voucher.voucherNumber, date);
    }

    // Each mapper returns its own fixed-shape row interface (ZohoAccountRow,
    // ZohoCustomerRow, ...) rather than an indexable Record — perfectly type
    // -safe for their real callers (writeIntoTemplate<T extends object>),
    // but this class treats every entity's rows generically (for the JSON
    // preview endpoint and the debug workbook's dynamic-header writer
    // alike), so the cast is a deliberate, one-place erasure of that
    // specificity rather than a mistake.
    const rowsByEntity = {
      COA: new LedgerMapper(resolver).toAccountRows(ledgers),
      CUSTOMER: new CustomerMapper(resolver).toCustomerRows(ledgers),
      VENDOR: new VendorMapper(resolver).toVendorRows(ledgers),
      ITEM: new StockItemMapper().toItemRows(stockItems),
      COST_CENTRE: new CostCentreMapper().toReportingTagRows(costCentres),
      INVOICE: new InvoiceMapper(itemIndex).toInvoiceRows(salesVouchers),
      BILL: new BillMapper(itemIndex).toBillRows(purchaseVouchers),
      CREDIT_NOTE: new CreditNoteMapper(itemIndex, invoiceDatesByNumber).toCreditNoteRows(
        creditNoteVouchers,
      ),
      STOCK_JOURNAL: new StockJournalMapper(itemIndex).toStockJournalRows(stockJournalVouchers),
    } as unknown as Record<ZohoEntityKey, Array<Record<string, unknown>>>;

    const mapped: Partial<Record<ZohoEntityKey, MappedZohoEntity>> = {};
    for (const key of Object.keys(ZOHO_ENTITIES) as ZohoEntityKey[]) {
      const { sheetName } = ZOHO_ENTITIES[key];
      const headers = await this.excel.getTemplateHeaders(templatePathFor(key), sheetName);
      const entity: MappedZohoEntity = { headers, rows: rowsByEntity[key] };
      mapped[key] = entity;
      await this.fullSync.writeEntitySnapshot(company, this.mappedKey(key), entity);
    }
    return mapped as Record<ZohoEntityKey, MappedZohoEntity>;
  }

  private async requireMaster<T>(company: string, entityType: string): Promise<T[]> {
    const data = await this.fullSync.getEntitySnapshot<T[]>(company, entityType);
    if (data === null) {
      throw new BadRequestException(
        `Zoho mapping for "${company}" needs a completed full sync first (missing ${entityType}) — ` +
          'run POST /tally/full-sync and wait for it to succeed.',
      );
    }
    return data;
  }

  /** A voucher-type snapshot's absence is a legitimate "zero of this type,"
   *  not an error — see this class's doc comment. */
  private async optionalVoucherType(company: string, voucherType: string): Promise<TallyVoucher[]> {
    const data = await this.fullSync.getEntitySnapshot<TallyVoucher[]>(
      company,
      `VOUCHERS:${voucherType}`,
    );
    return data ?? [];
  }
}
