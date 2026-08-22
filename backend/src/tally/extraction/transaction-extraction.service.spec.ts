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
      jobs?: { create: jest.Mock; save: jest.Mock; update: jest.Mock };
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
      overrides.jobs as any,
      undefined,
    );
    return { service, buildVouchersRequest, connector };
  }

  /** Bare-minimum ExtractionJobRepository double — see the analogous helper
   *  in master-extraction.service.spec.ts for why each method is shaped this way. */
  function makeJobsRepo() {
    return {
      create: jest.fn((data: unknown) => data),
      save: jest.fn(async (data: unknown) => ({ id: 'job-1', ...(data as object) })),
      update: jest.fn().mockResolvedValue({}),
    };
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

  describe('filtering by voucher type', () => {
    // Regression test for a live incident (2026-08-22): a bulk export
    // requested Sales/Purchase/Credit Note/Stock Journal vouchers as 4
    // separate calls, and all 4 came back with the exact same single
    // Journal-type voucher — Tally's Day Book export ignores the
    // VOUCHERTYPENAME static variable entirely. filterByVoucherType is the
    // fix: it discards anything Tally returns that doesn't actually match
    // the requested type, regardless of whether the request-side hint worked.
    function mixedTypesXml(): string {
      return (
        '<ENVELOPE><BODY><DATA>' +
        '<TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>20260401</DATE>' +
        '<VOUCHERNUMBER>J-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>' +
        '<TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20260401</DATE>' +
        '<VOUCHERNUMBER>S-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>' +
        '</DATA></BODY></ENVELOPE>'
      );
    }

    it('discards a voucher type Tally returns anyway, even though the request asked to filter it out', async () => {
      const { service } = makeService({
        connectorPost: jest.fn().mockResolvedValue(mixedTypesXml()),
      });

      const result = await service.getVouchers({
        company: 'ABC Ltd',
        from: '20260401',
        to: '20260430',
        voucherType: 'Sales',
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ voucherNumber: 'S-1', voucherType: 'Sales' });
    });

    it('is case/whitespace-insensitive when matching the requested type', async () => {
      const { service } = makeService({
        connectorPost: jest.fn().mockResolvedValue(mixedTypesXml()),
      });

      const result = await service.getVouchers({
        company: 'ABC Ltd',
        from: '20260401',
        to: '20260430',
        voucherType: '  sales  ',
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ voucherNumber: 'S-1' });
    });

    it('passes everything through unfiltered when no voucherType was requested', async () => {
      const { service } = makeService({
        connectorPost: jest.fn().mockResolvedValue(mixedTypesXml()),
      });

      const result = await service.getVouchers({
        company: 'ABC Ltd',
        from: '20260401',
        to: '20260430',
      });

      expect(result).toHaveLength(2);
    });

    it('also filters the chunked path, after dedup', async () => {
      const { service } = makeService({
        connectorPost: jest.fn().mockResolvedValue(mixedTypesXml()),
        voucherChunkDays: 7,
      });

      const result = await service.getVouchers({
        company: 'ABC Ltd',
        from: '20260401',
        to: '20260415', // 3 chunks
        voucherType: 'Sales',
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ voucherNumber: 'S-1' });
    });
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
      // No retries/signal override on the single-request path — same as before chunking existed
      // (signal is passed through, but undefined when the caller doesn't supply one).
      expect(connector.post).toHaveBeenCalledWith(expect.any(String), { signal: undefined });
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

    it('dedupes a voucher that Tally leaks into every chunk response, by AlterID', async () => {
      const leakedVoucherXml =
        '<ENVELOPE><BODY><DATA><TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>20260401</DATE>' +
        '<VOUCHERNUMBER>TI2627-158</VOUCHERNUMBER><ALTERID>26137</ALTERID></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>';
      // Same voucher (same AlterID) comes back from all 3 chunks — this is
      // the real leak observed against a live TallyPrime instance.
      const connectorPost = jest.fn().mockResolvedValue(leakedVoucherXml);
      const { service } = makeService({ connectorPost, voucherChunkDays: 7 });

      const result = await service.getVouchers({
        company: 'ABC Ltd',
        from: '20260401',
        to: '20260415', // 15 days -> 3 chunks
      });

      expect(connectorPost).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ voucherNumber: 'TI2627-158', alterId: 26137 });
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
      expect(sleepSpy).toHaveBeenCalledWith(2000, undefined); // no signal passed by this call
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

    it('stops the chunk loop early when the signal is aborted between chunks', async () => {
      const controller = new AbortController();
      const connectorPost = jest.fn().mockImplementationOnce(async () => {
        controller.abort(); // abort right after chunk 1 lands, before chunk 2 starts
        return voucherXml('1');
      });
      const { service, connector } = makeService({ connectorPost, voucherChunkDays: 7 });

      await expect(
        service.getVouchers(
          { company: 'ABC Ltd', from: '20260401', to: '20260415' }, // 3 chunks
          controller.signal,
        ),
      ).rejects.toThrow('cancelled');

      expect(connector.post).toHaveBeenCalledTimes(1); // chunk 2 and 3 never started
    });

    it('passes the signal through to each chunk request', async () => {
      const controller = new AbortController();
      const connectorPost = jest.fn().mockResolvedValue(voucherXml('1'));
      const { service, connector } = makeService({ connectorPost, voucherChunkDays: 7 });

      await service.getVouchers(
        { company: 'ABC Ltd', from: '20260401', to: '20260415' },
        controller.signal,
      );

      expect(connector.post).toHaveBeenCalledWith(expect.any(String), {
        retries: 0,
        signal: controller.signal,
      });
    });

    it('reports progress once per chunk via the job repository, then clears it on completion', async () => {
      const connectorPost = jest.fn().mockResolvedValue(voucherXml('1'));
      const jobs = makeJobsRepo();
      const { service } = makeService({ connectorPost, voucherChunkDays: 7, jobs });

      await service.getVouchers({ company: 'ABC Ltd', from: '20260401', to: '20260415' }); // 3 chunks

      // 3 in-progress updates (one per chunk) + 1 final update from finishJob.
      expect(jobs.update).toHaveBeenCalledTimes(4);
      expect(jobs.update.mock.calls[0]).toEqual([
        'job-1',
        { progress: expect.stringContaining('chunk 1/3') },
      ]);
      expect(jobs.update.mock.calls[3]).toEqual([
        'job-1',
        expect.objectContaining({ progress: null, status: 'SUCCESS' }),
      ]);
    });
  });
});
