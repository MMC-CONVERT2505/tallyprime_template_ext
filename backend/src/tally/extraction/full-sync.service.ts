import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExtractionStatus, ExtractionType, Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { ExtractionConfig, TallyConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { acquireLock, releaseLock } from '../../redis/lock.util';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { TallyVoucher } from '../interfaces/tally.interfaces';
import { FULL_SYNC_RUN_LOCK_TTL_MS, fullSyncLockKey } from './full-sync.constants';
import { MasterExtractionService } from './master-extraction.service';
import { TransactionExtractionService } from './transaction-extraction.service';

const REDIS_KEY_PREFIX = 'tally:full';

export interface FullSyncManifest {
  company: string;
  extractedAt: string;
  dateRange: { from: string; to: string };
  /** Record count per master type, plus a `VOUCHERS` total. */
  entityCounts: Record<string, number>;
  /** How many real vouchers of each Tally voucher type were found — a
   *  company can have up to the 24 standard types configured (see
   *  TallyVoucherType) but typically only uses a handful of them. */
  voucherTypeBreakdown: Record<string, number>;
  ttlSeconds: number;
}

export type FullSyncRunStatus = 'NOT_STARTED' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface FullSyncStatusSnapshot {
  status: FullSyncRunStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  manifest?: FullSyncManifest;
}

/**
 * Orchestrates a full-company extraction — every master type this project's
 * TDL Collection mechanism can reach, plus every voucher across every
 * voucher type for the requested date range — and caches each entity's raw,
 * parsed result in Redis under `tally:full:{company}:*`. Deliberately raw:
 * no Zoho mapping happens here (see FullSyncMappingService for that, a
 * separate concern reading these same keys) — this is the "get everything
 * Tally will give us and hold onto it" step later steps read from.
 *
 * Pure composition, not a TallyExtractionServiceBase subclass: every actual
 * Tally call is delegated to MasterExtractionService/TransactionExtractionService
 * (so it gets that class's existing batching/chunking/job-auditing for free,
 * unchanged), and this class owns nothing but the sequencing + the Redis
 * writes. Extending the base class here would need its own audited-job
 * mechanics duplicated anyway (this is itself one more thing worth auditing
 * as a single FULL_SYNC job), and NestJS constructor-injected tokens
 * (`@Inject(REDIS_CLIENT)`, the job repository) don't reliably carry across
 * an extends boundary once a subclass declares its own constructor — simpler
 * and more obviously correct to compose instead.
 *
 * Sequential, not parallel: Tally serves one request at a time (see every
 * other extraction service's identical reasoning) — firing 12 master
 * requests plus a voucher fetch concurrently would just queue up pressure on
 * Tally's single-threaded HTTP server, not finish any faster.
 *
 * `start()` is fire-and-forget (returns as soon as the run is queued) — a
 * real run against a large company takes minutes (confirmed live: ~8 for
 * 1,409 ledgers/13,312 vouchers), far too long for a blocking HTTP call.
 * Progress/outcome is tracked in a small `STATUS` Redis blob a caller polls
 * via `getStatus`, deliberately NOT gated on Postgres/the optional
 * ExtractionJob audit row (this whole feature is Redis-dependent already;
 * the app's "Database and Redis are optional for boot" degraded mode must
 * not silently break status polling too).
 */
@Injectable()
export class TallyFullSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TallyFullSyncService.name);

  constructor(
    private readonly masters: MasterExtractionService,
    private readonly transactions: TransactionExtractionService,
    private readonly config: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /**
   * Self-healing sweep run once at boot — mirrors BulkExportService's
   * identical reconciliation and for the identical reason: `start()`'s
   * background run is in-memory/fire-and-forget, so a STATUS blob still
   * `RUNNING` at the moment THIS process starts up can only mean the process
   * that was supposed to finish it is gone (crash, deploy, dev hot-reload).
   * Nothing else will ever revisit it — mark it FAILED with a clear,
   * actionable reason and clear its lock so a fresh `start()` isn't blocked
   * forever by a run that will never finish.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.redis) return;
    try {
      let cursor = '0';
      let recovered = 0;
      do {
        const [next, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          `${REDIS_KEY_PREFIX}:*:STATUS`,
          'COUNT',
          200,
        );
        cursor = next;
        for (const key of keys) {
          const raw = await this.redis.get(key);
          if (!raw) continue;
          const status = JSON.parse(raw) as FullSyncStatusSnapshot;
          if (status.status !== 'RUNNING') continue;

          const company = key.slice(`${REDIS_KEY_PREFIX}:`.length, -':STATUS'.length);
          await this.writeStatus(company, {
            status: 'FAILED',
            startedAt: status.startedAt,
            finishedAt: new Date().toISOString(),
            error: 'Interrupted by a server restart — click Extract All Data to re-run.',
          });
          await this.redis.del(fullSyncLockKey(company)).catch(() => undefined);
          recovered++;
        }
      } while (cursor !== '0');
      if (recovered > 0) {
        this.logger.warn(`Recovered ${recovered} full sync(s) orphaned by a prior restart.`);
      }
    } catch (err) {
      this.logger.error(`Full sync orphan reconciliation failed: ${String(err)}`);
    }
  }

  /**
   * Queues a full sync and returns immediately — see this class's doc
   * comment for why. Rejects synchronously (before any Tally call) if Redis
   * isn't configured or a sync for this company is already running, the same
   * "fail fast" standard `BulkExportService.start` follows.
   */
  async start(
    company?: string,
    fromDate?: string,
    toDate?: string,
  ): Promise<{ status: 'RUNNING' }> {
    const resolvedCompany = this.resolveCompany(company);
    if (!this.redis) {
      throw new BadRequestException(
        'Redis is not configured — Full Sync requires Redis to cache results and cannot run without it.',
      );
    }

    const lockToken = await acquireLock(
      this.redis,
      fullSyncLockKey(resolvedCompany),
      FULL_SYNC_RUN_LOCK_TTL_MS,
    );
    if (!lockToken) {
      throw new BadRequestException(
        `A full sync for "${resolvedCompany}" is already running — poll GET ` +
          '/tally/full-sync/status until it finishes before starting another.',
      );
    }

    const startedAt = new Date().toISOString();
    await this.writeStatus(resolvedCompany, { status: 'RUNNING', startedAt });

    void this.runTracked(resolvedCompany, fromDate, toDate, startedAt, lockToken).catch((err) => {
      this.logger.error(
        `FULL_SYNC ${resolvedCompany} crashed outside its own error handling: ${String(err)}`,
      );
    });

    return { status: 'RUNNING' };
  }

  /** Direct blocking run — used by scripts/tests that want to await the
   *  whole thing; `start()` above is what the HTTP endpoint uses. */
  async runFullSync(company?: string, fromDate?: string, toDate?: string): Promise<FullSyncManifest> {
    const resolvedCompany = this.resolveCompany(company);
    const startedAt = Date.now();
    const job = await this.createJob(resolvedCompany, {
      fromDate: fromDate ?? null,
      toDate: toDate ?? null,
    });

    try {
      const manifest = await this.doFullSync(resolvedCompany, fromDate, toDate);
      const totalRecords = Object.values(manifest.entityCounts).reduce((a, b) => a + b, 0);
      await this.finishJob(job, ExtractionStatus.SUCCESS, {
        recordCount: totalRecords,
        durationMs: Date.now() - startedAt,
      });
      this.logger.log(
        `FULL_SYNC for "${resolvedCompany}" succeeded: ${totalRecords} total record(s) ` +
          `across ${Object.keys(manifest.entityCounts).length} entit(y/ies) in ${Date.now() - startedAt}ms.`,
      );
      return manifest;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finishJob(job, ExtractionStatus.FAILED, {
        durationMs: Date.now() - startedAt,
        error: message,
      });
      this.logger.warn(`FULL_SYNC for "${resolvedCompany}" failed after ${Date.now() - startedAt}ms: ${message}`);
      throw err;
    }
  }

  /** Reads the STATUS blob `start()`/`runTracked` maintain. */
  async getStatus(company: string): Promise<FullSyncStatusSnapshot> {
    if (!this.redis) return { status: 'NOT_STARTED' };
    const raw = await this.redis.get(this.redisKey(company, 'STATUS'));
    if (!raw) return { status: 'NOT_STARTED' };
    return JSON.parse(raw) as FullSyncStatusSnapshot;
  }

  /** Reads the small manifest a completed run wrote — `null` if none yet
   *  (or it has since expired out of Redis on its own TTL). */
  async getManifest(company: string): Promise<FullSyncManifest | null> {
    return this.getEntitySnapshot<FullSyncManifest>(company, 'MANIFEST');
  }

  /** Raw read for any cached entity key — `null` if absent. Callers decide
   *  what "absent" means for them (see listKnownEntityTypes's doc comment:
   *  an absent voucher-type key can legitimately mean "zero of that type",
   *  while an absent master key means "full sync never ran"). */
  async getEntitySnapshot<T = unknown>(company: string, entityType: string): Promise<T | null> {
    if (!this.redis) return null;
    const raw = await this.redis.get(this.redisKey(company, entityType));
    return raw ? (JSON.parse(raw) as T) : null;
  }

  /**
   * The entity type strings that are actually part of the CURRENT
   * extraction for `company` — derived fresh from its manifest every call,
   * not from "does this Redis key happen to exist" (a key from a prior run
   * with a different voucher-type mix could otherwise still be sitting
   * there, unexpired, and get served as if current — see doFullSync's
   * pre-run cleanup for the write-side half of this fix). Returns `null` if
   * full sync has never completed for this company.
   */
  async listKnownEntityTypes(company: string): Promise<string[] | null> {
    const manifest = await this.getManifest(company);
    if (!manifest) return null;
    const masterKeys = Object.keys(manifest.entityCounts).filter((key) => key !== 'VOUCHERS');
    const voucherKeys = [
      'VOUCHERS:ALL',
      ...Object.keys(manifest.voucherTypeBreakdown).map((type) => `VOUCHERS:${type}`),
    ];
    return [...masterKeys, 'COMPANY', ...voucherKeys];
  }

  /** Public so FullSyncMappingService/FullSyncExportService can share the
   *  exact same lock `start()` holds for the whole run — mapping/exporting
   *  mid-write would otherwise silently read a half-finished extraction. */
  getLockKey(company: string): string {
    return fullSyncLockKey(company);
  }

  /** Public so the two sibling services above can write their own
   *  `MAPPED:*` snapshots under the same TTL/prefix convention without
   *  duplicating the key format or reaching around this service's Redis
   *  client directly. */
  async writeEntitySnapshot(company: string, entityType: string, value: unknown): Promise<void> {
    await this.writeSnapshot(company, entityType, value);
  }

  /** Public so the controller and sibling full-sync services resolve a
   *  company name (and its "no company, no default configured" error) the
   *  exact same way `start`/`runFullSync` do — one place owns this logic. */
  resolveCompany(company?: string): string {
    const tally = this.config.getOrThrow<TallyConfig>('tally');
    const resolved = (company ?? '').trim() || tally.defaultCompany.trim();
    if (!resolved) {
      throw new BadRequestException(
        'No company specified and TALLY_DEFAULT_COMPANY is not set. ' +
          'Pass ?company=<exact Tally company name> — call GET /tally/companies to discover valid names.',
      );
    }
    return resolved;
  }

  private async runTracked(
    company: string,
    fromDate: string | undefined,
    toDate: string | undefined,
    startedAt: string,
    lockToken: string,
  ): Promise<void> {
    const startedAtMs = Date.now();
    const job = await this.createJob(company, { fromDate: fromDate ?? null, toDate: toDate ?? null });
    try {
      const manifest = await this.doFullSync(company, fromDate, toDate);
      const totalRecords = Object.values(manifest.entityCounts).reduce((a, b) => a + b, 0);
      await this.finishJob(job, ExtractionStatus.SUCCESS, {
        recordCount: totalRecords,
        durationMs: Date.now() - startedAtMs,
      });
      await this.writeStatus(company, {
        status: 'SUCCESS',
        startedAt,
        finishedAt: new Date().toISOString(),
        manifest,
      });
      this.logger.log(
        `FULL_SYNC for "${company}" succeeded: ${totalRecords} total record(s) across ` +
          `${Object.keys(manifest.entityCounts).length} entit(y/ies) in ${Date.now() - startedAtMs}ms.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finishJob(job, ExtractionStatus.FAILED, {
        durationMs: Date.now() - startedAtMs,
        error: message,
      });
      await this.writeStatus(company, {
        status: 'FAILED',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: message,
      });
      this.logger.warn(`FULL_SYNC for "${company}" failed after ${Date.now() - startedAtMs}ms: ${message}`);
    } finally {
      await releaseLock(this.redis!, fullSyncLockKey(company), lockToken).catch(() => undefined);
    }
  }

  private async doFullSync(
    company: string,
    fromDate: string | undefined,
    toDate: string | undefined,
  ): Promise<FullSyncManifest> {
    // Clears the previous run's dynamically-named keys BEFORE writing
    // anything new — VOUCHERS:<type> keys only get (re)written for whichever
    // types this run actually finds (see groupAndStoreByVoucherType below),
    // so a type present last time but genuinely gone this time (a ledger/
    // voucher type deleted or renamed in Tally) would otherwise linger under
    // its own still-valid TTL and get served as if current. MAPPED:* is
    // this-run-derived data from a PRIOR mapping pass over the OLD raw
    // data — just as stale, for the same reason.
    await this.deleteKeysByPattern(this.redisKey(company, 'VOUCHERS:*'));
    await this.deleteKeysByPattern(this.redisKey(company, 'MAPPED:*'));

    const entityCounts: Record<string, number> = {};

    // Resolve the real date range from Tally's own company record when not
    // given explicitly — see MasterExtractionService.resolveDateRange's doc
    // comment (shared with TransactionExtractionService/bulk export, not
    // duplicated here anymore).
    const companies = await this.masters.getCompanies();
    const companyInfo = companies.find(
      (c) => c.name.trim().toLowerCase() === company.trim().toLowerCase(),
    );
    const { from: resolvedFrom, to: resolvedTo } = await this.masters.resolveDateRange(
      company,
      fromDate,
      toDate,
    );
    await this.writeSnapshot(company, 'COMPANY', companyInfo ?? { name: company });

    // ── Masters — unscoped (no fromDate/toDate) for Ledgers/Stock Items, on
    // purpose: see MasterExtractionService.getStockItems' doc comment for why
    // a period-scoped Stock Item request reliably wedges Tally's engine, and
    // fetchLedgersBatched's for the analogous reserved-ledger risk. Every
    // other master type here is a small, non-batched, non-period-scoped
    // lookup (confirmed live: 0-56 records each on this company). ──
    const groups = await this.fetchAndStore(company, 'GROUPS', () => this.masters.getGroups(company));
    entityCounts.GROUPS = groups.length;
    await this.pace();

    const ledgers = await this.fetchAndStore(company, 'LEDGERS', () => this.masters.getLedgers(company));
    entityCounts.LEDGERS = ledgers.length;
    await this.pace();

    const stockItems = await this.fetchAndStore(company, 'STOCK_ITEMS', () =>
      this.masters.getStockItems(company),
    );
    entityCounts.STOCK_ITEMS = stockItems.length;
    await this.pace();

    const stockGroups = await this.fetchAndStore(company, 'STOCK_GROUPS', () =>
      this.masters.getStockGroups(company),
    );
    entityCounts.STOCK_GROUPS = stockGroups.length;
    await this.pace();

    const stockCategories = await this.fetchAndStore(company, 'STOCK_CATEGORIES', () =>
      this.masters.getStockCategories(company),
    );
    entityCounts.STOCK_CATEGORIES = stockCategories.length;
    await this.pace();

    const units = await this.fetchAndStore(company, 'UNITS', () => this.masters.getUnits(company));
    entityCounts.UNITS = units.length;
    await this.pace();

    const currencies = await this.fetchAndStore(company, 'CURRENCIES', () =>
      this.masters.getCurrencies(company),
    );
    entityCounts.CURRENCIES = currencies.length;
    await this.pace();

    const godowns = await this.fetchAndStore(company, 'GODOWNS', () => this.masters.getGodowns(company));
    entityCounts.GODOWNS = godowns.length;
    await this.pace();

    const costCentres = await this.fetchAndStore(company, 'COST_CENTRES', () =>
      this.masters.getCostCentres(company),
    );
    entityCounts.COST_CENTRES = costCentres.length;
    await this.pace();

    const costCategories = await this.fetchAndStore(company, 'COST_CATEGORIES', () =>
      this.masters.getCostCategories(company),
    );
    entityCounts.COST_CATEGORIES = costCategories.length;
    await this.pace();

    const voucherTypes = await this.fetchAndStore(company, 'VOUCHER_TYPES', () =>
      this.masters.getVoucherTypes(company),
    );
    entityCounts.VOUCHER_TYPES = voucherTypes.length;
    await this.pace();

    // ── Transactions — every voucher, every type, for the resolved range.
    // getVouchers with no voucherType filter already returns all of them
    // (see TransactionExtractionService's own doc comment); the chunking/
    // whole-range-first optimization/pacing for a wide range is already
    // handled inside it. ──
    const vouchers = await this.transactions.getVouchers({
      company,
      from: resolvedFrom,
      to: resolvedTo,
    });
    entityCounts.VOUCHERS = vouchers.length;
    await this.writeSnapshot(company, 'VOUCHERS:ALL', vouchers);

    const voucherTypeBreakdown = this.groupAndStoreByVoucherType(company, vouchers);
    await this.pace();
    for (const [type, list] of Object.entries(voucherTypeBreakdown.lists)) {
      await this.writeSnapshot(company, `VOUCHERS:${type}`, list);
    }

    const manifest: FullSyncManifest = {
      company,
      extractedAt: new Date().toISOString(),
      dateRange: { from: resolvedFrom, to: resolvedTo },
      entityCounts,
      voucherTypeBreakdown: voucherTypeBreakdown.counts,
      ttlSeconds: this.ttlSeconds,
    };
    await this.writeSnapshot(company, 'MANIFEST', manifest);
    return manifest;
  }

  private async fetchAndStore<T>(
    company: string,
    entityType: string,
    fetch: () => Promise<T[]>,
  ): Promise<T[]> {
    const startedAt = Date.now();
    const result = await fetch();
    this.logger.log(`FULL_SYNC ${entityType} for "${company}": ${result.length} record(s) in ${Date.now() - startedAt}ms.`);
    await this.writeSnapshot(company, entityType, result);
    return result;
  }

  /** Groups the already-fetched, unfiltered voucher list by its own
   *  voucherType field — no extra Tally calls, just an in-memory split of
   *  data already in hand. */
  private groupAndStoreByVoucherType(
    company: string,
    vouchers: TallyVoucher[],
  ): { counts: Record<string, number>; lists: Record<string, TallyVoucher[]> } {
    const lists: Record<string, TallyVoucher[]> = {};
    for (const v of vouchers) {
      const type = v.voucherType?.trim() || '(unknown)';
      (lists[type] ??= []).push(v);
    }
    const counts = Object.fromEntries(Object.entries(lists).map(([type, list]) => [type, list.length]));
    return { counts, lists };
  }

  private get ttlSeconds(): number {
    return this.config.getOrThrow<ExtractionConfig>('extraction').fullSyncTtlSeconds;
  }

  private redisKey(company: string, entityType: string): string {
    return `${REDIS_KEY_PREFIX}:${company}:${entityType}`;
  }

  private async writeSnapshot(company: string, entityType: string, value: unknown): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(this.redisKey(company, entityType), JSON.stringify(value), 'EX', this.ttlSeconds);
    } catch (err) {
      this.logger.warn(`Could not cache FULL_SYNC ${entityType} for "${company}": ${String(err)}`);
    }
  }

  private async writeStatus(company: string, status: FullSyncStatusSnapshot): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(
        this.redisKey(company, 'STATUS'),
        JSON.stringify(status),
        'EX',
        this.ttlSeconds,
      );
    } catch (err) {
      this.logger.warn(`Could not write FULL_SYNC status for "${company}": ${String(err)}`);
    }
  }

  /** Best-effort SCAN+DEL over a glob pattern — used only for this
   *  company's own dynamically-named keyspaces (VOUCHERS: and MAPPED:
   *  prefixes), which are cheap in count (a few dozen at most). Never
   *  throws: a failure here just risks a stale key surviving to its own
   *  TTL, not data loss. */
  private async deleteKeysByPattern(pattern: string): Promise<void> {
    if (!this.redis) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) await this.redis.del(...keys);
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn(`Could not clear stale keys matching "${pattern}": ${String(err)}`);
    }
  }

  private async pace(): Promise<void> {
    const delayMs = this.config.getOrThrow<TallyConfig>('tally').chunkDelayMs;
    if (delayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private async createJob(
    company: string,
    params: Record<string, unknown>,
  ): Promise<{ id: string } | null> {
    if (!this.prisma) return null;
    try {
      return await this.prisma.extractionJob.create({
        data: {
          type: ExtractionType.FULL_SYNC,
          company,
          params: params as Prisma.InputJsonValue,
          status: ExtractionStatus.PENDING,
        },
      });
    } catch (err) {
      this.logger.warn(`Could not persist FULL_SYNC job (continuing): ${String(err)}`);
      return null;
    }
  }

  private async finishJob(
    job: { id: string } | null,
    status: ExtractionStatus,
    patch: { recordCount?: number; durationMs?: number; error?: string },
  ): Promise<void> {
    if (!job || !this.prisma) return;
    try {
      await this.prisma.extractionJob.update({ where: { id: job.id }, data: { status, ...patch } });
    } catch (err) {
      this.logger.warn(`Could not update FULL_SYNC job ${job.id}: ${String(err)}`);
    }
  }
}
