import { Controller, Get, Post, Query, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { CreateLedgerDto } from './dto/create-ledger.dto';
import { ExtractLedgersDto, ExtractVouchersDto, RawReportDto } from './dto/extract.dto';
import { TallyService } from './tally.service';

@Controller('tally')
export class TallyController {
  constructor(private readonly tally: TallyService) {}

  /**
   * Connectivity + discovery probe. Returns the list of companies currently
   * open in Tally and how long the round-trip took. First thing to hit after
   * pointing TALLY_HOST/PORT at a client's machine.
   */
  @Get('probe')
  probe() {
    return this.tally.probe();
  }

  /** All companies loaded in Tally (short-cached). */
  @Get('companies')
  companies(@Query('fresh') fresh?: string) {
    return this.tally.getCompanies(fresh !== 'true');
  }

  /** Lean ledger master list (Name, Parent, Opening/Closing balance, AlterID). */
  @Get('ledgers')
  ledgers(@Query() query: ExtractLedgersDto) {
    return this.tally.getLedgers(query.company);
  }

  /**
   * Creates a single Ledger master in Tally. This is a WRITE against the live
   * company (unlike every other endpoint here) — verify with
   * GET /tally/ledgers?fresh=true afterward.
   */
  @Post('ledgers')
  @HttpCode(HttpStatus.CREATED)
  createLedger(@Body() body: CreateLedgerDto) {
    return this.tally.createLedger(body);
  }

  /** Lean stock item master list (Name, Parent, BaseUnits, Opening/Closing balance+value, AlterID). */
  @Get('stock-items')
  stockItems(@Query() query: ExtractLedgersDto) {
    return this.tally.getStockItems(query.company);
  }

  /** Vouchers for a date range, optionally filtered by voucher type. */
  @Get('vouchers')
  vouchers(@Query() query: ExtractVouchersDto) {
    return this.tally.getVouchers(query);
  }

  /**
   * Escape hatch: request any Tally report by name and get the raw XML back.
   * For onboarding/exploration of a new client's Tally setup.
   */
  @Post('raw')
  @HttpCode(HttpStatus.OK)
  raw(@Body() body: RawReportDto) {
    return this.tally.getRaw(body);
  }
}
