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
      resolveDateRange?: jest.Mock;
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
    // Stands in for MasterExtractionService.resolveDateRange — every
    // existing test below already passes explicit from/to, so this default
    // just mirrors the real short-circuit (both given -> returned unchanged)
    // without needing its own describe block to override it.
    const masters = {
      resolveDateRange:
        overrides.resolveDateRange ??
        jest.fn(async (_company: string, from?: string, to?: string) => ({
          from: from ?? '20000101',
          to: to ?? '20261231',
        })),
    };

    const service = new TransactionExtractionService(
      masters as any,
      builder,
      connector as any,
      parser,
      config as any,
      overrides.jobs as any,
      undefined,
    );
    return { service, buildVouchersRequest, connector, masters };
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

  describe('auto-resolving an omitted date range', () => {
    it('resolves the company before asking MasterExtractionService for the range', async () => {
      const resolveDateRange = jest.fn().mockResolvedValue({ from: '20200401', to: '20261016' });
      const { service, masters } = makeService({ resolveDateRange });

      await service.getVouchers({ company: 'ABC Ltd' });

      expect(resolveDateRange).toHaveBeenCalledWith('ABC Ltd', undefined, undefined);
      expect(masters.resolveDateRange).toHaveBeenCalledTimes(1);
    });

    it('builds the Tally request with the RESOLVED range, not the (missing) dto dates', async () => {
      const resolveDateRange = jest.fn().mockResolvedValue({ from: '20200401', to: '20261016' });
      const { service, buildVouchersRequest } = makeService({ resolveDateRange });

      await service.getVouchers({ company: 'ABC Ltd', voucherType: 'Sales' });

      expect(buildVouchersRequest).toHaveBeenCalledWith('ABC Ltd', '20200401', '20261016', 'Sales');
    });

    it('still calls through to resolveDateRange when only one of from/to is given, letting it fill in the other', async () => {
      const resolveDateRange = jest.fn().mockResolvedValue({ from: '20260401', to: '20261016' });
      const { service, buildVouchersRequest } = makeService({ resolveDateRange });

      await service.getVouchers({ company: 'ABC Ltd', from: '20260401' });

      expect(resolveDateRange).toHaveBeenCalledWith('ABC Ltd', '20260401', undefined);
      expect(buildVouchersRequest).toHaveBeenCalledWith('ABC Ltd', '20260401', '20261016', undefined);
    });

    it('never reaches the connector when the resolved range is still invalid (from after to)', async () => {
      const resolveDateRange = jest.fn().mockResolvedValue({ from: '20261016', to: '20260401' });
      const { service, connector } = makeService({ resolveDateRange });

      await expect(service.getVouchers({ company: 'ABC Ltd' })).rejects.toThrow(BadRequestException);
      expect(connector.post).not.toHaveBeenCalled();
    });

    it('does NOT call resolveDateRange a second time per chunk — resolved once, reused for every chunk', async () => {
      const resolveDateRange = jest.fn().mockResolvedValue({ from: '20260401', to: '20260415' });
      const connectorPost = jest
        .fn()
        .mockRejectedValueOnce(new Error('whole-range unavailable'))
        .mockResolvedValue('<ENVELOPE></ENVELOPE>');
      const { service } = makeService({ resolveDateRange, connectorPost, voucherChunkDays: 7 });

      await service.getVouchers({ company: 'ABC Ltd' }); // 15-day range -> 3 chunks

      expect(resolveDateRange).toHaveBeenCalledTimes(1);
    });
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
      const connectorPost = jest
        .fn()
        // First call is the whole-range pre-check — forced to fail so this
        // genuinely exercises the chunked fallback path, not the shortcut.
        .mockRejectedValueOnce(new Error('whole-range unavailable'))
        .mockResolvedValue(mixedTypesXml());
      const { service } = makeService({ connectorPost, voucherChunkDays: 7 });

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

  describe('whole-range fetch before committing to chunking', () => {
    // Regression coverage for a live incident (2026-08-24): a bulk export
    // against a company with effectively zero vouchers of the requested type
    // still paid the full chunked cost — 300+ sequential requests across a
    // 6+ year range, each paced by chunkDelayMs — purely to discover there
    // was nothing to find. A single unrestricted request answers just as
    // correctly (and, for a sparse company, dramatically faster) — see
    // tryWholeRangeFetch's doc comment.
    function voucherXml(voucherNumber: string): string {
      return (
        '<ENVELOPE><BODY><DATA><TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20260401</DATE>' +
        `<VOUCHERNUMBER>${voucherNumber}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
      );
    }

    it('answers directly from one whole-range request and never chunks at all when Tally can serve it fast', async () => {
      const connectorPost = jest.fn().mockResolvedValue(voucherXml('1'));
      const { service, buildVouchersRequest, connector } = makeService({
        connectorPost,
        voucherChunkDays: 7,
      });

      const result = await service.getVouchers({
        company: 'ABC Ltd',
        from: '20200101',
        to: '20260822', // wide range -> would be hundreds of chunks
        voucherType: 'Sales',
      });

      expect(connector.post).toHaveBeenCalledTimes(1);
      expect(buildVouchersRequest).toHaveBeenCalledTimes(1);
      // The ORIGINAL full range, not a chunk-scoped sub-range.
      expect(buildVouchersRequest).toHaveBeenCalledWith('ABC Ltd', '20200101', '20260822', 'Sales');
      expect(connector.post).toHaveBeenCalledWith(expect.any(String), {
        retries: 0,
        signal: undefined,
      });
      expect(result).toHaveLength(1);
    });

    it('correctly reports zero records from a successful whole-range fetch, not confused with a failure', async () => {
      const connectorPost = jest.fn().mockResolvedValue('<ENVELOPE></ENVELOPE>');
      const { service, connector } = makeService({ connectorPost, voucherChunkDays: 7 });

      const result = await service.getVouchers({
        company: 'ABC Ltd',
        from: '20200101',
        to: '20260822',
        voucherType: 'Sales',
      });

      expect(result).toEqual([]);
      // Confirms it did NOT fall back to chunking after a genuine zero-record answer.
      expect(connector.post).toHaveBeenCalledTimes(1);
    });

    it('applies dedup and the voucher-type filter to the whole-range result too', async () => {
      const mixedXml =
        '<ENVELOPE><BODY><DATA>' +
        '<TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>20260401</DATE>' +
        '<VOUCHERNUMBER>J-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>' +
        '<TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20260401</DATE>' +
        '<VOUCHERNUMBER>S-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>' +
        '</DATA></BODY></ENVELOPE>';
      const { service } = makeService({
        connectorPost: jest.fn().mockResolvedValue(mixedXml),
        voucherChunkDays: 7,
      });

      const result = await service.getVouchers({
        company: 'ABC Ltd',
        from: '20200101',
        to: '20260822',
        voucherType: 'Sales',
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ voucherNumber: 'S-1' });
    });

    it('falls back to the full chunked loop when the whole-range request fails', async () => {
      const connectorPost = jest
        .fn()
        .mockRejectedValueOnce(new Error('Tally did not respond within 60000ms.'))
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
        to: '20260415', // 15 days -> 3 chunks
        voucherType: 'Sales',
      });

      expect(connector.post).toHaveBeenCalledTimes(4); // 1 whole-range + 3 chunks
      expect(buildVouchersRequest).toHaveBeenNthCalledWith(
        1,
        'ABC Ltd',
        '20260401',
        '20260415',
        'Sales',
      );
      expect(buildVouchersRequest).toHaveBeenNthCalledWith(
        2,
        'ABC Ltd',
        '20260401',
        '20260407',
        'Sales',
      );
      expect(result.map((v) => v.voucherNumber)).toEqual(['1', '2', '3']);
    });

    it('does not attempt a whole-range request at all when the range already fits in one chunk', async () => {
      const { service, buildVouchersRequest, connector } = makeService({ voucherChunkDays: 7 });

      await service.getVouchers({ company: 'ABC Ltd', from: '20260401', to: '20260407' });

      expect(connector.post).toHaveBeenCalledTimes(1);
      expect(buildVouchersRequest).toHaveBeenCalledTimes(1);
    });

    it('propagates a genuine cancellation from the whole-range attempt instead of falling back to chunking', async () => {
      const controller = new AbortController();
      controller.abort();
      const connectorPost = jest.fn().mockRejectedValue(new Error('aborted'));
      const { service, connector } = makeService({ connectorPost, voucherChunkDays: 7 });

      await expect(
        service.getVouchers(
          { company: 'ABC Ltd', from: '20260401', to: '20260415' },
          controller.signal,
        ),
      ).rejects.toThrow();

      // Never silently retried as if it were an ordinary failure.
      expect(connector.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('chunking a wide date range', () => {
    function voucherXml(voucherNumber: string): string {
      return (
        '<ENVELOPE><BODY><DATA><TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20260401</DATE>' +
        `<VOUCHERNUMBER>${voucherNumber}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
      );
    }

    /** Every test below exercises the fallback (chunked) path specifically —
     *  prepend a failed whole-range attempt so the new pre-check (see
     *  'whole-range fetch before committing to chunking' above) doesn't
     *  short-circuit before the chunking behavior under test ever runs. */
    function wholeRangeUnavailable() {
      return jest.fn().mockRejectedValueOnce(new Error('whole-range unavailable'));
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

    it('dedupes a voucher that Tally leaks into every chunk response, by AlterID', async () => {
      const leakedVoucherXml =
        '<ENVELOPE><BODY><DATA><TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>20260401</DATE>' +
        '<VOUCHERNUMBER>TI2627-158</VOUCHERNUMBER><ALTERID>26137</ALTERID></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>';
      // Same voucher (same AlterID) comes back from all 3 chunks — this is
      // the real leak observed against a live TallyPrime instance.
      const connectorPost = wholeRangeUnavailable().mockResolvedValue(leakedVoucherXml);
      const { service } = makeService({ connectorPost, voucherChunkDays: 7 });

      const result = await service.getVouchers({
        company: 'ABC Ltd',
        from: '20260401',
        to: '20260415', // 15 days -> 3 chunks
      });

      expect(connectorPost).toHaveBeenCalledTimes(4); // 1 whole-range (failed) + 3 chunks
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ voucherNumber: 'TI2627-158', alterId: 26137 });
    });

    it('propagates a single chunk failure rather than returning partial data', async () => {
      const connectorPost = wholeRangeUnavailable()
        .mockResolvedValueOnce(voucherXml('1'))
        .mockRejectedValueOnce(new Error('Tally unreachable'));
      const { service } = makeService({ connectorPost, voucherChunkDays: 7 });

      await expect(
        service.getVouchers({ company: 'ABC Ltd', from: '20260401', to: '20260415' }),
      ).rejects.toThrow('Tally unreachable');
    });

    it('pauses chunkDelayMs between chunks, but not after the final one', async () => {
      const connectorPost = wholeRangeUnavailable().mockResolvedValue(voucherXml('1'));
      const { service } = makeService({ connectorPost, voucherChunkDays: 7, chunkDelayMs: 2000 });
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      // 20260401-20260415 -> 3 chunks of <=7 days each.
      await service.getVouchers({ company: 'ABC Ltd', from: '20260401', to: '20260415' });

      expect(sleepSpy).toHaveBeenCalledTimes(2); // between chunk 1->2 and 2->3 only
      expect(sleepSpy).toHaveBeenCalledWith(2000, undefined); // no signal passed by this call
    });

    it('does not sleep at all when chunkDelayMs is 0', async () => {
      const connectorPost = wholeRangeUnavailable().mockResolvedValue(voucherXml('1'));
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
      const connectorPost = wholeRangeUnavailable().mockImplementationOnce(async () => {
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

      expect(connector.post).toHaveBeenCalledTimes(2); // 1 whole-range (failed) + chunk 1; chunk 2/3 never started
    });

    it('passes the signal through to each chunk request', async () => {
      const controller = new AbortController();
      const connectorPost = wholeRangeUnavailable().mockResolvedValue(voucherXml('1'));
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
      const connectorPost = wholeRangeUnavailable().mockResolvedValue(voucherXml('1'));
      const jobs = makeJobsRepo();
      const { service } = makeService({ connectorPost, voucherChunkDays: 7, jobs });

      await service.getVouchers({ company: 'ABC Ltd', from: '20260401', to: '20260415' }); // 3 chunks

      // 3 in-progress updates (one per chunk) + 1 final update from finishJob.
      // The failed whole-range attempt reports nothing (it only logs, since
      // the caller can't tell yet whether chunking will even happen).
      expect(jobs.update).toHaveBeenCalledTimes(4);
      expect(jobs.update.mock.calls[0]).toEqual([
        'job-1',
        { progress: expect.stringContaining('chunk 1/3'), recordsSoFar: expect.any(Number) },
      ]);
      expect(jobs.update.mock.calls[3]).toEqual([
        'job-1',
        expect.objectContaining({ progress: null, recordsSoFar: null, status: 'SUCCESS' }),
      ]);
    });
  });
});
