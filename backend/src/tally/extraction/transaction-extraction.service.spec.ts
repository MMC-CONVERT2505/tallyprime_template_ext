import { BadRequestException } from '@nestjs/common';
import { EnvelopeBuilder } from '../xml/envelope.builder';
import { TallyResponseParser } from '../xml/response.parser';
import { TransactionExtractionService } from './transaction-extraction.service';

describe('TransactionExtractionService', () => {
  function makeService(overrides: { connectorPost?: jest.Mock } = {}) {
    const builder = new EnvelopeBuilder();
    const buildVouchersRequest = jest.spyOn(builder, 'buildVouchersRequest');
    const connector = {
      post: overrides.connectorPost ?? jest.fn().mockResolvedValue('<ENVELOPE></ENVELOPE>'),
    };
    const parser = new TallyResponseParser();
    const config = { getOrThrow: () => ({ defaultCompany: '' }) };

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
});
