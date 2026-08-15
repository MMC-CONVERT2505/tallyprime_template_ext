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
      chunkDelayMs?: number;
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
      undefined,
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

  /**
   * Names-only or full-field collection response, matching whichever tag the
   * parser expects for that type. Always includes AlterID — batching keys
   * off it, not the name (see MasterExtractionService's doc comment on why).
   */
  function collectionXml(
    tag: 'LEDGER' | 'STOCKITEM',
    entries: Array<{ name: string; alterId: number }>,
  ): string {
    const items = entries
      .map((e) => `<${tag}><NAME>${e.name}</NAME><ALTERID>${e.alterId}</ALTERID></${tag}>`)
      .join('');
    return `<ENVELOPE><BODY><DATA><COLLECTION>${items}</COLLECTION></DATA></BODY></ENVELOPE>`;
  }

  const entry = (name: string, alterId: number) => ({ name, alterId });

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
    it('passes fromDate/toDate through to buildStockItemsRequest when both are supplied', async () => {
      const { service, buildStockItemsRequest } = makeService();

      await service.getStockItems('ABC Ltd', '20260401', '20260430');

      expect(buildStockItemsRequest).toHaveBeenCalledWith('ABC Ltd', '20260401', '20260430');
    });

    it('rejects a fromDate after toDate, before ever calling the connector', async () => {
      const { service, connector } = makeService();

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
          collectionXml('LEDGER', [entry('E', 50), entry('C', 30), entry('A', 10), entry('D', 40), entry('B', 20)]),
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
          collectionXml('LEDGER', [entry('A', 1), entry('B', 2), entry('C', 3), entry('D', 4), entry('E', 5)]),
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
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 1), entry('B', 2), entry('C', 3)]))
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 1)]))
        .mockRejectedValueOnce(new Error('Tally unreachable'));
      const { service } = makeService({ connectorPost, masterBatchSize: 1 });

      await expect(service.getLedgers('ABC Ltd')).rejects.toThrow('Tally unreachable');
    });

    it('pauses chunkDelayMs between batches, but not after the final one', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(collectionXml('LEDGER', [entry('A', 1), entry('B', 2), entry('C', 3)]))
        .mockResolvedValue(collectionXml('LEDGER', [entry('A', 1)]));
      const { service } = makeService({ connectorPost, masterBatchSize: 1, chunkDelayMs: 2000 });
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      await service.getLedgers('ABC Ltd');

      expect(sleepSpy).toHaveBeenCalledTimes(2); // between batch 1->2 and 2->3 only
      expect(sleepSpy).toHaveBeenCalledWith(2000);
    });

    it('does not sleep at all on the single-request (unbatched) path', async () => {
      const connectorPost = jest.fn().mockResolvedValue(collectionXml('LEDGER', [entry('A', 1)]));
      const { service } = makeService({ connectorPost, masterBatchSize: 5, chunkDelayMs: 2000 });
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      await service.getLedgers('ABC Ltd');

      expect(sleepSpy).not.toHaveBeenCalled();
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
      const { service, buildStockItemsRequest } = makeService({ connectorPost, masterBatchSize: 2 });

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
  });
});
