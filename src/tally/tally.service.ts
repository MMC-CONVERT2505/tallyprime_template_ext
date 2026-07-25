import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { TallyConfig } from '../config/configuration';
import {
  ExtractionJob,
  ExtractionStatus,
  ExtractionType,
} from '../database/entities/extraction-job.entity';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ExtractVouchersDto, RawReportDto } from './dto/extract.dto';
import {
  TallyCompany,
  TallyLedger,
  TallyVoucher,
} from './interfaces/tally.interfaces';
import { TallyHttpClient } from './tally-http.client';
import { EnvelopeBuilder } from './xml/envelope.builder';
import { TallyResponseParser } from './xml/response.parser';

const COMPANIES_CACHE_KEY = 'tally:companies';
const COMPANIES_CACHE_TTL_SECONDS = 15;

export interface TallyProbeResult {
  reachable: true;
  companies: string[];
  durationMs: number;
}

export interface RawExtractionResult {
  reportName: string;
  company: string | null;
  rawXml: string;
  bytes: number;
}

/**
 * High-level Tally operations. Composes the builder + http client + parser into
 * clean domain calls, and records an ExtractionJob audit row for each one so
 * every pull against a client's Tally is traceable (who/what/when/status/count).
 */
@Injectable()
export class TallyService {
  private readonly logger = new Logger(TallyService.name);

  constructor(
    private readonly builder: EnvelopeBuilder,
    private readonly httpClient: TallyHttpClient,
    private readonly parser: TallyResponseParser,
    private readonly config: ConfigService,
    @InjectRepository(ExtractionJob)
    private readonly jobs: Repository<ExtractionJob>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private get tally(): TallyConfig {
    return this.config.getOrThrow<TallyConfig>('tally');
  }

  /**
   * Lightweight reachability + discovery probe used by the health check.
   * Deliberately does NOT write a job row (health runs frequently) and does not
   * use the cache (health must reflect live reality).
   */
  async probe(): Promise<TallyProbeResult> {
    const startedAt = Date.now();
    const xml = this.builder.buildCompaniesRequest();
    const raw = await this.httpClient.post(xml);
    const companies = this.parser.mapCompanies(raw);
    return {
      reachable: true,
      companies: companies.map((c) => c.name).filter(Boolean),
      durationMs: Date.now() - startedAt,
    };
  }

  async getCompanies(useCache = true): Promise<TallyCompany[]> {
    if (useCache) {
      const cached = await this.readCache<TallyCompany[]>(COMPANIES_CACHE_KEY);
      if (cached) return cached;
    }

    const result = await this.runExtraction(ExtractionType.COMPANIES, null, {}, async () => {
      const xml = this.builder.buildCompaniesRequest();
      const raw = await this.httpClient.post(xml);
      return this.parser.mapCompanies(raw);
    });

    await this.writeCache(COMPANIES_CACHE_KEY, result, COMPANIES_CACHE_TTL_SECONDS);
    return result;
  }

  async getLedgers(company?: string): Promise<TallyLedger[]> {
    const resolved = this.resolveCompany(company);
    return this.runExtraction(
      ExtractionType.LEDGERS,
      resolved,
      { company: resolved },
      async () => {
        const xml = this.builder.buildLedgersRequest(resolved);
        const raw = await this.httpClient.post(xml);
        return this.parser.mapLedgers(raw);
      },
    );
  }

  async getVouchers(dto: ExtractVouchersDto): Promise<TallyVoucher[]> {
    const resolved = this.resolveCompany(dto.company);
    this.assertDateRange(dto.from, dto.to);

    return this.runExtraction(
      ExtractionType.VOUCHERS,
      resolved,
      { company: resolved, from: dto.from, to: dto.to, voucherType: dto.voucherType ?? null },
      async () => {
        const xml = this.builder.buildVouchersRequest(
          resolved,
          dto.from,
          dto.to,
          dto.voucherType,
        );
        const raw = await this.httpClient.post(xml);
        return this.parser.mapVouchers(raw);
      },
    );
  }

  /**
   * Escape hatch for arbitrary report requests — returns the raw XML (and a
   * parse-validated flag) so you can explore reports/collections we have not yet
   * modelled. Useful during onboarding of a new client's Tally.
   */
  async getRaw(dto: RawReportDto): Promise<RawExtractionResult> {
    const resolved = dto.company ? dto.company : this.tally.defaultCompany || null;
    const xml = this.builder.buildReportRequest({
      reportName: dto.reportName,
      company: resolved ?? undefined,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      voucherType: dto.voucherType,
    });

    return this.runExtraction(
      ExtractionType.RAW,
      resolved,
      { ...dto },
      async () => {
        const raw = await this.httpClient.post(xml);
        // Validate it parses (surfaces LINEERROR) but still return the raw body.
        this.parser.parse(raw);
        return { reportName: dto.reportName, company: resolved, rawXml: raw, bytes: raw.length };
      },
    );
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Wraps an extraction in timing + audit persistence. The Tally call is the
   * source of truth for success/failure; audit writes are best-effort and never
   * mask or override the real result.
   */
  private async runExtraction<T>(
    type: ExtractionType,
    company: string | null,
    params: Record<string, unknown>,
    work: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const job = await this.createJob(type, company, params);

    try {
      const result = await work();
      const count = Array.isArray(result) ? result.length : 1;
      await this.finishJob(job, ExtractionStatus.SUCCESS, {
        recordCount: count,
        durationMs: Date.now() - startedAt,
      });
      this.logger.log(`Extraction ${type} succeeded: ${count} record(s) in ${Date.now() - startedAt}ms`);
      return result;
    } catch (err) {
      await this.finishJob(job, ExtractionStatus.FAILED, {
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private resolveCompany(company?: string): string {
    const resolved = (company ?? '').trim() || this.tally.defaultCompany.trim();
    if (!resolved) {
      throw new BadRequestException(
        'No company specified and TALLY_DEFAULT_COMPANY is not set. ' +
          'Pass ?company=<exact Tally company name> — call GET /tally/companies to discover valid names.',
      );
    }
    return resolved;
  }

  private assertDateRange(from: string, to: string): void {
    // Both are already YYYYMMDD (validated in the DTO); compare lexically, which
    // is also chronological for that format.
    if (from > to) {
      throw new BadRequestException(`from (${from}) must not be after to (${to}).`);
    }
  }

  private async createJob(
    type: ExtractionType,
    company: string | null,
    params: Record<string, unknown>,
  ): Promise<ExtractionJob | null> {
    try {
      const job = this.jobs.create({
        type,
        company,
        params,
        status: ExtractionStatus.PENDING,
      });
      return await this.jobs.save(job);
    } catch (err) {
      this.logger.warn(`Could not persist extraction job (continuing): ${String(err)}`);
      return null;
    }
  }

  private async finishJob(
    job: ExtractionJob | null,
    status: ExtractionStatus,
    patch: Partial<Pick<ExtractionJob, 'recordCount' | 'durationMs' | 'error'>>,
  ): Promise<void> {
    if (!job) return;
    try {
      await this.jobs.update(job.id, { status, ...patch });
    } catch (err) {
      this.logger.warn(`Could not update extraction job ${job.id}: ${String(err)}`);
    }
  }

  private async readCache<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.debug(`Cache read miss/failure for ${key}: ${String(err)}`);
      return null;
    }
  }

  private async writeCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.debug(`Cache write failure for ${key}: ${String(err)}`);
    }
  }
}
