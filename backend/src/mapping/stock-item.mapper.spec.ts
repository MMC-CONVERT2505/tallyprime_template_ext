import { StockItemMapper } from './stock-item.mapper';

describe('StockItemMapper', () => {
  const mapper = new StockItemMapper();

  it('maps the currently-available fields and derives a per-unit rate from value/quantity', () => {
    const [row] = mapper.toItemRows([
      {
        name: 'Widget A',
        parent: 'Finished Goods',
        description: 'A widget',
        baseUnit: 'Nos',
        openingBalance: 100,
        openingValue: 5000,
        closingBalance: 80,
        closingValue: 4000,
        alterId: 1,
      },
    ]);

    expect(row).toEqual({
      'Item Name': 'Widget A',
      Description: 'A widget',
      'Usage unit': 'Nos',
      'Stock Group': 'Finished Goods',
      'Initial Stock': 100,
      'Initial Stock Rate': 50,
    });
  });

  it('leaves Initial Stock Rate blank rather than dividing by zero when opening quantity is 0', () => {
    const [row] = mapper.toItemRows([
      {
        name: 'New Item',
        parent: null,
        description: null,
        baseUnit: 'Nos',
        openingBalance: 0,
        openingValue: 0,
        closingBalance: 0,
        closingValue: 0,
        alterId: 1,
      },
    ]);
    expect(row['Initial Stock Rate']).toBe('');
  });

  it('leaves fields blank rather than throwing when everything is null (a brand-new item)', () => {
    const [row] = mapper.toItemRows([
      {
        name: 'Brand New Item',
        parent: null,
        description: null,
        baseUnit: null,
        openingBalance: null,
        openingValue: null,
        closingBalance: null,
        closingValue: null,
        alterId: null,
      },
    ]);
    expect(row).toEqual({
      'Item Name': 'Brand New Item',
      Description: '',
      'Usage unit': '',
      'Stock Group': '',
      'Initial Stock': '',
      'Initial Stock Rate': '',
    });
  });
});
