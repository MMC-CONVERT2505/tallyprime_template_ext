import { dispatchExtraction } from './extraction-dispatch';

describe('dispatchExtraction', () => {
  function makeServices() {
    return {
      masters: {
        getCompanies: jest.fn().mockResolvedValue(['companies']),
        getLedgers: jest.fn().mockResolvedValue(['ledgers']),
        getStockItems: jest.fn().mockResolvedValue(['stockItems']),
        getGroups: jest.fn().mockResolvedValue(['groups']),
      },
      transactions: {
        getVouchers: jest.fn().mockResolvedValue(['vouchers']),
      },
      diagnostics: {
        probe: jest.fn().mockResolvedValue({ reachable: true }),
        getRaw: jest.fn().mockResolvedValue({ rawXml: '<ENVELOPE/>' }),
      },
    };
  }

  it('routes "probe" to diagnostics.probe with no payload', async () => {
    const services = makeServices();
    await dispatchExtraction('probe', {}, services as any);
    expect(services.diagnostics.probe).toHaveBeenCalledWith();
  });

  it('routes "companies", translating fresh !== true to the useCache flag', async () => {
    const services = makeServices();

    await dispatchExtraction('companies', {}, services as any);
    expect(services.masters.getCompanies).toHaveBeenCalledWith(true); // no fresh -> cache

    await dispatchExtraction('companies', { fresh: true }, services as any);
    expect(services.masters.getCompanies).toHaveBeenCalledWith(false);
  });

  it('routes "ledgers" with company/fromDate/toDate pulled off the payload', async () => {
    const services = makeServices();
    await dispatchExtraction(
      'ledgers',
      { company: 'ABC Ltd', fromDate: '20260401', toDate: '20260430' },
      services as any,
    );
    expect(services.masters.getLedgers).toHaveBeenCalledWith('ABC Ltd', '20260401', '20260430');
  });

  it('routes "stockItems" with company/fromDate/toDate pulled off the payload', async () => {
    const services = makeServices();
    await dispatchExtraction(
      'stockItems',
      { company: 'ABC Ltd', fromDate: '20260401', toDate: '20260430' },
      services as any,
    );
    expect(services.masters.getStockItems).toHaveBeenCalledWith('ABC Ltd', '20260401', '20260430');
  });

  it('routes "groups" with company pulled off the payload', async () => {
    const services = makeServices();
    await dispatchExtraction('groups', { company: 'ABC Ltd' }, services as any);
    expect(services.masters.getGroups).toHaveBeenCalledWith('ABC Ltd');
  });

  it('routes "vouchers" with the whole payload as the DTO', async () => {
    const services = makeServices();
    const payload = { company: 'ABC Ltd', from: '20260401', to: '20260430', voucherType: 'Sales' };
    await dispatchExtraction('vouchers', payload, services as any);
    expect(services.transactions.getVouchers).toHaveBeenCalledWith(payload);
  });

  it('routes "raw" with the whole payload as the DTO', async () => {
    const services = makeServices();
    const payload = { reportName: 'Trial Balance', company: 'ABC Ltd' };
    await dispatchExtraction('raw', payload, services as any);
    expect(services.diagnostics.getRaw).toHaveBeenCalledWith(payload);
  });

  it('resolves with whatever the underlying service call resolves with', async () => {
    const services = makeServices();
    await expect(dispatchExtraction('companies', {}, services as any)).resolves.toEqual(['companies']);
  });

  it('propagates a rejection from the underlying service call', async () => {
    const services = makeServices();
    services.masters.getGroups.mockRejectedValue(new Error('Tally unreachable'));
    await expect(dispatchExtraction('groups', {}, services as any)).rejects.toThrow('Tally unreachable');
  });
});
