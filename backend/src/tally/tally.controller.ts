import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Response } from 'express';
import { CreateTallyJobDto } from './dto/create-tally-job.dto';
import {
  ExtractLedgersDto,
  ExtractVouchersDto,
  FullSyncDataQueryDto,
  FullSyncMappedQueryDto,
  RawReportDto,
} from './dto/extract.dto';
import { TallyFullSyncExportService } from './extraction/full-sync-export.service';
import { TallyFullSyncMappingService } from './extraction/full-sync-mapping.service';
import { TallyFullSyncService } from './extraction/full-sync.service';
import { MasterExtractionService } from './extraction/master-extraction.service';
import { TransactionExtractionService } from './extraction/transaction-extraction.service';
import { TallyDiagnosticsService } from './tally-diagnostics.service';
import { TallyJobsService } from './tally-jobs.service';

/**
 * Direct Tally endpoints — kept for dev/testing against a Tally on the same
 * machine/network (see docs/architecture.md). The tunnel/job path
 * (POST /extractions, POST /extractions/fetch-master) is what the web app
 * actually uses in production, driving the same underlying services through
 * the connector agent instead.
 *
 * Two ways to call these: the synchronous GET/POST routes below block until
 * Tally answers (fine for a quick Probe, risky for a big LEDGERS/VOUCHERS
 * pull — see the timeout/retry pain this caused live). POST /tally/jobs is
 * the async alternative — queue, poll GET /tally/jobs/:id, fetch
 * GET /tally/jobs/:id/result — same queue/worker/result-caching machinery as
 * the agent-mediated job API, just dispatched locally. Both stay available;
 * neither is deprecated.
 */
@Controller('tally')
export class TallyController {
  constructor(
    private readonly masters: MasterExtractionService,
    private readonly transactions: TransactionExtractionService,
    private readonly diagnostics: TallyDiagnosticsService,
    private readonly jobs: TallyJobsService,
    private readonly fullSync: TallyFullSyncService,
    private readonly fullSyncMapping: TallyFullSyncMappingService,
    private readonly fullSyncExport: TallyFullSyncExportService,
  ) {}

  /**
   * Connectivity + discovery probe. Returns the list of companies currently
   * open in Tally and how long the round-trip took. First thing to hit after
   * pointing TALLY_HOST/PORT at a client's machine.
   */
  @Get('probe')
  probe() {
    return this.diagnostics.probe();
  }

  /** All companies loaded in Tally (short-cached). */
  @Get('companies')
  companies(@Query('fresh') fresh?: string) {
    return this.masters.getCompanies(fresh !== 'true');
  }

  /** Lean ledger master list (Name, Parent, Opening/Closing balance, AlterID). */
  @Get('ledgers')
  ledgers(@Query() query: ExtractLedgersDto) {
    return this.masters.getLedgers(query.company, query.fromDate, query.toDate);
  }

  /** Lean stock item master list (Name, Parent, BaseUnits, Opening/Closing balance+value, AlterID). */
  @Get('stock-items')
  stockItems(@Query() query: ExtractLedgersDto) {
    return this.masters.getStockItems(query.company, query.fromDate, query.toDate);
  }

  /** Group master list (Name, Parent, AlterID) — resolves ledger/stock-item hierarchy, no Zoho entity of its own. */
  @Get('groups')
  groups(@Query() query: ExtractLedgersDto) {
    return this.masters.getGroups(query.company);
  }

  /** Cost Centre master list (Name, Parent, AlterID) — maps to Zoho Books' Reporting Tag. */
  @Get('cost-centres')
  costCentres(@Query() query: ExtractLedgersDto) {
    return this.masters.getCostCentres(query.company);
  }

  /** Vouchers for a date range, optionally filtered by voucher type. */
  @Get('vouchers')
  vouchers(@Query() query: ExtractVouchersDto) {
    return this.transactions.getVouchers(query);
  }

  /**
   * Remaining standard master types (added 2026-09-19 — see
   * TallyFullSyncService's doc comment for the comprehensive-extraction
   * effort these belong to). Same shape/style as the master routes above.
   */
  @Get('stock-groups')
  stockGroups(@Query() query: ExtractLedgersDto) {
    return this.masters.getStockGroups(query.company);
  }

  @Get('stock-categories')
  stockCategories(@Query() query: ExtractLedgersDto) {
    return this.masters.getStockCategories(query.company);
  }

  @Get('units')
  units(@Query() query: ExtractLedgersDto) {
    return this.masters.getUnits(query.company);
  }

  @Get('currencies')
  currencies(@Query() query: ExtractLedgersDto) {
    return this.masters.getCurrencies(query.company);
  }

  @Get('godowns')
  godowns(@Query() query: ExtractLedgersDto) {
    return this.masters.getGodowns(query.company);
  }

  @Get('cost-categories')
  costCategories(@Query() query: ExtractLedgersDto) {
    return this.masters.getCostCategories(query.company);
  }

  @Get('voucher-types')
  voucherTypes(@Query() query: ExtractLedgersDto) {
    return this.masters.getVoucherTypes(query.company);
  }

  /**
   * Extracts EVERY master type plus every voucher (every type, full date
   * range) and caches each entity's raw result in Redis under
   * `tally:full:{company}:*` — see TallyFullSyncService's doc comment.
   * Fire-and-forget: queues the run and returns immediately (202-style —
   * kept HttpStatus.OK for backwards compatibility with existing callers of
   * this route, the body's `status: 'RUNNING'` is the real signal). VERIFIED
   * live against COREDGE.IO INDIA PRIVATE LIMITED (1,409 ledgers, 13,312
   * vouchers spanning 2020-04-01..today): the whole sweep took ~8 minutes —
   * poll GET /tally/full-sync/status?company=... until it reports SUCCESS
   * or FAILED rather than waiting on this call. `fromDate`/`toDate` default
   * to the company's own StartingFrom..today.
   */
  @Post('full-sync')
  @HttpCode(HttpStatus.OK)
  fullSyncRun(@Query() query: ExtractLedgersDto) {
    return this.fullSync.start(query.company, query.fromDate, query.toDate);
  }

  /** Poll target for the run kicked off above — NOT_STARTED / RUNNING /
   *  SUCCESS (+ manifest) / FAILED (+ error). */
  @Get('full-sync/status')
  fullSyncStatus(@Query() query: ExtractLedgersDto) {
    return this.fullSync.getStatus(this.fullSync.resolveCompany(query.company));
  }

  /**
   * One raw cached entity's rows — the "view extracted data" step of the
   * Full Sync Explorer. `entityType` must be one of the strings
   * GET .../status's manifest lists (e.g. "LEDGERS", "VOUCHERS:Sales");
   * anything else is rejected before touching Redis.
   */
  @Get('full-sync/data')
  async fullSyncData(@Query() query: FullSyncDataQueryDto) {
    const company = this.fullSync.resolveCompany(query.company);
    const known = await this.fullSync.listKnownEntityTypes(company);
    if (!known) {
      throw new BadRequestException(
        `"${company}" needs a completed full sync first — run POST /tally/full-sync and wait for ` +
          'it to succeed.',
      );
    }
    if (!known.includes(query.entityType)) {
      throw new BadRequestException(
        `"${query.entityType}" is not part of the current extraction for "${company}" — known ` +
          `types right now: ${known.join(', ')}.`,
      );
    }
    return this.fullSync.getEntitySnapshot(company, query.entityType);
  }

  /**
   * Maps every currently-cached raw entity into all 9 Zoho template shapes
   * (same mappers the production export uses — see
   * TallyFullSyncMappingService's doc comment) and caches the result. The
   * "Generate Zoho Mapping" step — run after full-sync succeeds, before
   * browsing GET .../mapped-data or generating GET .../excel.
   */
  @Post('full-sync/map')
  @HttpCode(HttpStatus.OK)
  fullSyncMap(@Query() query: ExtractLedgersDto) {
    return this.fullSyncMapping.mapAll(this.fullSync.resolveCompany(query.company));
  }

  /** One already-mapped Zoho entity's rows + its template's full header
   *  list (including columns nothing populates) — run POST .../map first. */
  @Get('full-sync/mapped-data')
  async fullSyncMappedData(@Query() query: FullSyncMappedQueryDto) {
    const company = this.fullSync.resolveCompany(query.company);
    const mapped = await this.fullSyncMapping.getMapped(company, query.entity);
    if (!mapped) {
      throw new BadRequestException(
        `No Zoho mapping cached yet for "${company}" — run POST /tally/full-sync/map first.`,
      );
    }
    return mapped;
  }

  /**
   * One Zoho entity's mapped rows written into its REAL template file (same
   * layout as the "Master and Invoice or Bill" source templates) — the
   * per-function counterpart to the combined debug workbook below. Run
   * POST .../map first.
   */
  @Get('full-sync/mapped-data/excel')
  async fullSyncMappedDataExcel(
    @Query() query: FullSyncMappedQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const company = this.fullSync.resolveCompany(query.company);
    const buffer = await this.fullSyncMapping.exportMappedExcel(company, query.entity);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${this.sanitizeFilename(company)}-${query.entity}.xlsx"`,
    });
    return new StreamableFile(buffer);
  }

  /**
   * All 9 Zoho entities at once, each its own real template file, bundled
   * into one .zip — the "download every function in one go" counterpart to
   * the single-entity route above (computed on the fly if POST .../map
   * hasn't been run yet, same as the combined debug workbook below).
   */
  @Get('full-sync/mapped-data/excel-all')
  async fullSyncMappedDataExcelAll(
    @Query() query: ExtractLedgersDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const company = this.fullSync.resolveCompany(query.company);
    const buffer = await this.fullSyncExport.buildMappedZip(company);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${this.sanitizeFilename(company)}-zoho-mapped.zip"`,
    });
    return new StreamableFile(buffer);
  }

  /**
   * The combined debug workbook: one sheet per raw cached entity plus one
   * sheet per Zoho template (computed on the fly if POST .../map hasn't
   * been run yet) — see TallyFullSyncExportService's doc comment.
   */
  @Post('full-sync/excel')
  @HttpCode(HttpStatus.OK)
  async fullSyncExcel(@Query() query: ExtractLedgersDto, @Res({ passthrough: true }) res: Response) {
    const company = this.fullSync.resolveCompany(query.company);
    const buffer = await this.fullSyncExport.buildWorkbook(company);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${this.sanitizeFilename(company)}-full-sync-debug.xlsx"`,
    });
    // Must be StreamableFile, not a bare Buffer — see
    // ExtractionsController.downloadExcel's identical doc comment for the
    // live-confirmed "Nest silently JSON-serializes a raw Buffer" bug this
    // avoids.
    return new StreamableFile(buffer);
  }

  /**
   * Escape hatch: request any Tally report by name and get the raw XML back.
   * For onboarding/exploration of a new client's Tally setup.
   */
  @Post('raw')
  @HttpCode(HttpStatus.OK)
  raw(@Body() body: RawReportDto) {
    return this.diagnostics.getRaw(body);
  }

  /**
   * Queues the same fetch the synchronous routes above run inline, and
   * returns immediately instead of blocking on Tally — poll GET
   * /tally/jobs/:id for status, then GET /tally/jobs/:id/result once
   * SUCCESS. Prevents a slow/stuck Tally from tying up the HTTP request for
   * however long that takes (see the 180s+ timeouts this project hit before
   * this endpoint existed).
   */
  @Post('jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  createJob(@Body() dto: CreateTallyJobDto) {
    return this.jobs.create(dto);
  }

  @Get('jobs/:id')
  jobStatus(@Param('id') id: string) {
    return this.jobs.getStatus(id);
  }

  /** Raw JSON result. Only available while status=SUCCESS and within the result TTL. */
  @Get('jobs/:id/result')
  jobResult(@Param('id') id: string) {
    return this.jobs.getResult(id);
  }

  /** Filesystem/header-safe filename segment — mirrors
   *  BulkExportService.sanitizeForPath's reasoning (strip everything but
   *  alphanumerics/-/_ so a company name can't break the Content-Disposition
   *  header or smuggle a path segment into the downloaded filename). */
  private sanitizeFilename(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'company';
  }
}
