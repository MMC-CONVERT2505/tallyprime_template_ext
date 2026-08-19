import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExtractionJob, ExtractionStatus, ExtractionType, Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { TallyConfig } from '../../config/configuration';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { TALLY_CONNECTOR, TallyConnector } from '../tally-connector.interface';
import { EnvelopeBuilder } from '../xml/envelope.builder';
import { TallyResponseParser } from '../xml/response.parser';

// Re-exported so subclasses/callers don't need to reach into @prisma/client
// directly — the Prisma schema is the single source of truth for these values.
export { ExtractionStatus, ExtractionType };

type NewExtractionJob = Pick<ExtractionJob, 'type' | 'company' | 'status'> & {
  params: Prisma.InputJsonValue;
};

interface ExtractionJobRepository {
  create(data: NewExtractionJob): NewExtractionJob;
  save(entity: NewExtractionJob): Promise<ExtractionJob>;
  update(
    id: string,
    data: Partial<
      Pick<ExtractionJob, 'status' | 'recordCount' | 'durationMs' | 'error' | 'progress'>
    >,
  ): Promise<ExtractionJob>;
}

/**
 * Shared plumbing for every Tally extraction service: sends requests via the
 * TallyConnector, records an ExtractionJob audit row per call (who/what/when/
 * status/count — never the raw data, see docs/architecture.md), resolves the
 * target company, and validates date ranges. Concrete subclasses
 * (MasterExtractionService, TransactionExtractionService, TallyDiagnosticsService)
 * add nothing but the actual per-entity Tally calls — this is what keeps each
 * of them small, independently testable, and easy to extend with one more
 * entity without touching this base.
 *
 * No own constructor is declared here on purpose: subclasses that don't
 * declare their own constructor either inherit this one's DI metadata as-is
 * (the common case — see MasterExtractionService/TransactionExtractionService).
 *
 * The job repository and Redis cache are both @Optional() — these services are
 * also instantiated on the connector/agent (see src/agent/), which has neither
 * Postgres nor Redis by design. Every use of either is best-effort/try-catch'd
 * for "audit write failed, continue anyway."
 */
@Injectable()
export abstract class TallyExtractionServiceBase {
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly builder: EnvelopeBuilder,
    @Inject(TALLY_CONNECTOR) protected readonly connector: TallyConnector,
    protected readonly parser: TallyResponseParser,
    protected readonly config: ConfigService,
    @Optional()
    @Inject('EXTRACTION_JOB_REPOSITORY')
    private readonly jobs: ExtractionJobRepository | undefined,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | undefined,
  ) {}

  protected get tally(): TallyConfig {
    return this.config.getOrThrow<TallyConfig>('tally');
  }

  protected resolveCompany(company?: string): string {
    const resolved = (company ?? '').trim() || this.tally.defaultCompany.trim();
    if (!resolved) {
      throw new BadRequestException(
        'No company specified and TALLY_DEFAULT_COMPANY is not set. ' +
          'Pass ?company=<exact Tally company name> — call GET /tally/companies to discover valid names.',
      );
    }
    return resolved;
  }

  protected assertDateRange(from: string, to: string): void {
    // Both are already YYYYMMDD (validated in the DTO); compare lexically, which
    // is also chronological for that format.
    if (from > to) {
      throw new BadRequestException(`from (${from}) must not be after to (${to}).`);
    }
  }

  /**
   * Shared by every chunked/batched fetch (VOUCHERS date-chunking,
   * LEDGERS/STOCK_ITEMS batching) to pace successive Tally requests.
   * Abort-aware: a cancellation arriving during the pacing pause rejects
   * immediately instead of waiting out the full delay first.
   */
  protected sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('Extraction cancelled.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('Extraction cancelled.'));
        },
        { once: true },
      );
    });
  }

  /**
   * Wraps an extraction in timing + audit persistence. The Tally call is the
   * source of truth for success/failure; audit writes are best-effort and
   * never mask or override the real result.
   *
   * `externalJobId`: when the caller already owns an ExtractionJob row for
   * this run (the queued job path — TallyJobsService/ExtractionsProcessor
   * both create one before dispatch, to return an id immediately and poll
   * against), this method must write progress to THAT row, not create a
   * second, uncoordinated one. Without this, a batched LEDGERS/STOCK_ITEMS
   * fetch's live "batch N/M" progress landed on a row only this method ever
   * knew existed — the caller's own GET /tally/jobs/:id (or
   * /extractions/:id) polling read a *different* row that never left
   * PENDING/progress:null until the very end, indistinguishable from a
   * stuck request for however long the fetch legitimately took. The queued
   * caller also owns that row's terminal status/recordCount write (see
   * ExtractionsProcessor.process) — finishJob is skipped here to avoid a
   * second, redundant writer racing the same field.
   */
  protected async runExtraction<T>(
    type: ExtractionType,
    company: string | null,
    params: Record<string, unknown>,
    work: (job: ExtractionJob | null) => Promise<T>,
    externalJobId?: string,
  ): Promise<T> {
    const startedAt = Date.now();
    const job = externalJobId
      ? ({ id: externalJobId } as ExtractionJob)
      : await this.createJob(type, company, params);
    const context = `jobId=${job?.id ?? 'unaudited'} company="${company ?? 'n/a'}"`;

    try {
      const result = await work(job);
      const count = Array.isArray(result) ? result.length : 1;
      const durationMs = Date.now() - startedAt;
      if (!externalJobId) {
        await this.finishJob(job, ExtractionStatus.SUCCESS, { recordCount: count, durationMs });
      }
      this.logger.log(
        `Extraction ${type} succeeded: ${count} record(s) in ${durationMs}ms (${context})`,
      );
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      if (!externalJobId) {
        await this.finishJob(job, ExtractionStatus.FAILED, { durationMs, error: message });
      }
      this.logger.warn(`Extraction ${type} failed after ${durationMs}ms (${context}): ${message}`);
      throw err;
    }
  }

  protected async readCache<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.debug(`Cache read miss/failure for ${key}: ${String(err)}`);
      return null;
    }
  }

  protected async writeCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.debug(`Cache write failure for ${key}: ${String(err)}`);
    }
  }

  private async createJob(
    type: ExtractionType,
    company: string | null,
    params: Record<string, unknown>,
  ): Promise<ExtractionJob | null> {
    if (!this.jobs) return null;
    try {
      const job = this.jobs.create({
        type,
        company,
        params: params as Prisma.InputJsonValue,
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
    if (!job || !this.jobs) return;
    try {
      // Clear any leftover "batch N/M" progress string now that the job has
      // reached a terminal status — it would otherwise linger stale on the
      // row forever once nothing is updating it anymore.
      await this.jobs.update(job.id, { status, progress: null, ...patch });
    } catch (err) {
      this.logger.warn(`Could not update extraction job ${job.id}: ${String(err)}`);
    }
  }

  /**
   * Best-effort "batch N/M" status write for a still-running job, so a slow
   * multi-batch/multi-chunk extraction (see MasterExtractionService's
   * AlterID batching, TransactionExtractionService's date chunking) isn't a
   * silent black box while PENDING. Never the source of truth for anything —
   * same fire-and-forget, log-and-continue style as createJob/finishJob.
   */
  protected async reportProgress(job: ExtractionJob | null, progress: string): Promise<void> {
    if (!job || !this.jobs) return;
    try {
      await this.jobs.update(job.id, { progress });
    } catch (err) {
      this.logger.debug(
        `Could not persist progress for job ${job.id} (continuing): ${String(err)}`,
      );
    }
  }
}
