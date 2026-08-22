import { BadRequestException } from '@nestjs/common';
import { EnvelopeBuilder } from '../xml/envelope.builder';
import { TallyResponseParser } from '../xml/response.parser';
import { MasterExtractionService } from './master-extraction.service';

describe('MasterExtractionService', () => {
  // Large enough that no existing test's collection size accidentally
  // triggers batching — batching behavior itself is covered by its own
  // describe blocks below with an explicit small override.
  const NO_BATCHING = 1000;

  function makeService(
    overrides: {
      connectorPost?: jest.Mock;
      defaultCompany?: string;
      masterBatchSize?: number;
      periodBatchSize?: number;
      periodBatchSizeStockItems?: number;
      stockItemsPeriodScopingEnabled?: boolean;
      chunkDelayMs?: number;
      jobs?: { create: jest.Mock; save: jest.Mock; update: jest.Mock };
    } = {},
  ) {
    const builder = new EnvelopeBuilder();
    const buildLedgersRequest = jest.spyOn(builder, 'buildLedgersRequest');
    const buildStockItemsRequest = jest.spyOn(builder, 'buildStockItemsRequest');
    const buildLedgerNamesRequest = jest.spyOn(builder, 'buildLedgerNamesRequest');
    const buildStockItemNamesRequest = jest.spyOn(builder, 'buildStockItemNamesRequest');

    const connector = {
      post: overrides.connectorPost ?? jest.fn().mockResolvedValue('<ENVELOPE></ENVELOPE>'),
    };
    const parser = new TallyResponseParser();
    const config = {
      getOrThrow: () => ({
        defaultCompany: overrides.defaultCompany ?? '',
        masterBatchSize: overrides.masterBatchSize ?? NO_BATCHING,
        periodBatchSize: overrides.periodBatchSize ?? NO_BATCHING,
        periodBatchSizeStockItems: overrides.periodBatchSizeStockItems ?? NO_BATCHING,
        // Mirrors the real production default (false) — see
        // TallyConfig.stockItemsPeriodScopingEnabled. Tests that exercise
        // period-scoped STOCK_ITEMS batching must opt in explicitly.
        stockItemsPeriodScopingEnabled: overrides.stockItemsPeriodScopingEnabled ?? false,
        // 0 by default — tests should never actually wait on this; the
        // dedicated batching tests below override it and stub out the timer.
        chunkDelayMs: overrides.chunkDelayMs ?? 0,
      }),
    };

    const service = new MasterExtractionService(
      builder,
      connector as any,
      parser,
      config as any,
      overrides.jobs as any,
      undefined,
    );
    return {
      service,
      buildLedgersRequest,
      buildStockItemsRequest,
      buildLedgerNamesRequest,
      buildStockItemNamesRequest,
      connector,
    };
  }

  /** Bare-minimum ExtractionJobRepository double — `create` just echoes the
   *  data through, `save` stamps an id so runExtraction's `job` is non-null
   *  and reportProgress/finishJob actually call `update`. */
  function makeJobsRepo() {
    return {
      create: jest.fn((data: unknown) => data),
      save: jest.fn(async (data: unknown) => ({ id: 'job-1', ...(data as object) })),
      update: jest.fn().mockResolvedValue({}),
    };
  }

  /**
   * Names-only or full-field collection response, matching whichever tag the
   * parser expects for that type. Always includes AlterID — batching keys
   * off it, not the name (see MasterExtractionService's doc comment on why).
   */
  function collectionXml(
    tag: 'LEDGER' | 'STOCKITEM',
    entries: Array<{ name: string; alterId: number; reservedName?: string }>,
  ): string {
    const items = entries
      .map(
        (e) =>
          `<${tag} RESERVEDNAME="${e.reservedName ?? ''}">` +
          `<NAME>${e.name}</NAME><ALTERID>${e.alterId}</ALTERID></${tag}>`,
      )
      .join('');
    return `<ENVELOPE><BODY><DATA><COLLECTION>${items}</COLLECTION></DATA></BODY></ENVELOPE>`;
  }

  const entry = (name: string, alterId: number, reservedName?: string) => ({
    name,
    alterId,
    reservedName,
  });

  describe('getLedgers', () => {
    it('passes fromDate/toDate through to buildLedgersRequest when both are supplied', async () => {
      const { service, buildLedgersRequest } = makeService();

      await service.getLedgers('ABC Ltd', '20260401', '20260430');

      expect(buildLedgersRequest).toHaveBeenCalledWith('ABC Ltd', '20260401', '20260430');
    });

    it('builds ledgers with no period when fromDate/toDate are omitted (unchanged current-period behavior)', async () => {
      const { service, buildLedgersRequest } = makeService();

      await service.getLedgers('ABC Ltd');

      expect(buildLedgersRequest).toHaveBeenCalledWith('ABC Ltd', undefined, undefined);
    });

    it('rejects a fromDate after toDate, before ever calling the connector', async () => {
      const { service, connector } = makeService();

      await expect(service.getLedgers('ABC Ltd', '20260430', '20260401')).rejects.toThrow(
        BadRequestException,
      );
      expect(connector.post).not.toHaveBeenCalled();
    });

    it('falls back to the configured default company when none is supplied', async () => {
      const { service, buildLedgersRequest } = makeService({ defaultCompany: 'Default Co' });

      await service.getLedgers();

      expect(buildLedgersRequest).toHaveBeenCalledWith('Default Co', undefined, undefined);
    });

    it('rejects when no company is supplied and no default is configured', async () => {
      const { service } = makeService({ defaultCompany: '' });

      await expect(service.getLedgers()).rejects.toThrow(BadRequestException);
    });
  });

  describe('getStockItems', () => {
    it('rejects a period-scoped request by default — confirmed live to wedge Tally regardless of batch size', async () => {
      const { service, connector } = makeService();

      await expect(service.getStockItems('ABC Ltd', '20260401', '20260430')).rejects.toThrow(
        /Period-scoped Stock Item fetches.*are disabled/,
      );
      expect(connector.post).not.toHaveBeenCalled();
    });

    it('allows a period-scoped request through, passing fromDate/toDate to buildStockItemsRequest, once explicitly enabled', async () => {
      const { service, buildStockItemsRequest } = makeService({
        stockItemsPeriodScopingEnabled: true,
      });

      await service.getStockItems('ABC Ltd', '20260401', '20260430');

      expect(buildStockItemsRequest).toHaveBeenCalledWith('ABC Ltd', '20260401', '20260430');
    });

    it('never rejects an UNSCOPED request, regardless of stockItemsPeriodScopingEnabled', async () => {
      const { service, buildStockItemsRequest } = makeService();

      await service.getStockItems('ABC Ltd');

      expect(buildStockItemsRequest).toHaveBeenCalledWith('ABC Ltd', undefined, undefined);
    });

    it('rejects a fromDate after toDate before checking whether period scoping is enabled at all, before ever calling the connector', async () => {
      const { service, connector } = makeService({ stockItemsPeriodScopingEnabled: true });

      await expect(service.getStockItems('ABC Ltd', '20260430', '20260401')).rejects.toThrow(
        BadRequestException,
      );
      expect(connector.post).not.toHaveBeenCalled();
    });
  });

  describe('getGroups', () => {
    it('resolves the company and returns the mapped groups', async () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION><GROUP><NAME>Sundry Debtors</NAME><PARENT>Current Assets</PARENT></GROUP></COLLECTION></DATA></BODY></ENVELOPE>';
      const { service } = makeService({ connectorPost: jest.fn().mockResolvedValue(xml) });

      const result = await service.getGroups('ABC Ltd');

      expect(result).toEqual([{ name: 'Sundry Debtors', parent: 'Current Assets', alterId: null }]);
    });
  });

  describe('getCostCentres', () => {
    it('resolves the company and returns the mapped cost centres', async () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION><COSTCENTRE><NAME>Mumbai Branch</NAME><PARENT>Primary Cost Centre</PARENT><ALTERID>7</ALTERID></COSTCENTRE></COLLECTION></DATA></BODY></ENVELOPE>';
      const { service } = makeService({ connectorPost: jest.fn().mockResolvedValue(xml) });

      const result = await service.getCostCentres('ABC Ltd');

      expect(result).toEqual([
        { name: 'Mumbai Branch', parent: 'Primary Cost Centre', alterId: 7 },
      ]);
    });

    it('falls back to the configured default company when none is supplied', async () => {
      const connectorPost = jest.fn().mockResolvedValue('<ENVELOPE></ENVELOPE>');
      const { service } = makeService({ connectorPost, defaultCompany: 'Default Co' });

      await service.getCostCentres();

      expect(connectorPost).toHaveBeenCalledWith(expect.stringContaining('Default Co'));
    });
  });

  describe('getCompanies', () => {
    it('caches the result and does not call the connector again on a cache hit', async () => {
      const cached = [{ name: 'Cached Co' }];
      const connector = { post: jest.fn() };
      const builder = new EnvelopeBuilder();
      const parser = new TallyResponseParser();
      const config = { getOrThrow: () => ({ defaultCompany: '' }) };
      const redis = { get: jest.fn().mockResolvedValue(JSON.stringify(cached)), set: jest.fn() };

      const service = new MasterExtractionService(
        builder,
        connector as any,
        parser,
        config as any,
        undefined,
        redis as any,
      );

      const result = await service.getCompanies(true);

      expect(result).toEqual(cached);
      expect(connector.post).not.toHaveBeenCalled();
    });

    it('bypasses the cache when useCache=false', async () => {
      const connector = { post: jest.fn().mockResolvedValue('<ENVELOPE></ENVELOPE>') };
      const builder = new EnvelopeBuilder();
      const parser = new TallyResponseParser();
      const config = { getOrThrow: () => ({ defaultCompany: '' }) };
      const redis = {
        get: jest.fn().mockResolvedValue(JSON.stringify([{ name: 'Stale Co' }])),
        set: jest.fn(),
      };

      const service = new MasterExtractionService(
        builder,
        connector as any,
        parser,
        config as any,
        undefined,
        redis as any,
      );

      const result = await service.getCompanies(false);

      expect(result).toEqual([]);
      expect(connector.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('batching a large ledger collection', () => {
    it('stays a single request when the collection fits within masterBatchSize (no behavior change)', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 1), entry('B', 2)])) // cheap names+AlterID pass
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 1), entry('B', 2)])); // full fetch
      const { service, buildLedgersRequest, buildLedgerNamesRequest } = makeService({
        connectorPost,
        masterBatchSize: 5,
      });

      const result = await service.getLedgers('ABC Ltd');

      expect(buildLedgerNamesRequest).toHaveBeenCalledWith('ABC Ltd');
      expect(buildLedgersRequest).toHaveBeenCalledTimes(1);
      expect(buildLedgersRequest).toHaveBeenCalledWith('ABC Ltd', undefined, undefined);
      expect(result.map((l) => l.name)).toEqual(['A', 'B']);
    });

    it('splits a collection larger than masterBatchSize into AlterID-range batches (sorted numerically) and concatenates the results', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [
            entry('E', 50),
            entry('C', 30),
            entry('A', 10),
            entry('D', 40),
            entry('B', 20),
          ]),
        ) // unsorted names+AlterID pass
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 10), entry('B', 20)]))
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('C', 30), entry('D', 40)]))
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('E', 50)]));
      const { service, buildLedgersRequest, connector } = makeService({
        connectorPost,
        masterBatchSize: 2,
      });

      const result = await service.getLedgers('ABC Ltd');

      expect(buildLedgersRequest).toHaveBeenCalledTimes(3);
      expect(buildLedgersRequest).toHaveBeenNthCalledWith(1, 'ABC Ltd', undefined, undefined, {
        from: 10,
        to: 20,
      });
      expect(buildLedgersRequest).toHaveBeenNthCalledWith(2, 'ABC Ltd', undefined, undefined, {
        from: 30,
        to: 40,
      });
      expect(buildLedgersRequest).toHaveBeenNthCalledWith(3, 'ABC Ltd', undefined, undefined, {
        from: 50,
        to: 50,
      });
      // Sorted by AlterID numerically, not by name — the whole point of the redesign.
      expect(result.map((l) => l.name)).toEqual(['A', 'B', 'C', 'D', 'E']);

      // Batched calls disable per-call retries — same reasoning as voucher chunking.
      expect(connector.post).toHaveBeenCalledWith(expect.any(String), { retries: 0 });
    });

    it('throws instead of returning partial data when a batch drops records', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [
            entry('A', 1),
            entry('B', 2),
            entry('C', 3),
            entry('D', 4),
            entry('E', 5),
          ]),
        )
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 1)])) // should have been A,B — one dropped
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('C', 3), entry('D', 4)]))
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('E', 5)]));
      const { service } = makeService({ connectorPost, masterBatchSize: 2 });

      await expect(service.getLedgers('ABC Ltd')).rejects.toThrow(/expected 5/);
    });

    it('propagates a single batch failure rather than returning partial data', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [entry('A', 1), entry('B', 2), entry('C', 3)]),
        )
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 1)]))
        .mockRejectedValueOnce(new Error('Tally unreachable'));
      const { service } = makeService({ connectorPost, masterBatchSize: 1 });

      await expect(service.getLedgers('ABC Ltd')).rejects.toThrow('Tally unreachable');
    });

    it('pauses chunkDelayMs between batches, but not after the final one', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [entry('A', 1), entry('B', 2), entry('C', 3)]),
        )
        .mockResolvedValue(collectionXml('LEDGER', [entry('A', 1)]));
      const { service } = makeService({ connectorPost, masterBatchSize: 1, chunkDelayMs: 2000 });
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      await service.getLedgers('ABC Ltd');

      expect(sleepSpy).toHaveBeenCalledTimes(2); // between batch 1->2 and 2->3 only
      expect(sleepSpy).toHaveBeenCalledWith(2000, undefined); // no signal passed by this call
    });

    it('does not sleep at all on the single-request (unbatched) path', async () => {
      const connectorPost = jest.fn().mockResolvedValue(collectionXml('LEDGER', [entry('A', 1)]));
      const { service } = makeService({ connectorPost, masterBatchSize: 5, chunkDelayMs: 2000 });
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      await service.getLedgers('ABC Ltd');

      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it('stops the batch loop early when the signal is aborted between batches, instead of completing every batch', async () => {
      const controller = new AbortController();
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [entry('A', 1), entry('B', 2), entry('C', 3)]),
        ) // names+AlterID pass
        .mockImplementationOnce(async () => {
          controller.abort(); // abort right after batch 1 lands, before batch 2 starts
          return collectionXml('LEDGER', [entry('A', 1)]);
        });
      const { service, connector } = makeService({ connectorPost, masterBatchSize: 1 });

      await expect(
        service.getLedgers('ABC Ltd', undefined, undefined, controller.signal),
      ).rejects.toThrow('cancelled');

      // Names pass + batch 1 only — batches 2 and 3 never started.
      expect(connector.post).toHaveBeenCalledTimes(2);
    });

    it('passes the signal through to each batch request', async () => {
      const controller = new AbortController();
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 1), entry('B', 2)]))
        .mockResolvedValue(collectionXml('LEDGER', [entry('A', 1)]));
      const { service, connector } = makeService({ connectorPost, masterBatchSize: 1 });

      await service.getLedgers('ABC Ltd', undefined, undefined, controller.signal);

      expect(connector.post).toHaveBeenCalledWith(expect.any(String), {
        retries: 0,
        signal: controller.signal,
      });
    });

    it('reports progress once per batch via the job repository, then clears it on completion', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [entry('A', 1), entry('B', 2), entry('C', 3)]),
        )
        .mockResolvedValue(collectionXml('LEDGER', [entry('A', 1)]));
      const jobs = makeJobsRepo();
      const { service } = makeService({ connectorPost, masterBatchSize: 1, jobs });

      await service.getLedgers('ABC Ltd');

      // 3 in-progress updates (one per batch) + 1 final update from finishJob
      // (which also clears progress back to null on completion).
      expect(jobs.update).toHaveBeenCalledTimes(4);
      expect(jobs.update.mock.calls[0]).toEqual([
        'job-1',
        { progress: expect.stringContaining('batch 1/3') },
      ]);
      expect(jobs.update.mock.calls[3]).toEqual([
        'job-1',
        expect.objectContaining({ progress: null, status: 'SUCCESS' }),
      ]);
    });

    it('writes batch progress to the caller-supplied externalJobId instead of creating its own row, and never finalizes it (the caller owns that)', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [entry('A', 1), entry('B', 2), entry('C', 3)]),
        )
        .mockResolvedValue(collectionXml('LEDGER', [entry('A', 1)]));
      const jobs = makeJobsRepo();
      const { service } = makeService({ connectorPost, masterBatchSize: 1, jobs });

      await service.getLedgers('ABC Ltd', undefined, undefined, undefined, 'queued-job-42');

      // No second, uncoordinated audit row created for this run.
      expect(jobs.create).not.toHaveBeenCalled();
      expect(jobs.save).not.toHaveBeenCalled();
      // Every progress write targets the id the queued caller already owns
      // and is polling — not a fresh id this method minted itself.
      for (const call of jobs.update.mock.calls) {
        expect(call[0]).toBe('queued-job-42');
      }
      // No terminal status/recordCount write here — the queued caller
      // (ExtractionsProcessor) owns finalizing that row itself, once dispatch
      // resolves; a second writer here would race it.
      expect(jobs.update).not.toHaveBeenCalledWith(
        'queued-job-42',
        expect.objectContaining({ status: 'SUCCESS' }),
      );
    });

    it('logs a warning and lets the count cross-check catch it when a record has no AlterID to batch by', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [entry('A', 1), entry('B', 2)]).replace(
            '<ALTERID>2</ALTERID>',
            '',
          ), // B has no AlterID at all
        )
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 1)]));
      const { service } = makeService({ connectorPost, masterBatchSize: 1 });

      // Only 1 of 2 records is batchable by AlterID; the cross-check expects
      // the full original count (2) and must fail loudly rather than
      // silently return just the 1 record that could be batched.
      await expect(service.getLedgers('ABC Ltd')).rejects.toThrow(/expected 2/);
    });

    it('uses periodBatchSize instead of masterBatchSize once fromDate/toDate are supplied, even when the collection fits within masterBatchSize', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [entry('A', 1), entry('B', 2), entry('C', 3)]),
        ) // names+AlterID pass — 3 records
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 1), entry('B', 2)]))
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('C', 3)]));
      const { service, buildLedgersRequest } = makeService({
        connectorPost,
        masterBatchSize: 1000, // would NOT batch a 3-record collection on its own
        periodBatchSize: 2, // but period-scoped requests must still batch at this size
      });

      const result = await service.getLedgers('ABC Ltd', '20260401', '20260430');

      expect(buildLedgersRequest).toHaveBeenCalledTimes(2);
      expect(buildLedgersRequest).toHaveBeenNthCalledWith(1, 'ABC Ltd', '20260401', '20260430', {
        from: 1,
        to: 2,
      });
      expect(buildLedgersRequest).toHaveBeenNthCalledWith(2, 'ABC Ltd', '20260401', '20260430', {
        from: 3,
        to: 3,
      });
      expect(result.map((l) => l.name)).toEqual(['A', 'B', 'C']);
    });

    it('excludes reserved ledgers (e.g. Profit & Loss A/c) from period-scoped batches, returning them with a null balance instead', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [
            entry('Profit & Loss A/c', 1, 'Profit & Loss A/c'), // reserved — must not be batched
            entry('A', 2),
            entry('B', 3),
          ]),
        ) // names+AlterID pass
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 2), entry('B', 3)]));
      const { service, buildLedgersRequest } = makeService({
        connectorPost,
        periodBatchSize: 10, // large enough that A+B alone would take the unbatched path
      });

      const result = await service.getLedgers('ABC Ltd', '20260401', '20260430');

      // Only ONE request for the actual balance data — for A and B via an
      // AlterID range that itself excludes the reserved ledger (1-1 is
      // never requested). No request is ever made asking Tally for the
      // reserved ledger's period balance.
      expect(buildLedgersRequest).toHaveBeenCalledTimes(1);
      expect(buildLedgersRequest).toHaveBeenCalledWith('ABC Ltd', '20260401', '20260430', {
        from: 2,
        to: 3,
      });
      expect(result).toEqual([
        expect.objectContaining({
          name: 'Profit & Loss A/c',
          reservedName: 'Profit & Loss A/c',
          openingBalance: null,
          closingBalance: null,
        }),
        expect.objectContaining({ name: 'A', reservedName: null }),
        expect.objectContaining({ name: 'B', reservedName: null }),
      ]);
    });

    it('does not exclude reserved ledgers from the all-time (non-period-scoped) path — only period-scoped requests are affected', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [
            entry('Profit & Loss A/c', 1, 'Profit & Loss A/c'),
            entry('A', 2),
          ]),
        ) // names+AlterID pass
        .mockResolvedValueOnce(
          collectionXml('LEDGER', [
            entry('Profit & Loss A/c', 1, 'Profit & Loss A/c'),
            entry('A', 2),
          ]),
        ); // plain unfiltered fetch — reserved ledger included, same as any other
      const { service, buildLedgersRequest } = makeService({ connectorPost });

      const result = await service.getLedgers('ABC Ltd'); // no fromDate/toDate

      expect(buildLedgersRequest).toHaveBeenCalledTimes(1);
      expect(buildLedgersRequest).toHaveBeenCalledWith('ABC Ltd', undefined, undefined);
      expect(result.map((l) => l.name)).toEqual(['Profit & Loss A/c', 'A']);
    });
  });

  describe('batching a large stock item collection', () => {
    it('stays a single request when the collection fits within masterBatchSize (no behavior change)', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(collectionXml('STOCKITEM', [entry('A', 1), entry('B', 2)]))
        .mockResolvedValueOnce(collectionXml('STOCKITEM', [entry('A', 1), entry('B', 2)]));
      const { service, buildStockItemsRequest, buildStockItemNamesRequest } = makeService({
        connectorPost,
        masterBatchSize: 5,
      });

      const result = await service.getStockItems('ABC Ltd');

      expect(buildStockItemNamesRequest).toHaveBeenCalledWith('ABC Ltd');
      expect(buildStockItemsRequest).toHaveBeenCalledTimes(1);
      expect(result.map((s) => s.name)).toEqual(['A', 'B']);
    });

    it('splits a collection larger than masterBatchSize into AlterID-range batches and concatenates the results', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('STOCKITEM', [entry('C', 30), entry('A', 10), entry('B', 20)]),
        )
        .mockResolvedValueOnce(collectionXml('STOCKITEM', [entry('A', 10), entry('B', 20)]))
        .mockResolvedValueOnce(collectionXml('STOCKITEM', [entry('C', 30)]));
      const { service, buildStockItemsRequest } = makeService({
        connectorPost,
        masterBatchSize: 2,
      });

      const result = await service.getStockItems('ABC Ltd');

      expect(buildStockItemsRequest).toHaveBeenCalledTimes(2);
      expect(buildStockItemsRequest).toHaveBeenNthCalledWith(1, 'ABC Ltd', undefined, undefined, {
        from: 10,
        to: 20,
      });
      expect(buildStockItemsRequest).toHaveBeenNthCalledWith(2, 'ABC Ltd', undefined, undefined, {
        from: 30,
        to: 30,
      });
      expect(result.map((s) => s.name)).toEqual(['A', 'B', 'C']);
    });

    it('throws instead of returning partial data when a batch drops records', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('STOCKITEM', [entry('A', 1), entry('B', 2), entry('C', 3)]),
        )
        .mockResolvedValueOnce(collectionXml('STOCKITEM', [])) // should have been A,B — both dropped
        .mockResolvedValueOnce(collectionXml('STOCKITEM', [entry('C', 3)]));
      const { service } = makeService({ connectorPost, masterBatchSize: 2 });

      await expect(service.getStockItems('ABC Ltd')).rejects.toThrow(/expected 3/);
    });

    it('uses periodBatchSizeStockItems instead of masterBatchSize once fromDate/toDate are supplied, even when the collection fits within masterBatchSize', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(
          collectionXml('STOCKITEM', [entry('A', 1), entry('B', 2), entry('C', 3)]),
        ) // names+AlterID pass — 3 records
        .mockResolvedValueOnce(collectionXml('STOCKITEM', [entry('A', 1), entry('B', 2)]))
        .mockResolvedValueOnce(collectionXml('STOCKITEM', [entry('C', 3)]));
      const { service, buildStockItemsRequest } = makeService({
        connectorPost,
        masterBatchSize: 1000, // would NOT batch a 3-record collection on its own
        periodBatchSize: 1000, // must NOT be what governs this — periodBatchSizeStockItems is separate
        periodBatchSizeStockItems: 2, // but period-scoped requests must still batch at this size
        stockItemsPeriodScopingEnabled: true, // off by default in production — see that test above
      });

      const result = await service.getStockItems('ABC Ltd', '20260401', '20260430');

      expect(buildStockItemsRequest).toHaveBeenCalledTimes(2);
      expect(buildStockItemsRequest).toHaveBeenNthCalledWith(1, 'ABC Ltd', '20260401', '20260430', {
        from: 1,
        to: 2,
      });
      expect(buildStockItemsRequest).toHaveBeenNthCalledWith(2, 'ABC Ltd', '20260401', '20260430', {
        from: 3,
        to: 3,
      });
      expect(result.map((s) => s.name)).toEqual(['A', 'B', 'C']);
    });
  });
});
