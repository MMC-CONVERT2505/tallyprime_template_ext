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
    gstRegistrationType: null,
    gstPlaceOfSupply: null,
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
    website: null,
    creditLimit: null,
    contactPersonName: null,
    mailingName: null,
    creditPeriod: null,
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

  it('derives GST Treatment from the real GSTREGISTRATIONTYPE, not GSTIN presence alone, same fix as CustomerMapper', () => {
    const [row] = mapper.toVendorRows([
      { ...baseLedger, gstRegistrationType: 'Unregistered/Consumer' },
    ]);
    expect(row['GST Treatment']).toBe('business_none');
  });

  it('maps Source Of Supply/Billing Attention/Payment Terms/Contact First Name (2026-09-10 field-mapping pass)', () => {
    const [row] = mapper.toVendorRows([
      {
        ...baseLedger,
        gstPlaceOfSupply: 'Uttar Pradesh',
        mailingName: 'Reliable Supplies Co (Warehouse)',
        creditPeriod: '20 Days',
        contactPersonName: 'Sachin',
      },
    ]);
    expect(row['Source Of Supply']).toBe('Uttar Pradesh');
    expect(row['Billing Attention']).toBe('Reliable Supplies Co (Warehouse)');
    expect(row['Payment Terms']).toBe(20);
    expect(row['Payment Terms Label']).toBe('20 Days');
    expect(row['Contact First Name']).toBe('Sachin');
  });

  it('leaves Source Of Supply/Billing Attention/Payment Terms/Contact First Name blank rather than guessing when the ledger has none', () => {
    const [row] = mapper.toVendorRows([baseLedger]);
    expect(row['Source Of Supply']).toBe('');
    expect(row['Billing Attention']).toBe('');
    expect(row['Payment Terms']).toBe('');
    expect(row['Contact First Name']).toBe('');
  });

  it('takes the Opening Balance magnitude regardless of Tally Dr/Cr sign', () => {
    const [row] = mapper.toVendorRows([{ ...baseLedger, openingBalance: 2500 }]);
    expect(row['Opening Balance']).toBe(2500);
  });

  it('maps ledger.description onto Notes and splits a multi-line billing address across Billing Address/Street2', () => {
    const [row] = mapper.toVendorRows([
      {
        ...baseLedger,
        description: 'Preferred hardware supplier',
        billingAddress: 'Plot 12, Industrial Area\nPhase 2',
      },
    ]);
    expect(row.Notes).toBe('Preferred hardware supplier');
    expect(row['Billing Address']).toBe('Plot 12, Industrial Area');
    expect(row['Billing Street2']).toBe('Phase 2');
  });

  it('maps Website/Conact Display Name — Vendor.xlsx has no Credit Limit column (2026-09-05 field-mapping pass)', () => {
    const [row] = mapper.toVendorRows([
      { ...baseLedger, website: 'ssss123.com', contactPersonName: 'RR Patil' },
    ]);
    expect(row.Website).toBe('ssss123.com');
    expect(row['Conact Display Name']).toBe('RR Patil');
    expect(row).not.toHaveProperty('Credit Limit');
  });

  it('leaves Website/Conact Display Name blank rather than guessing when the ledger has none', () => {
    const [row] = mapper.toVendorRows([baseLedger]);
    expect(row.Website).toBe('');
    expect(row['Conact Display Name']).toBe('');
  });
});
