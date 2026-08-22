import { TallyStockItem } from '../tally/interfaces/tally.interfaces';
import { StockItemMapper } from './stock-item.mapper';

describe('StockItemMapper', () => {
  const mapper = new StockItemMapper();

  const item = (overrides: Partial<TallyStockItem>): TallyStockItem => ({
    name: 'Unnamed',
    parent: null,
    description: null,
    baseUnit: null,
    openingBalance: null,
    openingValue: null,
    closingBalance: null,
    closingValue: null,
    alterId: 1,
    alias: null,
    hsnCode: null,
    gstRate: null,
    ...overrides,
  });

  it('maps the currently-available fields onto the real Item.xlsx columns', () => {
    const [row] = mapper.toItemRows([
      item({
        name: 'Widget A',
        description: 'A widget',
        baseUnit: 'Nos',
        openingBalance: 100,
        openingValue: 5000,
        closingBalance: 80,
      }),
    ]);

    expect(row).toEqual({
      'Item Name': 'Widget A',
      'Alias Name': '',
      Description: 'A widget',
      'HSN/SAC': '',
      'Usage unit': 'Nos',
      'Opening Stock': 100,
      'Opening Stock Value': 5000,
      'Stock On Hand': 80,
      'Item Type': 'goods',
      Status: 'Active',
      'Intra State Tax Name': '',
      'Intra State Tax Rate': '',
      'Intra State Tax Type': '',
      'Inter State Tax Name': '',
      'Inter State Tax Rate': '',
      'Inter State Tax Type': '',
    });
  });

  it('maps closingBalance to Stock On Hand — a gap-fill regression test: this field was already fetched from Tally but never written to the template', () => {
    const [row] = mapper.toItemRows([item({ name: 'Widget B', closingBalance: 42 })]);
    expect(row['Stock On Hand']).toBe(42);
  });

  it('leaves fields blank rather than throwing when everything is null (a brand-new item)', () => {
    const [row] = mapper.toItemRows([item({ name: 'Brand New Item' })]);
    expect(row).toEqual({
      'Item Name': 'Brand New Item',
      'Alias Name': '',
      Description: '',
      'HSN/SAC': '',
      'Usage unit': '',
      'Opening Stock': '',
      'Opening Stock Value': '',
      'Stock On Hand': '',
      'Item Type': 'goods',
      Status: 'Active',
      'Intra State Tax Name': '',
      'Intra State Tax Rate': '',
      'Intra State Tax Type': '',
      'Inter State Tax Name': '',
      'Inter State Tax Rate': '',
      'Inter State Tax Type': '',
    });
  });

  it('always classifies a Stock Item as "goods" — Tally services live on ledgers, not stock items', () => {
    const [row] = mapper.toItemRows([item({ name: 'Anything' })]);
    expect(row['Item Type']).toBe('goods');
  });

  it('derives both Intra and Inter State tax name/rate/type from a single GST rate, matching the real template convention', () => {
    const [row] = mapper.toItemRows([
      item({ name: 'Harpic', alias: 'HRP-1', hsnCode: '34022090', gstRate: 12 }),
    ]);
    expect(row['Alias Name']).toBe('HRP-1');
    expect(row['HSN/SAC']).toBe('34022090');
    expect(row['Intra State Tax Name']).toBe('GST12');
    expect(row['Intra State Tax Rate']).toBe(12);
    expect(row['Intra State Tax Type']).toBe('Group');
    expect(row['Inter State Tax Name']).toBe('IGST12');
    expect(row['Inter State Tax Rate']).toBe(12);
    expect(row['Inter State Tax Type']).toBe('Group');
  });
});
