import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { VendorMapper } from './vendor.mapper';

describe('VendorMapper', () => {
  const hierarchy = new GroupHierarchyResolver([]);
  const mapper = new VendorMapper(hierarchy);

  const baseLedger = {
    name: 'Reliable Supplies Co',
    parent: 'Sundry Creditors',
    description: null,
    openingBalance: null,
    closingBalance: null,
    alterId: 1,
    reservedName: null,
    gstin: null,
    panNumber: null,
    email: null,
    phone: null,
    mobile: null,
    billingAddress: null,
    billingState: null,
    billingCountry: null,
    billingPincode: null,
    bankName: null,
    bankAccountNumber: null,
  };

  it('includes only ledgers resolving to Sundry Creditors', () => {
    const rows = mapper.toVendorRows([
      baseLedger,
      { ...baseLedger, name: 'ABC Traders', parent: 'Sundry Debtors' },
      { ...baseLedger, name: 'Cash', parent: 'Cash-in-Hand' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Display Name']).toBe('Reliable Supplies Co');
  });

  it('maps bank details, unlike CustomerMapper which has no such columns to fill', () => {
    const [row] = mapper.toVendorRows([
      { ...baseLedger, bankName: 'HDFC Bank', bankAccountNumber: '000123456789' },
    ]);
    expect(row['Bank Name']).toBe('HDFC Bank');
    expect(row['Bank Account Number']).toBe('000123456789');
  });

  it('derives GST Treatment from GSTIN presence, same as CustomerMapper', () => {
    const [withGstin] = mapper.toVendorRows([{ ...baseLedger, gstin: '33AAAAA1111A1Z1' }]);
    const [withoutGstin] = mapper.toVendorRows([baseLedger]);
    expect(withGstin['GST Treatment']).toBe('business_gst');
    expect(withoutGstin['GST Treatment']).toBe('consumer');
  });

  it('takes the Opening Balance magnitude regardless of Tally Dr/Cr sign', () => {
    const [row] = mapper.toVendorRows([{ ...baseLedger, openingBalance: 2500 }]);
    expect(row['Opening Balance']).toBe(2500);
  });
});
