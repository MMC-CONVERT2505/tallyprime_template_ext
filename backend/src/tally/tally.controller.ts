import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { CreateTallyJobDto } from './dto/create-tally-job.dto';
import { ExtractLedgersDto, ExtractVouchersDto, RawReportDto } from './dto/extract.dto';
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
}
