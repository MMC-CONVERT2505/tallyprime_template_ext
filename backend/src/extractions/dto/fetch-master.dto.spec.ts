import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FetchMasterDto } from './fetch-master.dto';

describe('FetchMasterDto', () => {
  it('converts ISO 8601 dates to Tally YYYYMMDD and passes validation', async () => {
    const dto = plainToInstance(FetchMasterDto, {
      companyName: 'ABC Ltd',
      masterType: 'LEDGERS',
      fromDate: '2026-04-01',
      toDate: '2026-04-30',
    });

    expect(dto.fromDate).toBe('20260401');
    expect(dto.toDate).toBe('20260430');
    expect(await validate(dto)).toHaveLength(0);
  });

  it('trims companyName', async () => {
    const dto = plainToInstance(FetchMasterDto, {
      companyName: '  ABC Ltd  ',
      masterType: 'GROUPS',
    });
    expect(dto.companyName).toBe('ABC Ltd');
    expect(await validate(dto)).toHaveLength(0);
  });

  it('is valid with no dates supplied (masters without period scoping, e.g. GROUPS)', async () => {
    const dto = plainToInstance(FetchMasterDto, { companyName: 'ABC Ltd', masterType: 'GROUPS' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a malformed date', async () => {
    const dto = plainToInstance(FetchMasterDto, {
      companyName: 'ABC Ltd',
      masterType: 'LEDGERS',
      fromDate: 'not-a-date',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'fromDate')).toBe(true);
  });

  it('rejects a masterType outside the master set (e.g. VOUCHERS, a transaction not a master)', async () => {
    const dto = plainToInstance(FetchMasterDto, { companyName: 'ABC Ltd', masterType: 'VOUCHERS' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'masterType')).toBe(true);
  });

  it('rejects a missing companyName', async () => {
    const dto = plainToInstance(FetchMasterDto, { masterType: 'LEDGERS' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'companyName')).toBe(true);
  });
});
