import { BadRequestException } from '@nestjs/common';
import { EnvelopeBuilder } from '../xml/envelope.builder';
import { TallyResponseParser } from '../xml/response.parser';
import { MasterExtractionService } from './master-extraction.service';

describe('MasterExtractionService', () => {
  function makeService(overrides: { connectorPost?: jest.Mock; defaultCompany?: string } = {}) {
    const builder = new EnvelopeBuilder();
    const buildLedgersRequest = jest.spyOn(builder, 'buildLedgersRequest');
    const buildStockItemsRequest = jest.spyOn(builder, 'buildStockItemsRequest');

    const connector = {
      post: overrides.connectorPost ?? jest.fn().mockResolvedValue('<ENVELOPE></ENVELOPE>'),
    };
    const parser = new TallyResponseParser();
    const config = { getOrThrow: () => ({ defaultCompany: overrides.defaultCompany ?? '' }) };

    const service = new MasterExtractionService(
      builder,
      connector as any,
      parser,
      config as any,
      undefined,
      undefined,
    );
    return { service, buildLedgersRequest, buildStockItemsRequest, connector };
  }

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
});
