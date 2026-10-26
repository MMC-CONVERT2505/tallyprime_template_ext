import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ExtractionJob, ExtractionType, Prisma, TallyConnection } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../database/prisma.service';
import { ExcelGeneratorService } from '../excel/excel-generator.service';
import { TallyTunnelGateway } from '../gateway/tally-tunnel.gateway';
import { BankTransferMapper } from '../mapping/bank-transfer.mapper';
import { BillMapper } from '../mapping/bill.mapper';
import { CostCentreMapper } from '../mapping/cost-centre.mapper';
import { CreditNoteMapper } from '../mapping/credit-note.mapper';
import { CustomerMapper } from '../mapping/customer.mapper';
import { CustomerPaymentMapper } from '../mapping/customer-payment.mapper';
import { DepositMapper } from '../mapping/deposit.mapper';
import { ExpenseMapper } from '../mapping/expense.mapper';
import { LedgerMapper } from '../mapping/ledger.mapper';
import { GroupHierarchyResolver } from '../mapping/group-hierarchy.resolver';
import { InvoiceMapper } from '../mapping/invoice.mapper';
import { JournalMapper } from '../mapping/journal.mapper';
import { StockItemMapper } from '../mapping/stock-item.mapper';
import { StockJournalMapper } from '../mapping/stock-journal.mapper';
import { VendorCreditMapper } from '../mapping/vendor-credit.mapper';
import { VendorMapper } from '../mapping/vendor.mapper';
import { VendorPaymentMapper } from '../mapping/vendor-payment.mapper';
import { buildLedgerIndex, buildStockItemIndex, tallyDateToJsDate } from '../mapping/voucher-line.shared';
import {
  ZOHO_ENTITIES,
  ZohoEntityKey,
  templatePathFor,
  zohoEntityForVoucherType,
} from '../mapping/zoho-entity.map';
import { REDIS_CLIENT } from '../redis/redis.module';
import { withLock } from '../redis/lock.util';
import {
  TallyCostCentre,
  TallyGroup,
  TallyLedger,
  TallyStockItem,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
import { CreateExtractionDto } from './dto/create-extraction.dto';
import { FetchMasterDto } from './dto/fetch-master.dto';
import { ExtractableType } from './extraction-action.map';
import { ExtractionReuseService } from './extraction-reuse.service';
import { ExtractionJobData } from './extraction-job-data.interface';
import {
  DISPATCH_LOCK_TTL_MS,
  EXTRACTION_QUEUE,
  extractionDispatchLockKey,
  extractionResultKey,
} from './extractions.constants';

export interface ExcelExportResult {
  buffer: Buffer;
  filename: string;
}

@Injectable()
export class ExtractionsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EXTRACTION_QUEUE) private readonly queue: Queue<ExtractionJobData>,
    private readonly tunnel: TallyTunnelGateway,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly excel: ExcelGeneratorService,
    private readonly reuse: ExtractionReuseService,
  ) {}

  /**
   * Validates ownership + live connectivity up front — rejecting immediately
   * with a clear reason beats silently queueing a job that's certain to fail
   * a few seconds later (same "live feedback over a post-hoc failure" idea
   * the rest of this project follows).
   */
  async create(
    orgId: string,
    notifyEmail: string,
    dto: CreateExtractionDto,
  ): Promise<{ id: string; status: string }> {
    const connection = await this.prisma.tallyConnection.findFirst({
      where: { id: dto.connectionId, orgId },
    });
    if (!connection) {
      throw new NotFoundException('Connection not found.');
    }

    const company = this.resolveCompany(connection, dto.payload?.company as string | undefined);
    // Merged back into the payload the agent actually receives — resolving
    // `company` only for the DB record and forgetting to also thread it
    // through to the dispatched job would silently drop the connection's
    // defaultCompany fallback (caught live: see git history for this line).
    const payload = company ? { ...dto.payload, company } : (dto.payload ?? {});

    return this.enqueue(orgId, connection, dto.type, payload, notifyEmail, dto.forceRefresh);
  }

  /**
   * Company-name-first entry point: resolves the paired connector by
   * `TallyConnection.defaultCompany` instead of requiring the caller to
   * already know its connectionId, and accepts a friendly ISO date range for
   * masters whose balances are period-scoped (Ledgers/Stock Items). Reuses
   * the exact same job/queue pipeline as `create` — see `enqueue`.
   */
  async fetchMaster(
    orgId: string,
    notifyEmail: string,
    dto: FetchMasterDto,
  ): Promise<{ id: string; status: string }> {
    if (dto.fromDate && dto.toDate && dto.fromDate > dto.toDate) {
      throw new BadRequestException(
        `fromDate (${dto.fromDate}) must not be after toDate (${dto.toDate}).`,
      );
    }

    const connection = await this.resolveConnectionByCompany(orgId, dto.companyName);

    const payload: Record<string, unknown> = { company: dto.companyName };
    if (dto.fromDate) payload.fromDate = dto.fromDate;
    if (dto.toDate) payload.toDate = dto.toDate;

    return this.enqueue(orgId, connection, dto.masterType, payload, notifyEmail, dto.forceRefresh);
  }

  /**
   * Shared job-creation tail for `create` and `fetchMaster`: validates the
   * connection is usable right now (rather than queueing a job certain to
   * fail seconds later), persists the audit row, and enqueues the actual work.
   */
  private async enqueue(
    orgId: string,
    connection: TallyConnection,
    type: ExtractableType,
    payload: Record<string, unknown>,
    notifyEmail: string,
    forceRefresh = false,
  ): Promise<{ id: string; status: string }> {
    if (!connection.isActive) {
      throw new BadRequestException('This connection has been revoked.');
    }
    if (!this.tunnel.listConnectedAgents().includes(connection.id)) {
      throw new BadRequestException('This connector is not currently online.');
    }

    if (!forceRefresh) {
      const reused = await this.tryReuse(orgId, connection.id, type, payload);
      if (reused) return { id: reused.id, status: reused.status };
    }

    const job = await this.prisma.extractionJob.create({
      data: {
        type,
        status: 'PENDING',
        company: (payload.company as string | undefined) ?? null,
        params: payload as Prisma.InputJsonValue,
        orgId,
        connectionId: connection.id,
      },
    });

    await this.queue.add('extract', {
      mode: 'agent',
      extractionJobId: job.id,
      connectionId: connection.id,
      type,
      payload,
      notifyEmail,
    });

    return { id: job.id, status: job.status };
  }

  /**
   * Guards ExtractionReuseService's lookup against a race with a concurrent
   * identical request: without this, two callers dispatching the same
   * request at nearly the same instant could both miss the reuse check
   * (nothing to find yet) and both create a job / hit Tally. The lock is
   * held only for the check itself, not the whole dispatch — deliberately
   * short (DISPATCH_LOCK_TTL_MS) and best-effort: on contention this just
   * falls through to a normal fresh dispatch rather than blocking, which is
   * always safe (every extraction is a Tally READ — see
   * extractions.module.ts's own doc comment — so the worst case of losing
   * this race is one harmless duplicate fetch, not a correctness bug).
   */
  private async tryReuse(
    orgId: string,
    connectionId: string,
    type: ExtractableType,
    payload: Record<string, unknown>,
  ): Promise<ExtractionJob | null> {
    const lockKey = extractionDispatchLockKey(
      orgId,
      connectionId,
      type,
      (payload.company as string | undefined) ?? '',
      this.reuseVariant(type, payload),
    );

    // `withLock` returns null both when the lock was contended AND when fn()
    // itself legitimately found nothing reusable — either way, falling
    // through to a fresh dispatch is exactly the right behavior.
    return withLock(this.redis, lockKey, DISPATCH_LOCK_TTL_MS, () =>
      this.reuse.findReusable(orgId, connectionId, type, payload),
    );
  }

  /** The part of `payload` that distinguishes otherwise-identical requests
   *  for the SAME company — must mirror ExtractionReuseService's own
   *  per-type matching rules exactly, or the lock and the reuse check could
   *  disagree about what counts as "the same request." */
  private reuseVariant(
    type: ExtractableType,
    payload: Record<string, unknown>,
  ): string | undefined {
    if (type === ExtractionType.VOUCHERS) {
      return `${payload.voucherType ?? ''}:${payload.from ?? ''}:${payload.to ?? ''}`;
    }
    if (type === ExtractionType.LEDGERS || type === ExtractionType.STOCK_ITEMS) {
      return `${payload.fromDate ?? ''}:${payload.toDate ?? ''}`;
    }
    return undefined;
  }

  /**
   * A connector is paired to (at most) one company via `defaultCompany`.
   * Letting a caller freely override that with an arbitrary string would
   * violate docs/architecture.md's non-negotiable — "an agent can only ever
   * act on the org/company it's paired to" — so an explicit company is only
   * accepted when it matches the pairing, or when the connection has no fixed
   * company configured yet (an unpaired/multi-company agent).
   */
  private resolveCompany(connection: TallyConnection, requested?: string): string | undefined {
    if (!requested) return connection.defaultCompany ?? undefined;
    if (connection.defaultCompany && requested !== connection.defaultCompany) {
      throw new BadRequestException(
        `Company "${requested}" does not match this connector's paired company ` +
          `("${connection.defaultCompany}"). An agent can only extract from the company ` +
          'it is paired to — pair a separate connector for a different company.',
      );
    }
    return requested;
  }

  /**
   * Resolves a connector by exact companyName match within the caller's org —
   * the inverse lookup of resolveCompany, used by fetchMaster where
   * companyName (not connectionId) is the primary input. `connectionId` is
   * meant to stay an internal implementation detail on this path (see
   * docs/architecture.md's "no UUIDs in the simplified flow" — the frontend
   * never needs to know or show one), so ambiguity is resolved automatically
   * here rather than surfaced back to the caller as a list of ids to choose
   * from.
   */
  private async resolveConnectionByCompany(
    orgId: string,
    companyName: string,
  ): Promise<TallyConnection> {
    // isActive: true is not optional here — a revoked connection is a dead
    // credential, not a candidate.
    const matches = await this.prisma.tallyConnection.findMany({
      where: { orgId, defaultCompany: companyName, isActive: true },
    });

    if (matches.length === 0) {
      throw new NotFoundException(
        `No active connector is paired with company "${companyName}". Company names must match ` +
          'exactly as configured in Connections (GET /connections); use POST /extractions ' +
          'with an explicit connectionId instead if this connector serves multiple companies.',
      );
    }
    if (matches.length === 1) {
      return matches[0];
    }

    // A DB-level unique index (see schema.prisma's TallyConnection doc
    // comment) now prevents new duplicates, so multiple matches here can only
    // mean pre-existing data. Auto-resolve rather than error: prefer whichever
    // is actually online right now (a dead pairing that never connected loses
    // to a live one every time), then whichever last authenticated.
    const online = new Set(this.tunnel.listConnectedAgents());
    const onlineMatches = matches.filter((m) => online.has(m.id));
    const pool = onlineMatches.length > 0 ? onlineMatches : matches;
    return pool.reduce((best, candidate) =>
      (candidate.lastSeenAt?.getTime() ?? 0) > (best.lastSeenAt?.getTime() ?? 0) ? candidate : best,
    );
  }

  /**
   * Public wrapper around resolveConnectionByCompany for callers (e.g.
   * BulkExportService) that need a connectionId to call `create` with
   * directly — VOUCHERS isn't in MASTER_EXTRACTABLE_TYPES, so `fetchMaster`
   * can't be used for it. Returns just the id, not the full TallyConnection
   * row (which carries tokenHash), keeping that field from leaking any
   * further than it needs to.
   */
  async resolveConnectionId(orgId: string, companyName: string): Promise<string> {
    const connection = await this.resolveConnectionByCompany(orgId, companyName);
    return connection.id;
  }

  async getStatus(orgId: string, id: string): Promise<ExtractionJob> {
    const job = await this.prisma.extractionJob.findFirst({ where: { id, orgId } });
    if (!job) {
      throw new NotFoundException('Job not found.');
    }
    return job;
  }

  /**
   * Removes a single extraction job from history: its Postgres row and its
   * cached Redis result (best-effort — an already-expired result is not an
   * error). Refuses while still PENDING, same reasoning as
   * BulkExportService.remove — deleting a row the queue worker is about to
   * `update()` on completion would surface as a harmless-but-noisy Prisma
   * "record not found" in the logs for no real benefit. A job that's part of
   * a bulk export's step list is never exposed for individual deletion by
   * the frontend (it's rendered nested under that export's own row instead),
   * so this only ever needs to handle the standalone case.
   */
  async remove(orgId: string, id: string): Promise<void> {
    const job = await this.getStatus(orgId, id);
    if (job.status === 'PENDING') {
      throw new BadRequestException(
        `Job ${id} is still pending — wait for it to finish before deleting it.`,
      );
    }
    await this.redis.del(extractionResultKey(id)).catch(() => undefined);
    await this.prisma.extractionJob.deleteMany({ where: { id, orgId } });
  }

  /** Recent jobs for the org, newest first — what the UI's job list/download
   *  picker is actually backed by (there was no persisted listing before
   *  this; the frontend tracked jobs in session-only React state). */
  async listJobs(orgId: string, limit = 50): Promise<ExtractionJob[]> {
    return this.prisma.extractionJob.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async getResult(orgId: string, id: string): Promise<unknown> {
    const { data } = await this.loadSuccessfulResult(orgId, id);
    return data;
  }

  /**
   * Zoho-import-ready Excel for the entity types that have a mapper today.
   * LEDGERS requires a separately-completed GROUPS job to resolve the
   * Account Type/Customer-vs-Vendor classification correctly — see
   * src/mapping/group-hierarchy.resolver.ts for why a flat parent-name
   * lookup isn't good enough. VOUCHERS similarly requires a completed
   * STOCK_ITEMS job to resolve each line's HSN/GST rate — see
   * invoice.mapper.ts's doc comment for why that comes from the item master
   * rather than the voucher itself. Each extraction job stays single-purpose
   * (one job, one Tally call, per docs/architecture.md Phase 4); combining
   * two completed jobs' results happens here, at export time, not by
   * growing the job payload.
   *
   * The companion job (`groupsJobId`/`itemsJobId`) is auto-resolved to the
   * most recent successful job of that type for the same org+company when
   * not passed explicitly — a caller (the UI, a script) never needs to know
   * or look up a second job's id to download; a manual override is still
   * accepted for the rare case of wanting a specific older companion run.
   * Caught live: requiring callers to paste a companion job id by hand was
   * exactly the kind of manual-lookup UX this project's whole "extraction
   * job" abstraction was supposed to make unnecessary.
   *
   * A single LEDGERS job can produce 3 different Zoho exports (Chart of
   * Accounts, Customers, Vendors) depending which slice of the same ledger
   * set the caller wants — `ledgerEntity` selects which; defaults to 'COA'
   * for backward compatibility with callers that don't pass it. A VOUCHERS
   * job's target (Invoice/Bill/Credit Note/Stock Journal) isn't a caller
   * choice at all — it's fixed by which `voucherType` the job was fetched
   * with (stored on the job's own `params`), resolved via
   * zohoEntityForVoucherType.
   *
   * A CREDIT_NOTE export additionally accepts `invoicesJobId` — a
   * completed VOUCHERS job for the same company's Sales/Invoice vouchers,
   * auto-resolved the same way as groupsJobId/itemsJobId — used to look up
   * "Associated Invoice Date" by invoice number (see credit-note.mapper.ts).
   * Optional: a Credit Note export with none available still succeeds,
   * just with that one column left blank rather than blocked entirely.
   *
   * Every voucher-derived export except STOCK_JOURNAL/JOURNAL additionally
   * auto-resolves a LEDGERS job (same best-effort shape as `ledgersJobId`
   * below) to join in the party's Billing/Shipping/Contact/Payment
   * Terms/Customer or Vendor Number/bank details — an export with no
   * LEDGERS job available still succeeds, just with those columns blank.
   * VENDOR_PAYMENT/EXPENSE/DEPOSIT/BANK_TRANSFER additionally auto-resolve a
   * GROUPS job (same best-effort shape) to classify each voucher's ledgers
   * by standard group — see vendor-payment.mapper.ts/expense.mapper.ts/
   * deposit.mapper.ts/bank-transfer.mapper.ts; with no GROUPS job
   * resolvable, every ledger resolves to no group, so these 4 entities each
   * conservatively produce zero rows rather than guessing a classification.
   *
   * `voucherType` 'Payment' and 'Contra' each match 2 possible Zoho
   * entities (VENDOR_PAYMENT/EXPENSE, DEPOSIT/BANK_TRANSFER — see
   * zoho-entity.map.ts's doc comment), so `zohoEntityForVoucherType` alone
   * can't resolve them. `voucherEntity` disambiguates: required (400 if
   * missing or not one of the 2 valid options for this job's voucherType)
   * exactly when the type is ambiguous; ignored otherwise — the same
   * "caller picks which of several possible exports this one raw
   * extraction produces" shape `ledgerEntity` already has for LEDGERS jobs.
   *
   * An INVOICE/VENDOR_PAYMENT/CUSTOMER_PAYMENT export additionally accepts
   * `ledgersJobId`/`invoicesJobId` as documented above/below — naming
   * stays `invoicesJobId` even for VENDOR_PAYMENT's companion Purchase-
   * voucher job, since it serves the identical "resolve bill/invoice dates
   * for the per-allocation columns" purpose as CREDIT_NOTE's.
   */
  async getExcelResult(
    orgId: string,
    id: string,
    groupsJobId?: string,
    ledgerEntity: 'COA' | 'CUSTOMER' | 'VENDOR' = 'COA',
    itemsJobId?: string,
    invoicesJobId?: string,
    ledgersJobId?: string,
    voucherEntity?: ZohoEntityKey,
  ): Promise<ExcelExportResult> {
    const job = await this.getStatus(orgId, id);
    this.assertSuccessful(job);

    if (job.type === 'LEDGERS' && !groupsJobId) {
      groupsJobId = await this.resolveLatestSuccessfulJobId(orgId, job.company, 'GROUPS');
      if (!groupsJobId) {
        throw new BadRequestException(
          'LEDGERS Excel export needs a completed GROUPS extraction for the same company first ' +
            `(none found for "${job.company ?? 'this company'}") — run one via POST ` +
            '/extractions/fetch-master with masterType: GROUPS, or pass ?groupsJobId= explicitly.',
        );
      }
    }
    if (job.type === 'VOUCHERS' && !itemsJobId) {
      itemsJobId = await this.resolveLatestSuccessfulJobId(orgId, job.company, 'STOCK_ITEMS');
      if (!itemsJobId) {
        throw new BadRequestException(
          'VOUCHERS Excel export needs a completed STOCK_ITEMS extraction for the same company ' +
            `first (none found for "${job.company ?? 'this company'}") — run one via POST ` +
            '/extractions/fetch-master with masterType: STOCK_ITEMS, or pass ?itemsJobId= explicitly.',
        );
      }
    }

    const data = await this.loadResultData(id);

    if (job.type === 'STOCK_ITEMS') {
      const rows = new StockItemMapper().toItemRows(data as TallyStockItem[]);
      return this.writeZohoExport('ITEM', rows, `items-${id}.xlsx`);
    }

    if (job.type === 'COST_CENTRES') {
      const rows = new CostCentreMapper().toReportingTagRows(data as TallyCostCentre[]);
      return this.writeZohoExport('COST_CENTRE', rows, `reporting-tags-${id}.xlsx`);
    }

    if (job.type === 'LEDGERS') {
      const groupsJob = await this.getStatus(orgId, groupsJobId!);
      this.assertSuccessful(groupsJob);
      if (groupsJob.type !== 'GROUPS') {
        throw new BadRequestException('groupsJobId must reference a completed GROUPS job.');
      }
      const groups = await this.loadResultData(groupsJobId!);
      const resolver = new GroupHierarchyResolver(groups as TallyGroup[]);
      const ledgers = data as TallyLedger[];

      if (ledgerEntity === 'CUSTOMER') {
        const rows = new CustomerMapper(resolver).toCustomerRows(ledgers);
        return this.writeZohoExport('CUSTOMER', rows, `customers-${id}.xlsx`);
      }
      if (ledgerEntity === 'VENDOR') {
        const rows = new VendorMapper(resolver).toVendorRows(ledgers);
        return this.writeZohoExport('VENDOR', rows, `vendors-${id}.xlsx`);
      }
      const rows = new LedgerMapper(resolver).toAccountRows(ledgers);
      return this.writeZohoExport('COA', rows, `accounts-${id}.xlsx`);
    }

    if (job.type === 'VOUCHERS') {
      const params = job.params as Record<string, unknown> | null;
      const voucherType = typeof params?.voucherType === 'string' ? params.voucherType : undefined;
      // 'Payment'/'Contra' are genuinely ambiguous (2 possible entities
      // each) — zohoEntityForVoucherType returns undefined for them on
      // purpose; resolve via the caller-supplied voucherEntity instead. See
      // this method's doc comment and zoho-entity.map.ts's.
      const AMBIGUOUS_VOUCHER_TYPES: Record<string, ZohoEntityKey[]> = {
        Payment: ['VENDOR_PAYMENT', 'EXPENSE'],
        Contra: ['DEPOSIT', 'BANK_TRANSFER'],
      };
      let entityKey = zohoEntityForVoucherType(voucherType);
      if (!entityKey && voucherType && AMBIGUOUS_VOUCHER_TYPES[voucherType]) {
        const options = AMBIGUOUS_VOUCHER_TYPES[voucherType];
        if (!voucherEntity || !options.includes(voucherEntity)) {
          throw new BadRequestException(
            `A "${voucherType}" voucher export is ambiguous — pass ?voucherEntity= as one of: ` +
              `${options.join(', ')}.`,
          );
        }
        entityKey = voucherEntity;
      }
      if (!entityKey) {
        throw new BadRequestException(
          `Excel export not supported for voucher type "${voucherType ?? 'unknown'}" ` +
            '(no matching Zoho template — see zoho-entity.map.ts).',
        );
      }

      const itemsJob = await this.getStatus(orgId, itemsJobId!);
      this.assertSuccessful(itemsJob);
      if (itemsJob.type !== 'STOCK_ITEMS') {
        throw new BadRequestException('itemsJobId must reference a completed STOCK_ITEMS job.');
      }
      const items = await this.loadResultData(itemsJobId!);
      const itemIndex = buildStockItemIndex(items as TallyStockItem[]);
      const vouchers = data as TallyVoucher[];

      // Best-effort, not required: see this method's doc comment — every
      // voucher-derived export (except STOCK_JOURNAL/JOURNAL, neither of
      // which has a party to join) with no LEDGERS job available still
      // succeeds, just with the ledger-joined columns (Customer/Vendor
      // Number/Billing/Shipping/Contact/Payment Terms/bank details) left
      // blank.
      let ledgerIndex = buildLedgerIndex([]);
      if (entityKey !== 'STOCK_JOURNAL' && entityKey !== 'JOURNAL') {
        const resolvedLedgersJobId =
          ledgersJobId ?? (await this.resolveLatestSuccessfulJobId(orgId, job.company, 'LEDGERS'));
        if (resolvedLedgersJobId) {
          const ledgersJob = await this.getStatus(orgId, resolvedLedgersJobId);
          if (ledgersJob.status === 'SUCCESS' && ledgersJob.type === 'LEDGERS') {
            const ledgers = (await this.loadResultData(resolvedLedgersJobId)) as TallyLedger[];
            ledgerIndex = buildLedgerIndex(ledgers);
          }
        }
      }

      // Same best-effort shape, only for the 4 entities that actually
      // classify ledgers by standard group — see this method's doc comment.
      let hierarchy = new GroupHierarchyResolver([]);
      if (
        entityKey === 'VENDOR_PAYMENT' ||
        entityKey === 'EXPENSE' ||
        entityKey === 'DEPOSIT' ||
        entityKey === 'BANK_TRANSFER'
      ) {
        const resolvedGroupsJobIdForVouchers =
          groupsJobId ?? (await this.resolveLatestSuccessfulJobId(orgId, job.company, 'GROUPS'));
        if (resolvedGroupsJobIdForVouchers) {
          const groupsJobForVouchers = await this.getStatus(orgId, resolvedGroupsJobIdForVouchers);
          if (groupsJobForVouchers.status === 'SUCCESS' && groupsJobForVouchers.type === 'GROUPS') {
            const groupsForVouchers = (await this.loadResultData(
              resolvedGroupsJobIdForVouchers,
            )) as TallyGroup[];
            hierarchy = new GroupHierarchyResolver(groupsForVouchers);
          }
        }
      }

      if (entityKey === 'INVOICE') {
        const rows = new InvoiceMapper(itemIndex, ledgerIndex).toInvoiceRows(vouchers);
        return this.writeZohoExport('INVOICE', rows, `invoices-${id}.xlsx`);
      }
      if (entityKey === 'BILL') {
        const rows = new BillMapper(itemIndex, ledgerIndex).toBillRows(vouchers);
        return this.writeZohoExport('BILL', rows, `bills-${id}.xlsx`);
      }
      if (entityKey === 'CREDIT_NOTE') {
        // Best-effort, not required: see this method's doc comment. A
        // Credit Note export still succeeds with no Invoice companion job
        // at all — "Associated Invoice Date" just stays blank, the same
        // "real data or blank, never guessed" standard the mapper itself
        // follows for a reference number that doesn't resolve.
        const invoiceDatesByNumber = await this.resolveVoucherDateMap(
          orgId,
          job.company,
          invoicesJobId,
          ZOHO_ENTITIES.INVOICE.voucherType,
        );
        const rows = new CreditNoteMapper(itemIndex, ledgerIndex, invoiceDatesByNumber).toCreditNoteRows(
          vouchers,
        );
        return this.writeZohoExport('CREDIT_NOTE', rows, `credit-notes-${id}.xlsx`);
      }
      if (entityKey === 'VENDOR_CREDIT') {
        const rows = new VendorCreditMapper(itemIndex, ledgerIndex).toVendorCreditRows(vouchers);
        return this.writeZohoExport('VENDOR_CREDIT', rows, `vendor-credits-${id}.xlsx`);
      }
      if (entityKey === 'JOURNAL') {
        const rows = new JournalMapper().toJournalRows(vouchers);
        return this.writeZohoExport('JOURNAL', rows, `journals-${id}.xlsx`);
      }
      if (entityKey === 'CUSTOMER_PAYMENT') {
        // Best-effort companion Sales job — same shape as CREDIT_NOTE's
        // invoicesJobId above, resolves real bill dates for the per-
        // allocation "Invoice Date" column (see
        // customer-payment.mapper.ts's doc comment).
        const invoiceDatesByNumber = await this.resolveVoucherDateMap(
          orgId,
          job.company,
          invoicesJobId,
          ZOHO_ENTITIES.INVOICE.voucherType,
        );
        const rows = new CustomerPaymentMapper(ledgerIndex, invoiceDatesByNumber).toCustomerPaymentRows(
          vouchers,
        );
        return this.writeZohoExport('CUSTOMER_PAYMENT', rows, `customer-payments-${id}.xlsx`);
      }
      if (entityKey === 'VENDOR_PAYMENT') {
        // Same best-effort shape, against the companion Purchase job
        // instead — see vendor-payment.mapper.ts's doc comment.
        const billDatesByNumber = await this.resolveVoucherDateMap(
          orgId,
          job.company,
          invoicesJobId,
          ZOHO_ENTITIES.BILL.voucherType,
        );
        const rows = new VendorPaymentMapper(ledgerIndex, hierarchy, billDatesByNumber).toVendorPaymentRows(
          vouchers,
        );
        return this.writeZohoExport('VENDOR_PAYMENT', rows, `vendor-payments-${id}.xlsx`);
      }
      if (entityKey === 'EXPENSE') {
        const rows = new ExpenseMapper(ledgerIndex, hierarchy).toExpenseRows(vouchers);
        return this.writeZohoExport('EXPENSE', rows, `expenses-${id}.xlsx`);
      }
      if (entityKey === 'DEPOSIT') {
        const rows = new DepositMapper(ledgerIndex, hierarchy).toDepositRows(vouchers);
        return this.writeZohoExport('DEPOSIT', rows, `deposits-${id}.xlsx`);
      }
      if (entityKey === 'BANK_TRANSFER') {
        const rows = new BankTransferMapper(ledgerIndex, hierarchy).toBankTransferRows(vouchers);
        return this.writeZohoExport('BANK_TRANSFER', rows, `bank-transfers-${id}.xlsx`);
      }
      const rows = new StockJournalMapper(itemIndex).toStockJournalRows(vouchers);
      return this.writeZohoExport('STOCK_JOURNAL', rows, `inventory-adjustments-${id}.xlsx`);
    }

    throw new BadRequestException(`Excel export not yet supported for ${job.type}.`);
  }

  /**
   * Shared by CREDIT_NOTE/CUSTOMER_PAYMENT/VENDOR_PAYMENT: resolves a
   * companion VOUCHERS job (of `companionVoucherType`, auto-resolved like
   * every other companion job here unless `explicitJobId` is given) into a
   * voucherNumber -> real Date lookup — best-effort, undefined (not a
   * throw) whenever the companion job can't be found/loaded, matching
   * every other "real data or blank, never guessed" companion-job standard
   * in this method.
   */
  private async resolveVoucherDateMap(
    orgId: string,
    company: string | null,
    explicitJobId: string | undefined,
    companionVoucherType: string | undefined,
  ): Promise<Map<string, Date> | undefined> {
    const resolvedJobId =
      explicitJobId ??
      (await this.resolveLatestSuccessfulJobId(orgId, company, 'VOUCHERS', companionVoucherType));
    if (!resolvedJobId) return undefined;
    const companionJob = await this.getStatus(orgId, resolvedJobId);
    if (companionJob.status !== 'SUCCESS' || companionJob.type !== 'VOUCHERS') return undefined;
    const companionVouchers = (await this.loadResultData(resolvedJobId)) as TallyVoucher[];
    const datesByNumber = new Map<string, Date>();
    for (const voucher of companionVouchers) {
      const date = tallyDateToJsDate(voucher.date);
      if (voucher.voucherNumber && date) {
        datesByNumber.set(voucher.voucherNumber, date);
      }
    }
    return datesByNumber;
  }

  /**
   * The auto-resolution behind getExcelResult's companion-job lookup: the
   * most recently *created* successful job of `type` for the same org+
   * company — not the most recent by any other measure, since a caller
   * downloading right after a fresh extraction almost always wants that
   * fresh data, not an older run that happened to finish later (retries can
   * reorder completion times). Returns undefined (not a throw) when there's
   * no candidate — the caller decides how to respond to "not found."
   */
  private async resolveLatestSuccessfulJobId(
    orgId: string,
    company: string | null,
    type: ExtractionType,
    /**
     * Added 2026-09-10 for the CREDIT_NOTE -> invoicesJobId dependency: a
     * company can have several completed VOUCHERS jobs (Sales/Invoice,
     * Purchase/Bill, Credit Note, …), distinguished only by their own
     * `params.voucherType`, not by `type` alone (every one of them is
     * `type: 'VOUCHERS'`). Filtering here — rather than in the caller —
     * keeps the "most recent successful match" auto-resolve semantics
     * identical to the existing groupsJobId/itemsJobId lookups.
     */
    voucherType?: string,
  ): Promise<string | undefined> {
    if (!company) return undefined;
    const job = await this.prisma.extractionJob.findFirst({
      where: {
        orgId,
        company,
        type,
        status: 'SUCCESS',
        ...(voucherType ? { params: { path: ['voucherType'], equals: voucherType } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return job?.id;
  }

  /** Writes mapped rows into the real Zoho template for `key` (see
   *  zoho-entity.map.ts) and returns a ready-to-download buffer. */
  private async writeZohoExport<T extends object>(
    key: ZohoEntityKey,
    rows: T[],
    filename: string,
  ): Promise<ExcelExportResult> {
    const { sheetName } = ZOHO_ENTITIES[key];
    const buffer = await this.excel.writeIntoTemplate(templatePathFor(key), sheetName, rows);
    return { buffer, filename };
  }

  private assertSuccessful(job: ExtractionJob): void {
    if (job.status === 'PENDING') {
      throw new BadRequestException('Job has not finished yet.');
    }
    if (job.status === 'FAILED') {
      throw new BadRequestException(job.error ?? 'Extraction failed.');
    }
  }

  private async loadResultData(id: string): Promise<unknown> {
    const raw = await this.redis.get(extractionResultKey(id));
    if (!raw) {
      throw new NotFoundException('Result has expired or is no longer available.');
    }
    return JSON.parse(raw);
  }

  private async loadSuccessfulResult(
    orgId: string,
    id: string,
  ): Promise<{ job: ExtractionJob; data: unknown }> {
    const job = await this.getStatus(orgId, id);
    this.assertSuccessful(job);
    const data = await this.loadResultData(id);
    return { job, data };
  }
}
