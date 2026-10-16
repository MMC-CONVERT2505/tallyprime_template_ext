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
    gstTaxability: null,
    itcIneligible: null,
    itemType: null,
    inventoryValuationMethod: null,
    salesAccount: null,
    purchaseAccount: null,
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
      SKU: '',
      'Alias Name': '',
      Description: 'A widget',
      'HSN/SAC': '',
      Account: '',
      'Purchase Account': '',
      'Inventory Valuation Method': '',
      'Usage unit': 'Nos',
      'Opening Stock': 100,
      'Opening Stock Value': 5000,
      'Stock On Hand': 80,
      'Item Type': 'Sales and Purchases',
      'Product Type': 'goods',
      Status: 'Active',
      Sellable: true,
      Purchasable: true,
      'Track Inventory': true,
      Taxable: '',
      'Taxability Type': '',
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
      SKU: '',
      'Alias Name': '',
      Description: '',
      'HSN/SAC': '',
      Account: '',
      'Purchase Account': '',
      'Inventory Valuation Method': '',
      'Usage unit': '',
      'Opening Stock': '',
      'Opening Stock Value': '',
      'Stock On Hand': '',
      'Item Type': 'Sales and Purchases',
      'Product Type': 'goods',
      Status: 'Active',
      Sellable: true,
      Purchasable: true,
      'Track Inventory': true,
      Taxable: '',
      'Taxability Type': '',
      'Intra State Tax Name': '',
      'Intra State Tax Rate': '',
      'Intra State Tax Type': '',
      'Inter State Tax Name': '',
      'Inter State Tax Rate': '',
      'Inter State Tax Type': '',
    });
  });

  it('marks Taxable true/false from Tally taxability, distinct from a never-classified item staying blank', () => {
    const [taxable] = mapper.toItemRows([item({ name: 'A', gstTaxability: 'Taxable' })]);
    const [exempt] = mapper.toItemRows([item({ name: 'B', gstTaxability: 'Exempt' })]);
    const [unclassified] = mapper.toItemRows([item({ name: 'C' })]);
    expect(taxable.Taxable).toBe(true);
    expect(taxable['Taxability Type']).toBe('Taxable');
    expect(exempt.Taxable).toBe(false);
    expect(exempt['Taxability Type']).toBe('Exempt');
    expect(unclassified.Taxable).toBe('');
    expect(unclassified['Taxability Type']).toBe('');
  });

  it('always writes "Sales and Purchases" for Item Type — a usage-scope column, not goods/service (see Product Type below)', () => {
    const [row] = mapper.toItemRows([item({ name: 'Anything' })]);
    expect(row['Item Type']).toBe('Sales and Purchases');
  });

  it('reads Product Type (goods/service) from GSTTYPEOFSUPPLY, defaulting to goods when unclassified', () => {
    const [goods] = mapper.toItemRows([item({ name: 'A Widget', itemType: 'goods' })]);
    const [service] = mapper.toItemRows([item({ name: 'A Subscription', itemType: 'service' })]);
    const [unclassified] = mapper.toItemRows([item({ name: 'Unclassified', itemType: null })]);
    expect(goods['Product Type']).toBe('goods');
    expect(service['Product Type']).toBe('service');
    expect(unclassified['Product Type']).toBe('goods');
  });

  it('maps Account/Purchase Account/Inventory Valuation Method from the item master (2026-09-12 field-mapping pass)', () => {
    const [row] = mapper.toItemRows([
      item({
        name: 'Widget A',
        salesAccount: 'Sales Account',
        purchaseAccount: 'Purchase Account',
        inventoryValuationMethod: 'Avg. Cost',
      }),
    ]);
    expect(row.Account).toBe('Sales Account');
    expect(row['Purchase Account']).toBe('Purchase Account');
    expect(row['Inventory Valuation Method']).toBe('Avg. Cost');
  });

  it('leaves Account/Purchase Account blank rather than guessing when the item has no default ledger configured', () => {
    const [row] = mapper.toItemRows([item({ name: 'Widget A' })]);
    expect(row.Account).toBe('');
    expect(row['Purchase Account']).toBe('');
  });

  it('derives both Intra and Inter State tax name/rate/type from a single GST rate, matching the real template convention', () => {
    const [row] = mapper.toItemRows([
      item({ name: 'Harpic', alias: 'HRP-1', hsnCode: '34022090', gstRate: 12 }),
    ]);
    expect(row['Alias Name']).toBe('HRP-1');
    expect(row.SKU).toBe('HRP-1');
    expect(row['HSN/SAC']).toBe('34022090');
    expect(row['Intra State Tax Name']).toBe('GST12');
    expect(row['Intra State Tax Rate']).toBe(12);
    expect(row['Intra State Tax Type']).toBe('Group');
    expect(row['Inter State Tax Name']).toBe('IGST12');
    expect(row['Inter State Tax Rate']).toBe(12);
    expect(row['Inter State Tax Type']).toBe('Group');
  });
});
