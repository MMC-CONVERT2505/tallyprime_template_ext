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
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateExtractionDto } from './dto/create-extraction.dto';
import { FetchMasterDto } from './dto/fetch-master.dto';
import { ExtractionsService } from './extractions.service';

@Controller('extractions')
@UseGuards(JwtAuthGuard)
export class ExtractionsController {
  constructor(private readonly extractions: ExtractionsService) {}

  /** Recent jobs for the org, newest first — backs the UI's job list/download
   *  picker. `?limit=` caps the count (default 50, max 200). */
  @Get()
  list(@CurrentUser() user: JwtPayload, @Query('limit') limit: string | undefined) {
    if (limit === undefined) return this.extractions.listJobs(user.orgId);
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('limit must be a positive integer.');
    }
    return this.extractions.listJobs(user.orgId, parsed);
  }

  /** Kicks off an async job — poll GET /extractions/:id for status. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateExtractionDto) {
    return this.extractions.create(user.orgId, user.email, dto);
  }

  /**
   * Fetch-master API: resolves the paired connector by company name (no
   * connectionId needed) and kicks off the same async job pipeline as
   * POST /extractions. Poll GET /extractions/:id for status, then
   * GET /extractions/:id/result for data. See
   * ExtractionsService.fetchMaster for company/connector resolution rules.
   */
  @Post('fetch-master')
  @HttpCode(HttpStatus.ACCEPTED)
  fetchMaster(@CurrentUser() user: JwtPayload, @Body() dto: FetchMasterDto) {
    return this.extractions.fetchMaster(user.orgId, user.email, dto);
  }

  @Get(':id')
  status(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.extractions.getStatus(user.orgId, id);
  }

  /** Raw JSON result. Only available while status=SUCCESS and within the result TTL. */
  @Get(':id/result')
  result(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.extractions.getResult(user.orgId, id);
  }

  /**
   * Zoho-import-ready Excel. LEDGERS jobs need a completed GROUPS job for
   * the same company, VOUCHERS jobs a completed STOCK_ITEMS job — both are
   * auto-resolved to the most recent successful match (no need to look one
   * up and pass it); ?groupsJobId=/?itemsJobId= remain available to pin a
   * specific older companion run. See ExtractionsService.getExcelResult's
   * doc comment. A LEDGERS job also accepts ?ledgerEntity=COA|CUSTOMER|VENDOR
   * to pick which of the 3 possible exports that same ledger set produces;
   * omitted defaults to COA. Which of Invoice/Bill/Credit Note/Stock Journal
   * a VOUCHERS job produces is fixed by the job's own voucherType, not a
   * caller choice.
   */
  @Get(':id/excel')
  async excel(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('groupsJobId') groupsJobId: string | undefined,
    @Query('ledgerEntity') ledgerEntity: string | undefined,
    @Query('itemsJobId') itemsJobId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Buffer> {
    if (ledgerEntity && !['COA', 'CUSTOMER', 'VENDOR'].includes(ledgerEntity)) {
      throw new BadRequestException('ledgerEntity must be one of COA, CUSTOMER, VENDOR.');
    }
    const { buffer, filename } = await this.extractions.getExcelResult(
      user.orgId,
      id,
      groupsJobId,
      ledgerEntity as 'COA' | 'CUSTOMER' | 'VENDOR' | undefined,
      itemsJobId,
    );
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return buffer;
  }
}
