import { CustomerMapper } from './customer.mapper';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';

describe('CustomerMapper', () => {
  const hierarchy = new GroupHierarchyResolver([]);
  const mapper = new CustomerMapper(hierarchy);

  const baseLedger = {
    name: 'ABC Traders',
    parent: 'Sundry Debtors',
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
    ifscCode: null,
    accountHolderName: null,
    website: null,
    creditLimit: null,
    contactPersonName: null,
    mailingName: null,
    creditPeriod: null,
  };

  it('includes only ledgers resolving to Sundry Debtors', () => {
    const rows = mapper.toCustomerRows([
      baseLedger,
      { ...baseLedger, name: 'XYZ Supplies', parent: 'Sundry Creditors' },
      { ...baseLedger, name: 'Cash', parent: 'Cash-in-Hand' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Display Name']).toBe('ABC Traders');
  });

  it('maps GSTIN/PAN/contact/address fields straight through and derives GST Treatment from GSTIN presence', () => {
    const [row] = mapper.toCustomerRows([
      {
        ...baseLedger,
        gstin: '33AAAAA1111A1Z1',
        panNumber: 'AAAAA1111A',
        email: 'ap@abctraders.com',
        phone: '044-12345678',
        mobile: '9876543210',
        billingAddress: '50 Kovil Street\nAnna Nagar',
        billingState: 'Tamil Nadu',
        billingCountry: 'India',
        billingPincode: '600040',
      },
    ]);

    expect(row['GST Identification Number (GSTIN)']).toBe('33AAAAA1111A1Z1');
    expect(row['GST Treatment']).toBe('business_gst');
    expect(row['PAN Number']).toBe('AAAAA1111A');
    expect(row.EmailID).toBe('ap@abctraders.com');
    expect(row.Phone).toBe('044-12345678');
    expect(row.MobilePhone).toBe('9876543210');
    // Tally's multi-line ADDRESS.LIST splits across two Zoho columns instead
    // of cramming everything into one — see splitBillingAddress's doc
    // comment.
    expect(row['Billing Address']).toBe('50 Kovil Street');
    expect(row['Billing Street2']).toBe('Anna Nagar');
    expect(row['Billing State']).toBe('Tamil Nadu');
    expect(row['Billing Country']).toBe('India');
    expect(row['Billing Code']).toBe('600040');
  });

  it('maps ledger.description onto Notes — Customer.xlsx has no Description column of its own', () => {
    const [row] = mapper.toCustomerRows([
      { ...baseLedger, description: 'Key retail account, net-30 terms' },
    ]);
    expect(row.Notes).toBe('Key retail account, net-30 terms');
  });

  it('leaves Billing Street2 blank for a single-line address rather than fabricating a split', () => {
    const [row] = mapper.toCustomerRows([{ ...baseLedger, billingAddress: '50 Kovil Street' }]);
    expect(row['Billing Address']).toBe('50 Kovil Street');
    expect(row['Billing Street2']).toBe('');
  });

  it('falls back to GST Treatment "consumer" when there is no GSTIN', () => {
    const [row] = mapper.toCustomerRows([baseLedger]);
    expect(row['GST Treatment']).toBe('consumer');
  });

  it('derives GST Treatment from the real GSTREGISTRATIONTYPE, not GSTIN presence alone — an unregistered BUSINESS is "business_none", not the "consumer" (retail individual) the old GSTIN-only heuristic produced', () => {
    const [row] = mapper.toCustomerRows([
      { ...baseLedger, gstRegistrationType: 'Unregistered/Consumer' },
    ]);
    expect(row['GST Treatment']).toBe('business_none');
  });

  it('falls back to "consumer" for a Tally "Unknown" registration type, matching Zoho\'s own tool\'s catch-all', () => {
    const [row] = mapper.toCustomerRows([{ ...baseLedger, gstRegistrationType: 'Unknown' }]);
    expect(row['GST Treatment']).toBe('consumer');
  });

  it('maps Place Of Contact/Billing Attention/Payment Terms/Contact First Name (2026-09-10 field-mapping pass)', () => {
    const [row] = mapper.toCustomerRows([
      {
        ...baseLedger,
        gstPlaceOfSupply: 'Uttar Pradesh',
        mailingName: 'ABC Traders (Head Office)',
        creditPeriod: '30',
        contactPersonName: 'RR Patil',
      },
    ]);
    expect(row['Place Of Contact']).toBe('Uttar Pradesh');
    expect(row['Billing Attention']).toBe('ABC Traders (Head Office)');
    expect(row['Payment Terms']).toBe(30);
    expect(row['Payment Terms Label']).toBe('30 Days');
    expect(row['Contact First Name']).toBe('RR Patil');
  });

  it('leaves Place Of Contact/Billing Attention/Payment Terms/Contact First Name blank rather than guessing when the ledger has none', () => {
    const [row] = mapper.toCustomerRows([baseLedger]);
    expect(row['Place Of Contact']).toBe('');
    expect(row['Billing Attention']).toBe('');
    expect(row['Payment Terms']).toBe('');
    expect(row['Payment Terms Label']).toBe('');
    expect(row['Contact First Name']).toBe('');
  });

  it('leaves Payment Terms blank for a credit period not in Tally\'s "Days" format, matching this project\'s documented limitation', () => {
    const [row] = mapper.toCustomerRows([{ ...baseLedger, creditPeriod: 'Advance' }]);
    expect(row['Payment Terms']).toBe('');
    expect(row['Payment Terms Label']).toBe('');
  });

  it('takes the Opening Balance magnitude regardless of Tally Dr/Cr sign, with no separate Dr/Cr column', () => {
    const [row] = mapper.toCustomerRows([{ ...baseLedger, openingBalance: -1500 }]);
    expect(row['Opening Balance']).toBe(1500);
    expect(row).not.toHaveProperty('Debit or Credit');
  });

  it('leaves Opening Balance blank rather than 0 when Tally has no balance at all', () => {
    const [row] = mapper.toCustomerRows([baseLedger]);
    expect(row['Opening Balance']).toBe('');
  });

  it('maps Website/Credit Limit/Conact Display Name (2026-09-05 field-mapping pass)', () => {
    const [row] = mapper.toCustomerRows([
      { ...baseLedger, website: 'ssss123.com', creditLimit: 36000, contactPersonName: 'RR Patil' },
    ]);
    expect(row.Website).toBe('ssss123.com');
    expect(row['Credit Limit']).toBe(36000);
    expect(row['Conact Display Name']).toBe('RR Patil');
  });

  it('leaves Website/Credit Limit/Conact Display Name blank rather than guessing when the ledger has none', () => {
    const [row] = mapper.toCustomerRows([baseLedger]);
    expect(row.Website).toBe('');
    expect(row['Credit Limit']).toBe('');
    expect(row['Conact Display Name']).toBe('');
  });

  it("maps Customer Number from the ledger's AlterID (2026-10-20 reviewer feedback)", () => {
    const [row] = mapper.toCustomerRows([{ ...baseLedger, alterId: 42 }]);
    expect(row['Customer Number']).toBe(42);
  });

  it('leaves Customer Number blank rather than 0 when Tally has no AlterID at all', () => {
    const [row] = mapper.toCustomerRows([{ ...baseLedger, alterId: null }]);
    expect(row['Customer Number']).toBe('');
  });
});
