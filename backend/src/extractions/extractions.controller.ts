import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
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
   * Zoho-import-ready Excel. LEDGERS jobs need a completed GROUPS job's id
   * via ?groupsJobId= — see ExtractionsService.getExcelResult's doc comment.
   */
  @Get(':id/excel')
  async excel(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('groupsJobId') groupsJobId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Buffer> {
    const { buffer, filename } = await this.extractions.getExcelResult(user.orgId, id, groupsJobId);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return buffer;
  }
}
