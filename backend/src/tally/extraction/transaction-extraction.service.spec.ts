import { BadRequestException } from '@nestjs/common';
import { EnvelopeBuilder } from '../xml/envelope.builder';
import { TallyResponseParser } from '../xml/response.parser';
import { TransactionExtractionService } from './transaction-extraction.service';

describe('TransactionExtractionService', () => {
  // Large enough that no existing test's date range accidentally triggers
  // chunking — chunking behavior itself is covered by its own describe block
  // below with an explicit small override.
  const NO_CHUNKING = 90;

  function makeService(
    overrides: {
      connectorPost?: jest.Mock;
      voucherChunkDays?: number;
      chunkDelayMs?: number;
    } = {},
  ) {
    const builder = new EnvelopeBuilder();
    const buildVouchersRequest = jest.spyOn(builder, 'buildVouchersRequest');
    const connector = {
      post: overrides.connectorPost ?? jest.fn().mockResolvedValue('<ENVELOPE></ENVELOPE>'),
    };
    const parser = new TallyResponseParser();
    const config = {
      getOrThrow: () => ({
        defaultCompany: '',
        voucherChunkDays: overrides.voucherChunkDays ?? NO_CHUNKING,
        // 0 by default — tests should never actually wait on this; the
        // dedicated tests below override it and stub out the real timer.
        chunkDelayMs: overrides.chunkDelayMs ?? 0,
      }),
    };

    const service = new TransactionExtractionService(
      builder,
      connector as any,
      parser,
      config as any,
      undefined,
      undefined,
    );
    return { service, buildVouchersRequest, connector };
  }

  it('resolves the company, validates the date range, and builds a vouchers request', async () => {
    const { service, buildVouchersRequest } = makeService();

    await service.getVouchers({
      company: 'ABC Ltd',
      from: '20260401',
      to: '20260430',
      voucherType: 'Sales',
    });

    expect(buildVouchersRequest).toHaveBeenCalledWith('ABC Ltd', '20260401', '20260430', 'Sales');
  });

  it('rejects a from date after the to date, before ever calling the connector', async () => {
    const { service, connector } = makeService();

    await expect(
      service.getVouchers({ company: 'ABC Ltd', from: '20260430', to: '20260401' }),
    ).rejects.toThrow(BadRequestException);
    expect(connector.post).not.toHaveBeenCalled();
  });

  it('returns the mapped vouchers from a real Day Book response shape', async () => {
    const xml =
      '<ENVELOPE><BODY><DATA><TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20260401</DATE>' +
      '<VOUCHERNUMBER>1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>';
    const { service } = makeService({ connectorPost: jest.fn().mockResolvedValue(xml) });

    const result = await service.getVouchers({
      company: 'ABC Ltd',
      from: '20260401',
      to: '20260430',
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ voucherNumber: '1' });
  });

  describe('chunking a wide date range', () => {
    function voucherXml(voucherNumber: string): string {
      return (
        '<ENVELOPE><BODY><DATA><TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20260401</DATE>' +
        `<VOUCHERNUMBER>${voucherNumber}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
      );
    }

    it('stays a single request when the range fits within voucherChunkDays (no behavior change)', async () => {
      const { service, buildVouchersRequest, connector } = makeService({ voucherChunkDays: 7 });

      await service.getVouchers({ company: 'ABC Ltd', from: '20260401', to: '20260407' });

      expect(buildVouchersRequest).toHaveBeenCalledTimes(1);
      expect(buildVouchersRequest).toHaveBeenCalledWith(
        'ABC Ltd',
        '20260401',
        '20260407',
        undefined,
      );
      // No per-call opts override on the single-request path — same as before chunking existed.
      expect(connector.post).toHaveBeenCalledWith(expect.any(String));
    });

    it('splits a range wider than voucherChunkDays into multiple requests and concatenates the results', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(voucherXml('1'))
        .mockResolvedValueOnce(voucherXml('2'))
        .mockResolvedValueOnce(voucherXml('3'));
      const { service, buildVouchersRequest, connector } = makeService({
        connectorPost,
        voucherChunkDays: 7,
      });

      const result = await service.getVouchers({
        company: 'ABC Ltd',
        from: '20260401',
        to: '20260415', // 15 days -> 3 chunks of <=7 days each
        voucherType: 'Sales',
      });

      expect(buildVouchersRequest).toHaveBeenCalledTimes(3);
      expect(buildVouchersRequest).toHaveBeenNthCalledWith(
        1,
        'ABC Ltd',
        '20260401',
        '20260407',
        'Sales',
      );
      expect(buildVouchersRequest).toHaveBeenNthCalledWith(
        2,
        'ABC Ltd',
        '20260408',
        '20260414',
        'Sales',
      );
      expect(buildVouchersRequest).toHaveBeenNthCalledWith(
        3,
        'ABC Ltd',
        '20260415',
        '20260415',
        'Sales',
      );
      expect(result.map((v) => v.voucherNumber)).toEqual(['1', '2', '3']);

      // Chunked calls disable per-call retries — nested retry-of-retries
      // would multiply the worst case across every chunk.
      expect(connector.post).toHaveBeenCalledWith(expect.any(String), { retries: 0 });
    });

    it('propagates a single chunk failure rather than returning partial data', async () => {
      const connectorPost = jest
        .fn()
        .mockResolvedValueOnce(voucherXml('1'))
        .mockRejectedValueOnce(new Error('Tally unreachable'));
      const { service } = makeService({ connectorPost, voucherChunkDays: 7 });

      await expect(
        service.getVouchers({ company: 'ABC Ltd', from: '20260401', to: '20260415' }),
      ).rejects.toThrow('Tally unreachable');
    });

    it('pauses chunkDelayMs between chunks, but not after the final one', async () => {
      const connectorPost = jest.fn().mockResolvedValue(voucherXml('1'));
      const { service } = makeService({ connectorPost, voucherChunkDays: 7, chunkDelayMs: 2000 });
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      // 20260401-20260415 -> 3 chunks of <=7 days each.
      await service.getVouchers({ company: 'ABC Ltd', from: '20260401', to: '20260415' });

      expect(sleepSpy).toHaveBeenCalledTimes(2); // between chunk 1->2 and 2->3 only
      expect(sleepSpy).toHaveBeenCalledWith(2000);
    });

    it('does not sleep at all when chunkDelayMs is 0', async () => {
      const connectorPost = jest.fn().mockResolvedValue(voucherXml('1'));
      const { service } = makeService({ connectorPost, voucherChunkDays: 7, chunkDelayMs: 0 });
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      await service.getVouchers({ company: 'ABC Ltd', from: '20260401', to: '20260415' });

      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it('does not sleep at all on the single-request (unchunked) path', async () => {
      const connectorPost = jest.fn().mockResolvedValue(voucherXml('1'));
      const { service } = makeService({ connectorPost, voucherChunkDays: 7, chunkDelayMs: 2000 });
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      await service.getVouchers({ company: 'ABC Ltd', from: '20260401', to: '20260407' }); // fits in 1 chunk

      expect(sleepSpy).not.toHaveBeenCalled();
    });
  });
});
